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
  assert.equal(formatStreamMetricsLine({}, false), "TPS - | AVG - | TTFT -");
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