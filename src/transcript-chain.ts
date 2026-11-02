import { readFile } from "node:fs/promises";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { isCompactSummaryMessage } from "./context-compaction.js";
import { findTranscript } from "./resumed-session.js";

/**
 * One raw line of Claude Code's local JSONL transcript.
 *
 * The SDK's `getSessionMessages()` returns the effective (post-compaction) chain.
 * Once a session was compacted, that chain starts at the compact summary and the
 * pre-compaction history is gone. The raw transcript still has every record, so
 * replay can rebuild the full display chain by walking `parentUuid` backwards and
 * crossing the boundary through `preservedSegment.tailUuid`.
 */
export type TranscriptEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  teamName?: string;
  message?: unknown;
  attachment?: {
    type?: string;
    prompt?: unknown;
    source_uuid?: string;
    isMeta?: boolean;
    commandMode?: string;
    origin?: { kind?: string };
  };
  compactMetadata?: {
    preservedSegment?: { tailUuid?: string };
    preservedMessages?: { anchorUuid?: string };
  };
  timestamp?: string;
  sessionId?: string;
  origin?: unknown;
  [key: string]: unknown;
};

type TranscriptLogger = {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const HIDDEN_ATTACHMENT_ORIGINS = new Set([
  "task-notification",
  "peer",
  "coordinator",
  "observer",
  "observer-activity",
]);

/** A compact boundary record, which is a timeline marker rather than a message. */
function isCompactBoundary(entry: TranscriptEntry): boolean {
  return entry.type === "system" && entry.subtype === "compact_boundary";
}

/** A main-thread user/assistant record that belongs in the display chain. */
function isDisplayMessage(entry: TranscriptEntry): boolean {
  return (
    typeof entry.uuid === "string" &&
    (entry.type === "user" || entry.type === "assistant") &&
    entry.isSidechain !== true &&
    entry.isMeta !== true &&
    !entry.teamName
  );
}

/** A queued command is shown only when it is actual user input, not a notification. */
function isDisplayableQueuedCommand(entry: TranscriptEntry): boolean {
  if (
    entry.type !== "attachment" ||
    entry.isSidechain === true ||
    entry.isMeta === true ||
    entry.teamName ||
    entry.attachment?.type !== "queued_command"
  ) {
    return false;
  }
  const attachment = entry.attachment;
  if (attachment.isMeta === true) return false;
  const origin = attachment.origin?.kind;
  return !(
    (typeof origin === "string" && HIDDEN_ATTACHMENT_ORIGINS.has(origin)) ||
    attachment.commandMode === "task-notification"
  );
}

/**
 * Walk to the previous record on the display chain.
 *
 * A compact boundary has `parentUuid: null`; the pre-compaction history is
 * reachable only through `logicalParentUuid` or the boundary's
 * `preservedSegment.tailUuid`. All three candidates must be tried in this order.
 */
function parentOf(
  entry: TranscriptEntry,
  byUuid: Map<string, TranscriptEntry>,
): TranscriptEntry | undefined {
  const candidates = [
    entry.parentUuid,
    entry.logicalParentUuid,
    entry.compactMetadata?.preservedSegment?.tailUuid,
  ];
  for (const id of candidates) {
    if (typeof id !== "string") continue;
    const parent = byUuid.get(id);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

/**
 * Rebuild the full display chain from the raw transcript.
 *
 * Returns `undefined` when the transcript has no compact boundary (the effective
 * chain is already complete) or when the rebuilt chain no longer contains a
 * boundary (a broken/orphaned branch; the caller should fall back).
 */
export function buildFullDisplayChain(
  entries: readonly TranscriptEntry[],
  preferredLeafUuid?: string,
): TranscriptEntry[] | undefined {
  if (!entries.some(isCompactBoundary)) return undefined;

  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
  }

  let leaf: TranscriptEntry | undefined;
  if (preferredLeafUuid !== undefined) {
    const preferred = byUuid.get(preferredLeafUuid);
    if (preferred !== undefined && isDisplayMessage(preferred)) leaf = preferred;
  }
  if (leaf === undefined) {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (isDisplayMessage(entries[index])) {
        leaf = entries[index];
        break;
      }
    }
  }
  if (leaf === undefined) return undefined;

  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = leaf;
  while (current !== undefined && typeof current.uuid === "string" && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = parentOf(current, byUuid);
  }
  chain.reverse();

  const display = chain.filter(
    (entry) =>
      isCompactBoundary(entry) || isDisplayMessage(entry) || isDisplayableQueuedCommand(entry),
  );
  return display.some(isCompactBoundary) ? display : undefined;
}

/**
 * Convert the raw display chain to the `SessionMessage` shape `replaySessionHistory`
 * consumes.
 *
 * Compact boundaries are dropped: 0.91.0's replay loop assumes every message has a
 * `message.message`, and a system boundary does not. The summary keeps
 * `isCompactSummary` at the top level (that is what `isCompactSummaryMessage` reads)
 * and gains `is_meta`, matching the SDK's normalized shape.
 */
export function toSessionMessages(
  chain: readonly TranscriptEntry[],
  sessionId: string,
): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const entry of chain) {
    if (isCompactBoundary(entry)) continue;

    if (isDisplayableQueuedCommand(entry)) {
      const prompt = entry.attachment?.prompt;
      if (typeof prompt !== "string" && !Array.isArray(prompt)) continue;
      const uuid = entry.attachment?.source_uuid || entry.uuid;
      if (uuid === undefined) continue;
      messages.push({
        type: "user",
        uuid,
        session_id: entry.sessionId ?? sessionId,
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        parent_agent_id: null,
        ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
      } as SessionMessage);
      continue;
    }

    if (!isDisplayMessage(entry) || typeof entry.uuid !== "string") continue;
    const message = entry.message;
    if (message === null || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string" && !Array.isArray(content)) continue;

    messages.push({
      type: entry.type as "user" | "assistant",
      uuid: entry.uuid,
      session_id: entry.sessionId ?? sessionId,
      message,
      parent_tool_use_id: null,
      parent_agent_id: null,
      ...(entry.isCompactSummary === true ? { isCompactSummary: true, is_meta: true } : {}),
      ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    } as SessionMessage);
  }
  return messages;
}

