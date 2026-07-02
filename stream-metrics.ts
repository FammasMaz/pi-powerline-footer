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
/** Number of recent completed messages used for the rolling-median averages. */
const ROLLING_WINDOW = 10;

type MessageTiming = {
  requestStartAt: number;
  firstResponseAt?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  lastToolCallAt?: number;
};

type SessionAverage = {
  /** Per-message TPS (tokens/sec) for the most recent completed messages. */
  recentTps: number[];
  /** Per-message TTFT (seconds) for the most recent completed messages. */
  recentTtftSec: number[];
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

/** Format a labelled metric as `LABEL primary (avg)`, falling back gracefully. */
function formatWithAvg(label: string, primary: string | undefined, avg: string | undefined): string {
  if (primary && avg) return `${label} ${primary} (${avg})`;
  if (primary) return `${label} ${primary}`;
  if (avg) return `${label} ${avg}`;
  return `${label} -`;
}

/** Single-line display: `TPS live (avg) | TTFT live (avg)` — avg shown in brackets. */
export function formatStreamMetricsLine(snapshot: StreamMetricsSnapshot, isStreaming: boolean): string {
  const live = isStreaming && snapshot.liveTps !== undefined ? formatRate(snapshot.liveTps) : undefined;
  const avg = snapshot.sessionAvgTps !== undefined ? formatRate(snapshot.sessionAvgTps) : undefined;
  const ttftLive = isStreaming && snapshot.liveTtftSec !== undefined ? formatTtftSeconds(snapshot.liveTtftSec) : undefined;
  const ttftAvg = snapshot.sessionAvgTtftSec !== undefined ? formatTtftSeconds(snapshot.sessionAvgTtftSec) : undefined;
  return `${formatWithAvg("TPS", live, avg)} | ${formatWithAvg("TTFT", ttftLive, ttftAvg)}`;
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

/** Median of a list of numbers; undefined when empty. Robust to outliers. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeSessionAvgTps(state: StreamMetricsState): number | undefined {
  return median(state.sessionAverage.recentTps);
}

function computeSessionAvgTtftSec(state: StreamMetricsState): number | undefined {
  return median(state.sessionAverage.recentTtftSec);
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
    sessionAverage: { recentTps: [], recentTtftSec: [] },
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
    state.sessionAverage = { recentTps: [], recentTtftSec: [] };
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
      // For toolUse messages, end the window at the last tool-call START so the
      // model's generation of tool args is counted, but the tool EXECUTION time
      // that follows is never folded into the duration (it would deflate TPS).
      // Tool results are never counted as tokens: usage.output only holds the
      // model's own completion tokens, and live samples come exclusively from
      // text_delta / thinking_delta (cleared on toolcall_start + tool execution).
      const endAt = message.stopReason === "toolUse" && timing.lastToolCallAt
        ? timing.lastToolCallAt
        : (typeof message.timestamp === "number" ? message.timestamp : Date.now());
      const durationMs = Math.max(endAt - firstResponseAt, 1);
      const ttftMs = Math.max(firstResponseAt - timing.requestStartAt, 0);

      // Rolling-median window: TTFT is recorded for every completed message
      // (even with 0 output tokens); TPS only when the model produced tokens.
      const recentTtftSec = [...state.sessionAverage.recentTtftSec, ttftMs / 1000].slice(-ROLLING_WINDOW);
      const recentTps = totalTokens > 0
        ? [...state.sessionAverage.recentTps, totalTokens / (durationMs / 1000)].slice(-ROLLING_WINDOW)
        : state.sessionAverage.recentTps;
      state.sessionAverage = { recentTps, recentTtftSec };
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