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
};

export type StreamMetricsSnapshot = {
  liveTps?: number;
  sessionAvgTps?: number;
  sessionAvgTtftSec?: number;
};

type StreamMetricsState = {
  streamSamples: StreamSample[];
  messageTimingByKey: Map<string, MessageTiming>;
  sessionAverage: SessionAverage;
  activeMessageKey: string | null;
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
  if (totals.messageCount <= 0 || totals.totalTtftMs < 0) return undefined;
  return totals.totalTtftMs / totals.messageCount / 1000;
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
  };
}

export function createStreamMetricsTracker(): {
  state: StreamMetricsState;
  resetSession: () => void;
  onAgentStart: () => void;
  onMessageStart: (messageKey: string, requestStartAt: number) => void;
  onMessageUpdate: (messageKey: string, streamEvent: AssistantMessageEvent | undefined) => void;
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
    sessionAverage: { totalTokens: 0, totalDurationMs: 0, totalTtftMs: 0, messageCount: 0 },
    activeMessageKey: null,
    pruneTimer: null,
    version: 0,
  };

  state.pruneTimer = setInterval(() => {
    pruneSamples(state);
  }, 1000);

  const resetSession = () => {
    state.streamSamples = [];
    state.messageTimingByKey.clear();
    state.sessionAverage = { totalTokens: 0, totalDurationMs: 0, totalTtftMs: 0, messageCount: 0 };
    state.activeMessageKey = null;
    state.version++;
  };

  const onAgentStart = () => {
    clearLiveSamples(state);
  };

  const onMessageStart = (messageKey: string, requestStartAt: number) => {
    state.activeMessageKey = messageKey;
    state.messageTimingByKey.set(messageKey, { requestStartAt });
    state.version++;
  };

  const onMessageUpdate = (messageKey: string, streamEvent: AssistantMessageEvent | undefined) => {
    if (!streamEvent) return;

    if (streamEvent.type === "start") {
      const timing = state.messageTimingByKey.get(messageKey);
      if (timing && timing.firstResponseAt === undefined) {
        timing.firstResponseAt = Date.now();
        state.messageTimingByKey.set(messageKey, timing);
        state.version++;
      }
      return;
    }

    if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
      const delta = streamEvent.delta;
      if (typeof delta !== "string" || delta.length === 0) return;
      appendSample(state, messageKey, {
        at: Date.now(),
        tokens: estimateStreamTokens(delta),
      });
      return;
    }

    if (streamEvent.type === "toolcall_start") {
      clearLiveSamples(state);
      const timing = state.messageTimingByKey.get(messageKey);
      if (timing) {
        timing.lastToolCallAt = Date.now();
        if (timing.firstResponseAt === undefined) {
          timing.firstResponseAt = Date.now();
        }
        state.messageTimingByKey.set(messageKey, timing);
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
    const timing = state.messageTimingByKey.get(messageKey);
    if (timing && typeof timing.firstResponseAt === "number") {
      const totalTokens = countOutputTokens(message);
      const endAt = message.stopReason === "toolUse" && timing.lastToolCallAt
        ? timing.lastToolCallAt
        : message.timestamp;
      const durationMs = Math.max(endAt - timing.firstResponseAt, 1);
      const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0);

      if (totalTokens > 0 && message.stopReason !== "error" && message.stopReason !== "aborted") {
        state.sessionAverage = {
          totalTokens: state.sessionAverage.totalTokens + totalTokens,
          totalDurationMs: state.sessionAverage.totalDurationMs + durationMs,
          totalTtftMs: state.sessionAverage.totalTtftMs + ttftMs,
          messageCount: state.sessionAverage.messageCount + 1,
        };
      }
    }

    state.messageTimingByKey.delete(messageKey);
    if (state.activeMessageKey === messageKey) {
      state.activeMessageKey = null;
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