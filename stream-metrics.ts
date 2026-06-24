/**
 * Live TPS, session-average TPS, and average TTFT tracking.
 * Ported from https://github.com/Tarquinen/oc-tps (OpenCode TUI plugin).
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export type StreamSample = {
  at: number;
  tokens: number;
};

const STREAM_WINDOW_MS = 5_000;
const LIVE_STALE_MS = 1_500;
const SINGLE_SAMPLE_MS = 1_000;

type MessageTiming = {
  requestStartAt: number;
  firstResponseAt?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  lastToolCallAt?: number;
};

type SessionAverage = {
  totalTokens: number;
  totalDurationMs: number;
  totalTtftMs: number;
  messageCount: number;
  ttftMessageCount: number;
};

export type StreamMetricsSnapshot = {
  liveTps?: number;
  sessionAvgTps?: number;
  sessionAvgTtftSec?: number;
  /** Seconds from request start until first stream activity (while agent is running). */
  liveTtftSec?: number;
};

type StreamMetricsState = {
  streamSamples: StreamSample[];
  messageTimingByKey: Map<string, MessageTiming>;
  sessionAverage: SessionAverage;
  /** Stable id for the in-flight assistant reply (set at agent_start). */
  activeMessageKey: string | null;
  activeRequestStartAt: number | null;
  pruneTimer: ReturnType<typeof setInterval> | null;
  version: number;
};

export function estimateStreamTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5));
}

export function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 100) return `${Math.round(value)}`;
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function formatTtftSeconds(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return `${value.toFixed(1)}s`;
}

/** Single-line display matching oc-tps: TPS live | AVG session | TTFT session */
export function formatStreamMetricsLine(snapshot: StreamMetricsSnapshot, isStreaming: boolean): string {
  const live = isStreaming && snapshot.liveTps !== undefined ? formatRate(snapshot.liveTps) : undefined;
  const avg = snapshot.sessionAvgTps !== undefined ? formatRate(snapshot.sessionAvgTps) : undefined;
  const ttftLive = snapshot.liveTtftSec !== undefined ? formatTtftSeconds(snapshot.liveTtftSec) : undefined;
  const ttftAvg = snapshot.sessionAvgTtftSec !== undefined ? formatTtftSeconds(snapshot.sessionAvgTtftSec) : undefined;
  const ttft = isStreaming && ttftLive ? ttftLive : ttftAvg;
  return `TPS ${live ?? "-"} | AVG ${avg ?? "-"} | TTFT ${ttft ?? "-"}`;
}

export function activeDurationMs(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0;
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS;
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS);
  }

  let duration = 0;
  for (let i = 1; i < samples.length; i++) {
    duration += Math.max(0, samples[i].at - samples[i - 1].at);
  }

  if (tailAt) {
    duration += Math.max(0, tailAt - samples[samples.length - 1].at);
  }

  return Math.max(duration, SINGLE_SAMPLE_MS);
}

function pruneSamples(state: StreamMetricsState, now = Date.now()) {
  const next = state.streamSamples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
  if (next.length !== state.streamSamples.length) {
    state.streamSamples = next;
    state.version++;
  }
}

function clearLiveSamples(state: StreamMetricsState) {
  if (state.streamSamples.length === 0) return;
  state.streamSamples = [];
  state.version++;
}

function appendSample(state: StreamMetricsState, messageKey: string, sample: StreamSample) {
  const now = sample.at;
  pruneSamples(state, now);
  state.streamSamples = [...state.streamSamples, sample];

  const timing = state.messageTimingByKey.get(messageKey);
  if (timing) {
    if (timing.firstTokenAt) {
      timing.lastTokenAt = now;
    } else {
      timing.firstResponseAt = timing.firstResponseAt ?? now;
      timing.firstTokenAt = now;
      timing.lastTokenAt = now;
    }
    state.messageTimingByKey.set(messageKey, timing);
  }
  state.version++;
}

function computeLiveTps(state: StreamMetricsState, isStreaming: boolean, now = Date.now()): number | undefined {
  if (!isStreaming) return undefined;
  const samples = state.streamSamples;
  if (samples.length === 0) return undefined;

  const relevant = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
  if (relevant.length === 0) return undefined;

  const lastSample = relevant[relevant.length - 1];
  if (!lastSample || now - lastSample.at > LIVE_STALE_MS) return undefined;

  const total = relevant.reduce((sum, sample) => sum + sample.tokens, 0);
  const durationSeconds = activeDurationMs(relevant, now) / 1000;
  if (durationSeconds <= 0) return undefined;
  return total / durationSeconds;
}