/** Read every parseable record with a uuid from the local transcript. */
export async function readTranscriptEntries(
  sessionId: string,
  logger?: TranscriptLogger,
): Promise<TranscriptEntry[] | undefined> {
  try {
    const file = await findTranscript(sessionId);
    if (file === undefined) return undefined;
    const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    const entries: TranscriptEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (
          record !== null &&
          typeof record === "object" &&
          typeof (record as { uuid?: unknown }).uuid === "string"
        ) {
          entries.push(record as TranscriptEntry);
        }
      } catch {
        // A malformed line is skipped; the rest of the transcript is still usable.
      }
    }
    return entries;
  } catch (error) {
    logger?.error(`replay: failed to read transcript for ${sessionId}:`, error);
    return undefined;
  }
}

/**
 * The full display chain as `SessionMessage[]`, or `undefined` when the effective
 * chain has no compact summary (nothing to rebuild) or the raw transcript is
 * unavailable.
 */
export async function readFullDisplayChain(
  sessionId: string,
  effectiveMessages: readonly SessionMessage[],
  logger?: TranscriptLogger,
): Promise<SessionMessage[] | undefined> {
  if (!effectiveMessages.some(isCompactSummaryMessage)) return undefined;
  const entries = await readTranscriptEntries(sessionId, logger);
  if (entries === undefined) return undefined;
  const chain = buildFullDisplayChain(entries, effectiveMessages.at(-1)?.uuid);
  if (chain === undefined) return undefined;
  const messages = toSessionMessages(chain, sessionId);
  if (messages.length === 0) return undefined;
  logger?.log(
    `replay: rebuilt full display chain for ${sessionId}: ${chain.length} display entries ` +
      `(${chain.filter(isCompactBoundary).length} compaction boundaries, ` +
      `${entries.length} raw transcript entries, ${messages.length} messages)`,
  );
  return messages;
}
