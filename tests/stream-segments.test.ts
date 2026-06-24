import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import type { ColorScheme, SegmentContext, ThemeLike } from "../types.ts";

function baseCtx(overrides: Partial<SegmentContext>): SegmentContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    streamMetrics: {},
    isStreaming: false,
    contextPercent: 0,
    contextWindow: 0,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    sessionStartTime: Date.now(),
    shellModeActive: false,
    shellRunning: false,
    shellName: null,
    shellCwd: null,
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: {},
    theme: { fg: (_color: string, text: string) => text } satisfies ThemeLike,
    colors: { tokens: "muted" } satisfies ColorScheme,
    ...overrides,
  };
}

test("tps_live hidden when not streaming", () => {
  const r = renderSegment("tps_live", baseCtx({ isStreaming: false, streamMetrics: { liveTps: 42 } }));
  assert.equal(r.visible, false);
});

test("tps_live shows formatted rate while streaming", () => {
  const r = renderSegment("tps_live", baseCtx({ isStreaming: true, streamMetrics: { liveTps: 12.3 } }));
  assert.equal(r.visible, true);
  assert.ok(r.content.replace(/\x1b\[[0-9;]*m/g, "").includes("TPS 12.3"));
});

test("ttft_avg shows session average", () => {
  const r = renderSegment("ttft_avg", baseCtx({ streamMetrics: { sessionAvgTtftSec: 1.5 } }));
  assert.equal(r.visible, true);
  assert.ok(r.content.replace(/\x1b\[[0-9;]*m/g, "").includes("TTFT 1.5s"));
});