function computeSessionAvgTps(state: StreamMetricsState): number | undefined {
  const totals = state.sessionAverage;
  if (totals.totalTokens <= 0 || totals.totalDurationMs <= 0) return undefined;
  return totals.totalTokens / (totals.totalDurationMs / 1000);
}

function computeSessionAvgTtftSec(state: StreamMetricsState): number | undefined {
  const totals = state.sessionAverage;
  if (totals.ttftMessageCount <= 0 || totals.totalTtftMs < 0) return undefined;
  return totals.totalTtftMs / totals.ttftMessageCount / 1000;
}

function computeLiveTtftSec(state: StreamMetricsState, isStreaming: boolean, now = Date.now()): number | undefined {
  if (!isStreaming || state.activeRequestStartAt === null || !state.activeMessageKey) return undefined;
  const timing = state.messageTimingByKey.get(state.activeMessageKey);
  if (!timing) return undefined;
  const firstAt = timing.firstTokenAt ?? timing.firstResponseAt;
  if (firstAt !== undefined) return Math.max(0, (firstAt - timing.requestStartAt) / 1000);
  return Math.max(0, (now - timing.requestStartAt) / 1000);
}

export function getStreamMetricsSnapshot(
  state: StreamMetricsState,
  isStreaming: boolean,
  now = Date.now(),
): StreamMetricsSnapshot {
  pruneSamples(state, now);
  return {
    liveTps: computeLiveTps(state, isStreaming, now),
    sessionAvgTps: computeSessionAvgTps(state),
    sessionAvgTtftSec: computeSessionAvgTtftSec(state),
    liveTtftSec: computeLiveTtftSec(state, isStreaming, now),
  };
}

