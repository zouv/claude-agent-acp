import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFullDisplayChain,
  readTranscriptEntries,
  toSessionMessages,
  type TranscriptEntry,
} from "../transcript-chain.js";

function user(
  uuid: string,
  text: string,
  parentUuid: string | null = null,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  };
}

function assistant(
  uuid: string,
  text: string,
  parentUuid: string | null = null,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    message: { role: "assistant", id: `msg-${uuid}`, content: [{ type: "text", text }] },
    ...extra,
  };
}

function attachment(
  uuid: string,
  parentUuid: string | null,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    type: "attachment",
    uuid,
    parentUuid,
    attachment: { type: "file" },
    ...extra,
  };
}

function boundary(
  uuid: string,
  tailUuid: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    parentUuid: null,
    logicalParentUuid: tailUuid,
    compactMetadata: { preservedSegment: { tailUuid } },
    ...extra,
  };
}

function summary(uuid: string, text: string, parentUuid: string | null = null): TranscriptEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: "user", content: text },
  };
}

/** first question -> answer -> boundary -> summary -> second question -> answer */
function compactedTranscript(): TranscriptEntry[] {
  return [
    user("u1", "first question"),
    assistant("a1", "first answer", "u1"),
    attachment("att1", "a1"),
    boundary("b1", "a1"),
    attachment("att2", "b1"),
    summary("s1", "summary body", "att2"),
    user("u2", "second question", "s1"),
    assistant("a2", "second answer", "u2"),
  ];
}

describe("buildFullDisplayChain", () => {
  it("reconstructs the pre-compaction history and keeps the boundary/summary order", () => {
    const chain = buildFullDisplayChain(compactedTranscript());
    expect(chain?.map((entry) => entry.uuid)).toEqual(["u1", "a1", "b1", "s1", "u2", "a2"]);
    expect(chain?.[0]?.type).toBe("user");
    expect(chain?.findIndex((entry) => entry.subtype === "compact_boundary")).toBe(2);
    expect(chain?.findIndex((entry) => entry.isCompactSummary === true)).toBe(3);
  });

  it("returns undefined when the transcript has no compact boundary", () => {
    expect(
      buildFullDisplayChain([user("u1", "question"), assistant("a1", "answer", "u1")]),
    ).toBeUndefined();
  });

  it("returns undefined when the rebuilt chain no longer reaches a boundary", () => {
    const entries = [
      user("u1", "orphan"),
      assistant("a1", "orphan answer", "missing-parent"),
      boundary("b1", "a1"),
      // Nothing points at b1, so the leaf chain is u1 -> a1 and has no boundary.
    ];
    expect(buildFullDisplayChain(entries)).toBeUndefined();
  });

  it("uses preservedSegment.tailUuid when the boundary has no logicalParentUuid", () => {
    const entries = [
      user("u1", "first"),
      assistant("a1", "answer", "u1"),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        parentUuid: null,
        compactMetadata: { preservedSegment: { tailUuid: "a1" } },
      } satisfies TranscriptEntry,
      summary("s1", "summary", "b1"),
      user("u2", "second", "s1"),
    ];
    expect(buildFullDisplayChain(entries)?.map((entry) => entry.uuid)).toEqual([
      "u1",
      "a1",
      "b1",
      "s1",
      "u2",
    ]);
  });

  it("excludes sidechain, meta and team records", () => {
    const entries = [
      ...compactedTranscript(),
      assistant("side", "sidechain", "a2", { isSidechain: true }),
      user("meta", "meta", "a2", { isMeta: true }),
      user("team", "team", "a2", { teamName: "team-a" }),
    ];
    expect(buildFullDisplayChain(entries)?.map((entry) => entry.uuid)).toEqual([
      "u1",
      "a1",
      "b1",
      "s1",
      "u2",
      "a2",
    ]);
  });

  it("uses the preferred active leaf instead of a later abandoned branch", () => {
    const entries = [...compactedTranscript(), user("abandoned", "abandoned", "a2")];
    expect(buildFullDisplayChain(entries)?.at(-1)?.uuid).toBe("abandoned");
    expect(buildFullDisplayChain(entries, "a2")?.at(-1)?.uuid).toBe("a2");
  });

  it("keeps human queued commands and drops task notifications", () => {
    const entries = [
      {
        type: "attachment",
        uuid: "q1",
        parentUuid: null,
        attachment: {
          type: "queued_command",
          prompt: "queued prompt",
          origin: { kind: "human" },
        },
      } satisfies TranscriptEntry,
      { ...compactedTranscript()[0], parentUuid: "q1" },
      ...compactedTranscript().slice(1),
    ];
    const chain = buildFullDisplayChain(entries);
    expect(chain?.map((entry) => entry.uuid)).toEqual(["q1", "u1", "a1", "b1", "s1", "u2", "a2"]);

    const notification = {
      type: "attachment",
      uuid: "n1",
      parentUuid: null,
      attachment: { type: "queued_command", prompt: "done", commandMode: "task-notification" },
    } satisfies TranscriptEntry;
    const notificationEntries = [
      notification,
      { ...compactedTranscript()[0], parentUuid: "n1" },
      ...compactedTranscript().slice(1),
    ];
    expect(buildFullDisplayChain(notificationEntries)?.map((entry) => entry.uuid)).toEqual([
      "u1",
      "a1",
      "b1",
      "s1",
      "u2",
      "a2",
    ]);
  });
});

