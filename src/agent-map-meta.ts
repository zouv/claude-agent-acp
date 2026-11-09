// Agent-map metadata for clients that ask for it.
//
// ACP's `subagent_update` carries the child's labels and work state, but not
// what an "agent map" shows next to them: the wall-clock span, the token
// usage, and the one-line progress summary. Those are already in the SDK's
// `task_progress` events, so this module only defines the wire shape and a
// client capability that keeps the extra `_meta` off every other client's
// stream (their golden files and their parsers stay unchanged).
//
// The key is namespaced: `_meta["vac/agentMap"]`, version 1.

export const AGENT_MAP_CAPABILITY = "vac/agentMap";
export const AGENT_MAP_META_KEY = "vac/agentMap";

/** Versioned payload under `_meta["vac/agentMap"]`. Every field is optional: a partial update merges. */
export type AgentMapMetadata = {
  version: 1;
  /** The Agent/Task tool call that launched the child in its parent session. */
  parentToolUseId?: string;
  /** When the current run started, in epoch milliseconds. */
  startedAt?: number;
  /** When the current run reached `idle`, in epoch milliseconds. */
  endedAt?: number;
  /** The run's duration as the SDK measured it (preferred over `endedAt - startedAt`). */
  durationMs?: number;
  /** Tokens the child consumed in this run. */
  totalTokens?: number;
  /** Tool calls the child made in this run. */
  toolUses?: number;
  /** The SDK's model-generated progress summary, when available. */
  summary?: string;
  /** The child's most recent tool name. */
  lastToolName?: string;
};

/**
 * Whether the client asked for agent-map metadata. It declares
 * `clientCapabilities._meta["vac/agentMap"] === true`; the ACP client
 * capabilities type has no slot for it, so the lookup is untyped.
 */
export function clientSupportsAgentMap(capabilities: unknown): boolean {
  const capabilitiesMeta = (
    capabilities as { _meta?: Record<string, unknown> | null } | null | undefined
  )?._meta;
  return capabilitiesMeta?.[AGENT_MAP_CAPABILITY] === true;
}

/** The `_meta` object for a `subagent_update`, or undefined when nothing is known yet. */
export function agentMapMeta(
  fields: Omit<AgentMapMetadata, "version">,
): { [AGENT_MAP_META_KEY]: AgentMapMetadata } | undefined {
  const metadata: AgentMapMetadata = { version: 1 };
  const assign = <K extends keyof AgentMapMetadata>(key: K, value: AgentMapMetadata[K]): void => {
    if (value !== undefined) metadata[key] = value;
  };
  assign("parentToolUseId", fields.parentToolUseId);
  assign("startedAt", fields.startedAt);
  assign("endedAt", fields.endedAt);
  assign("durationMs", fields.durationMs);
  assign("totalTokens", fields.totalTokens);
  assign("toolUses", fields.toolUses);
  assign("summary", fields.summary);
  assign("lastToolName", fields.lastToolName);
  if (Object.keys(metadata).length === 1) return undefined;
  return { [AGENT_MAP_META_KEY]: metadata };
}
