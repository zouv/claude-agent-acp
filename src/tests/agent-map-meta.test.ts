import { describe, expect, it } from "vitest";
import { agentMapMeta, clientSupportsAgentMap } from "../agent-map-meta.js";

describe("agent-map client capability", () => {
  it("is on only for a client that declares the namespaced flag", () => {
    expect(clientSupportsAgentMap({ _meta: { "vac/agentMap": true } })).toBe(true);
    expect(clientSupportsAgentMap({ _meta: { "vac/agentMap": false } })).toBe(false);
    expect(clientSupportsAgentMap({ subagents: {} })).toBe(false);
    expect(clientSupportsAgentMap(undefined)).toBe(false);
  });
});

describe("agentMapMeta", () => {
  it("omits unknown fields instead of writing undefined", () => {
    expect(agentMapMeta({})).toBeUndefined();
    expect(agentMapMeta({ startedAt: 5 })).toEqual({
      "vac/agentMap": { version: 1, startedAt: 5 },
    });
  });

  it("keeps the parent call, the span and the usage together", () => {
    expect(
      agentMapMeta({
        parentToolUseId: "launch-1",
        startedAt: 100,
        endedAt: 250,
        durationMs: 150,
        totalTokens: 9,
        toolUses: 2,
        summary: "Halfway",
        lastToolName: "Read",
      }),
    ).toEqual({
      "vac/agentMap": {
        version: 1,
        parentToolUseId: "launch-1",
        startedAt: 100,
        endedAt: 250,
        durationMs: 150,
        totalTokens: 9,
        toolUses: 2,
        summary: "Halfway",
        lastToolName: "Read",
      },
    });
  });
});