describe("toSessionMessages", () => {
  it("drops the boundary and keeps the summary as a top-level compact summary", () => {
    const chain = buildFullDisplayChain(compactedTranscript())!;
    const messages = toSessionMessages(chain, "session-1");
    expect(messages.map((message) => message.uuid)).toEqual(["u1", "a1", "s1", "u2", "a2"]);
    const compact = messages.find((message) => message.uuid === "s1") as unknown as {
      isCompactSummary?: boolean;
      is_meta?: boolean;
      parent_tool_use_id?: string | null;
    };
    expect(compact.isCompactSummary).toBe(true);
    expect(compact.is_meta).toBe(true);
    expect(compact.parent_tool_use_id).toBeNull();
  });

  it("converts a human queued command into a user message and skips non-text prompts", () => {
    const entries = [
      {
        type: "attachment",
        uuid: "q1",
        parentUuid: null,
        attachment: {
          type: "queued_command",
          prompt: "queued prompt",
          source_uuid: "source-1",
          origin: { kind: "human" },
        },
      } satisfies TranscriptEntry,
      { ...compactedTranscript()[0], parentUuid: "q1" },
      ...compactedTranscript().slice(1),
    ];
    const messages = toSessionMessages(buildFullDisplayChain(entries)!, "session-1");
    expect(messages[0]).toMatchObject({
      type: "user",
      uuid: "source-1",
      message: { role: "user", content: "queued prompt" },
    });

    const objectPrompt = toSessionMessages(
      [
        {
          type: "attachment",
          uuid: "q2",
          parentUuid: null,
          attachment: {
            type: "queued_command",
            prompt: { not: "text" },
            origin: { kind: "human" },
          },
        },
      ],
      "session-1",
    );
    expect(objectPrompt).toEqual([]);
  });
});

describe("readTranscriptEntries", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "claude-acp-chain-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  async function writeTranscript(
    project: string,
    sessionId: string,
    lines: string[],
  ): Promise<void> {
    const directory = path.join(configDir, "projects", project);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  it("keeps records with a uuid and skips malformed or uuid-less lines", async () => {
    await writeTranscript("project-a", "session-1", [
      JSON.stringify(user("u1", "question")),
      "{not json",
      JSON.stringify({ type: "system", subtype: "compact_boundary" }),
      JSON.stringify(assistant("a1", "answer", "u1")),
    ]);

    const entries = await readTranscriptEntries("session-1");
    expect(entries?.map((entry) => entry.uuid)).toEqual(["u1", "a1"]);
  });

  it("finds the transcript in any project directory and returns undefined when absent", async () => {
    await writeTranscript("project-b", "session-2", [JSON.stringify(user("u1", "question"))]);
    expect((await readTranscriptEntries("session-2"))?.length).toBe(1);
    expect(await readTranscriptEntries("missing")).toBeUndefined();
  });
});