export function createStreamMetricsTracker(): {
  state: StreamMetricsState;
  resetSession: () => void;
  onAgentStart: (requestStartAt: number) => void;
  onMessageStart: (messageKey: string, requestStartAt: number) => void;
  onMessageUpdate: (messageKey: string, streamEvent: AssistantMessageEvent | undefined) => void;
  ensureMessageTiming: (messageKey: string, requestStartAt: number) => void;
  onMessageEnd: (messageKey: string, message: {
    timestamp: number;
    stopReason: string;
    usage: { output: number; cacheRead?: number };
    content: unknown;
  }) => void;
  onToolExecutionStart: () => void;
  dispose: () => void;
  getSnapshot: (isStreaming: boolean) => StreamMetricsSnapshot;
  bumpVersion: () => number;
} {
  const state: StreamMetricsState = {
    streamSamples: [],
    messageTimingByKey: new Map(),
    sessionAverage: { totalTokens: 0, totalDurationMs: 0, totalTtftMs: 0, messageCount: 0, ttftMessageCount: 0 },
    activeMessageKey: null,
    activeRequestStartAt: null,
    pruneTimer: null,
    version: 0,
  };

  state.pruneTimer = setInterval(() => {
    pruneSamples(state);
  }, 1000);

  const resetSession = () => {
    state.streamSamples = [];
    state.messageTimingByKey.clear();
    state.sessionAverage = { totalTokens: 0, totalDurationMs: 0, totalTtftMs: 0, messageCount: 0, ttftMessageCount: 0 };
    state.activeMessageKey = null;
    state.activeRequestStartAt = null;
    state.version++;
  };

  const onAgentStart = (requestStartAt: number) => {
    clearLiveSamples(state);
    const turnKey = `turn:${requestStartAt}`;
    state.activeMessageKey = turnKey;
    state.activeRequestStartAt = requestStartAt;
    state.messageTimingByKey.set(turnKey, { requestStartAt });
    state.version++;
  };

  const resolveMessageKey = (messageKey: string) => state.activeMessageKey ?? messageKey;

  const onMessageStart = (messageKey: string, requestStartAt: number) => {
    if (!state.activeMessageKey) {
      onAgentStart(requestStartAt);
    }
    const key = state.activeMessageKey!;
    const timing = state.messageTimingByKey.get(key);
    if (timing && timing.requestStartAt > requestStartAt) {
      timing.requestStartAt = requestStartAt;
      state.messageTimingByKey.set(key, timing);
      state.activeRequestStartAt = requestStartAt;
      state.version++;
    }
  };

  const ensureMessageTiming = (messageKey: string, requestStartAt: number) => {
    if (!state.activeMessageKey) {
      onAgentStart(requestStartAt);
      return;
    }
    const key = state.activeMessageKey;
    const timing = state.messageTimingByKey.get(key);
    if (timing && timing.requestStartAt > requestStartAt) {
      timing.requestStartAt = requestStartAt;
      state.messageTimingByKey.set(key, timing);
      state.activeRequestStartAt = requestStartAt;
      state.version++;
    }
  };

  const onMessageUpdate = (messageKey: string, streamEvent: AssistantMessageEvent | undefined) => {
    const key = resolveMessageKey(messageKey);
    if (!streamEvent) return;

    if (streamEvent.type === "start") {
      const timing = state.messageTimingByKey.get(key);
      if (timing && timing.firstResponseAt === undefined) {
        timing.firstResponseAt = Date.now();
        state.messageTimingByKey.set(key, timing);
        state.version++;
      }
      return;
    }

    if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
      const delta = streamEvent.delta;
      if (typeof delta !== "string" || delta.length === 0) return;
      appendSample(state, key, {
        at: Date.now(),
        tokens: estimateStreamTokens(delta),
      });
      return;
    }

    if (streamEvent.type === "toolcall_start") {
      clearLiveSamples(state);
      const timing = state.messageTimingByKey.get(key);
      if (timing) {
        timing.lastToolCallAt = Date.now();
        if (timing.firstResponseAt === undefined) {
          timing.firstResponseAt = Date.now();
        }
        state.messageTimingByKey.set(key, timing);
        state.version++;
      }
    }
  };

  const countOutputTokens = (message: {
    usage: { output: number };
    content: unknown;
  }) => {
    let thinkingChars = 0;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block === "object" && block !== null && (block as { type?: string }).type === "thinking") {
          const thinking = (block as { thinking?: string }).thinking;
          if (typeof thinking === "string") {
            thinkingChars += thinking.length;
          }
        }
      }
    }
    const reasoningEstimate = Math.max(0, Math.ceil(thinkingChars / 5));
    return message.usage.output + reasoningEstimate;
  };

  const onMessageEnd = (
    messageKey: string,
    message: {
      timestamp: number;
      stopReason: string;
      usage: { output: number };
      content: unknown;
    },
  ) => {
    const key = resolveMessageKey(messageKey);
    const timing = state.messageTimingByKey.get(key);
    const okStop = message.stopReason !== "error" && message.stopReason !== "aborted";

    if (timing && okStop) {
      const firstResponseAt = timing.firstResponseAt
        ?? timing.firstTokenAt
        ?? (timing.lastToolCallAt !== undefined ? timing.lastToolCallAt : undefined)
        ?? (typeof message.timestamp === "number" && message.timestamp > timing.requestStartAt
          ? message.timestamp
          : Date.now());

      const totalTokens = countOutputTokens(message);
      const endAt = message.stopReason === "toolUse" && timing.lastToolCallAt
        ? timing.lastToolCallAt
        : (typeof message.timestamp === "number" ? message.timestamp : Date.now());
      const durationMs = Math.max(endAt - firstResponseAt, 1);
      const ttftMs = Math.max(firstResponseAt - timing.requestStartAt, 0);

      const next = { ...state.sessionAverage };
      next.totalTtftMs += ttftMs;
      next.ttftMessageCount += 1;

      if (totalTokens > 0) {
        next.totalTokens += totalTokens;
        next.totalDurationMs += durationMs;
        next.messageCount += 1;
      }
      state.sessionAverage = next;
    }

    state.messageTimingByKey.delete(key);
    if (state.activeMessageKey === key) {
      state.activeMessageKey = null;
      state.activeRequestStartAt = null;
    }
    pruneSamples(state, message.timestamp);
    clearLiveSamples(state);
    state.version++;
  };

  const onToolExecutionStart = () => {
    clearLiveSamples(state);
  };

  const dispose = () => {
    if (state.pruneTimer) {
      clearInterval(state.pruneTimer);
      state.pruneTimer = null;
    }
  };

  return {
    state,
    resetSession,
    onAgentStart,
    onMessageStart,
    onMessageUpdate,
    ensureMessageTiming,
    onMessageEnd,
    onToolExecutionStart,
    dispose,
    getSnapshot: (isStreaming: boolean) => getStreamMetricsSnapshot(state, isStreaming),
    bumpVersion: () => state.version,
  };
}

export function assistantMessageStreamKey(message: {
  responseId?: string;
  timestamp: number;
  model: string;
}): string {
  if (message.responseId) {
    return message.responseId;
  }
  return `${message.model}:${message.timestamp}`;
}