import test from "node:test";
import assert from "node:assert/strict";
import {
  activeDurationMs,
  estimateStreamTokens,
  formatRate,
  formatTtftSeconds,
  formatStreamMetricsLine,
  createStreamMetricsTracker,
} from "../stream-metrics.ts";

test("estimateStreamTokens uses byte length heuristic", () => {
  assert.equal(estimateStreamTokens(""), 1);
  assert.equal(estimateStreamTokens("hello"), 1);
  assert.ok(estimateStreamTokens("a".repeat(20)) >= 4);
});

test("formatStreamMetricsLine shows placeholders when empty", () => {
  assert.equal(formatStreamMetricsLine({}, false), "TPS - | TTFT -");
});

test("formatStreamMetricsLine shows avg in brackets next to live", () => {
  const line = formatStreamMetricsLine({ liveTps: 42.3, sessionAvgTps: 35.1, liveTtftSec: 1.2, sessionAvgTtftSec: 1.5 }, true);
  assert.equal(line, "TPS 42.3 (35.1) | TTFT 1.2s (1.5s)");
});

test("session average is the rolling median of recent messages", () => {
  const realNow = Date.now;
  let t = 0;
  Date.now = () => t;
  let tracker: ReturnType<typeof createStreamMetricsTracker> | undefined;
  try {
    tracker = createStreamMetricsTracker();
    const msgTps = [10, 100, 1000]; // median should be 100
    for (let i = 0; i < msgTps.length; i++) {
      tracker.onAgentStart(t);
      t += 100;
      tracker.onMessageUpdate(`m${i}`, { type: "start", partial: {} as never });
      t += 1000; // 1s generation -> tps == output tokens
      tracker.onMessageEnd(`m${i}`, {
        timestamp: t,
        stopReason: "stop",
        usage: { output: msgTps[i] },
        content: [{ type: "text", text: "x" }],
      });
      t += 100;
    }
    const snap = tracker.getSnapshot(false);
    assert.equal(snap.sessionAvgTps, 100);
  } finally {
    tracker?.dispose();
    Date.now = realNow;
  }
});

test("rolling window caps at the last 10 messages", () => {
  const realNow = Date.now;
  let t = 0;
  Date.now = () => t;
  let tracker: ReturnType<typeof createStreamMetricsTracker> | undefined;
  try {
    tracker = createStreamMetricsTracker();
    // tps 1..12; window keeps last 10 -> [3,4,5,6,7,8,9,10,11,12], median = (7+8)/2 = 7.5
    for (let i = 1; i <= 12; i++) {
      tracker.onAgentStart(t);
      t += 100;
      tracker.onMessageUpdate(`m${i}`, { type: "start", partial: {} as never });
      t += 1000;
      tracker.onMessageEnd(`m${i}`, {
        timestamp: t,
        stopReason: "stop",
        usage: { output: i },
        content: [{ type: "text", text: "x" }],
      });
      t += 100;
    }
    const snap = tracker.getSnapshot(false);
    assert.equal(snap.sessionAvgTps, 7.5);
  } finally {
    tracker?.dispose();
    Date.now = realNow;
  }
});

test("tool execution time is excluded from session-average TPS", () => {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  let tracker: ReturnType<typeof createStreamMetricsTracker> | undefined;
  try {
    tracker = createStreamMetricsTracker();
    // msg1: generation 1100..2000, ends with a tool call (lastToolCallAt = 2000)
    tracker.onAgentStart(1000);
    t = 1100;
    tracker.onMessageUpdate("m1", { type: "start", partial: {} as never });
    t = 1500;
    tracker.onMessageUpdate("m1", { type: "text_delta", contentIndex: 0, delta: "hello world", partial: {} as never });
    t = 2000;
    tracker.onMessageUpdate("m1", { type: "toolcall_start", partial: {} as never });
    tracker.onMessageEnd("m1", {
      timestamp: 2000,
      stopReason: "toolUse",
      usage: { output: 100 },
      content: [{ type: "text", text: "hello world" }],
    });
    // Tool executes from 2000 -> 9000 (7s). This gap must NOT be counted.
    t = 9000;
    tracker.onToolExecutionStart();
    // msg2: generation 9050..9100
    tracker.onMessageStart("m2", 9000);
    t = 9050;
    tracker.onMessageUpdate("m2", { type: "start", partial: {} as never });
    t = 9100;
    tracker.onMessageUpdate("m2", { type: "text_delta", contentIndex: 0, delta: "done", partial: {} as never });
    tracker.onMessageEnd("m2", {
      timestamp: 9100,
      stopReason: "stop",
      usage: { output: 100 },
      content: [{ type: "text", text: "done" }],
    });

    const snap = tracker.getSnapshot(false);
    // msg1 tps = 100/0.9 ~= 111, msg2 tps = 100/0.05 = 2000. Median >> 100.
    // If the 7s tool gap leaked in, the average would collapse to ~22.
    assert.ok(snap.sessionAvgTps !== undefined && snap.sessionAvgTps > 100, `got ${snap.sessionAvgTps}`);
  } finally {
    tracker?.dispose();
    Date.now = realNow;
  }
});

test("TTFT updates session average even with zero output tokens", () => {
  const tracker = createStreamMetricsTracker();
  tracker.onAgentStart(Date.now() - 2000);
  tracker.onMessageUpdate("x", { type: "start", partial: {} as never });
  tracker.onMessageEnd("x", {
    timestamp: Date.now(),
    stopReason: "toolUse",
    usage: { output: 0 },
    content: [],
  });
  const snap = tracker.getSnapshot(false);
  assert.ok(snap.sessionAvgTtftSec !== undefined && snap.sessionAvgTtftSec >= 0);
  tracker.dispose();
});

test("formatRate and formatTtftSeconds", () => {
  assert.equal(formatRate(0), undefined);
  assert.equal(formatRate(123.4), "123");
  assert.equal(formatRate(12.34), "12.3");
  assert.equal(formatRate(1.23), "1.23");
  assert.equal(formatTtftSeconds(2.456), "2.5s");
});

test("activeDurationMs single sample uses bounded window", () => {
  const samples = [{ at: 1000, tokens: 10 }];
  const d = activeDurationMs(samples, 1500);
  assert.ok(d >= 250 && d <= 1000);
});

test("tracker records session average after assistant message ends", () => {
  const tracker = createStreamMetricsTracker();
  const key = "msg-1";
  const requestStart = Date.now() - 5000;

  tracker.onAgentStart(requestStart);
  tracker.onMessageUpdate(key, { type: "start", partial: {} as never });
  tracker.onMessageUpdate(key, {
    type: "text_delta",
    contentIndex: 0,
    delta: "hello world",
    partial: {} as never,
  });

  tracker.onMessageEnd(key, {
    timestamp: Date.now(),
    stopReason: "stop",
    usage: { output: 42 },
    content: [{ type: "text", text: "hello world" }],
  });

  const snap = tracker.getSnapshot(false);
  assert.ok(snap.sessionAvgTps !== undefined && snap.sessionAvgTps > 0);
  assert.ok(snap.sessionAvgTtftSec !== undefined && snap.sessionAvgTtftSec >= 0);

  tracker.dispose();
});

test("live TPS only while streaming with recent samples", () => {
  const tracker = createStreamMetricsTracker();
  const key = "live-1";
  tracker.onAgentStart(Date.now());
  tracker.onMessageUpdate(key, {
    type: "text_delta",
    contentIndex: 0,
    delta: "stream ",
    partial: {} as never,
  });

  const streaming = tracker.getSnapshot(true);
  assert.ok(streaming.liveTps !== undefined);

  const idle = tracker.getSnapshot(false);
  assert.equal(idle.liveTps, undefined);

  tracker.dispose();
});

test("resetSession clears averages", () => {
  const tracker = createStreamMetricsTracker();
  const key = "r1";
  tracker.onAgentStart(Date.now() - 1000);
  tracker.onMessageUpdate(key, { type: "start", partial: {} as never });
  tracker.onMessageEnd(key, {
    timestamp: Date.now(),
    stopReason: "stop",
    usage: { output: 10 },
    content: [],
  });

  tracker.resetSession();
  const snap = tracker.getSnapshot(false);
  assert.equal(snap.sessionAvgTps, undefined);
  assert.equal(snap.sessionAvgTtftSec, undefined);

  tracker.dispose();
});