import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeSessionStore, RuntimeSessionStoreError } from "../src/index.ts";
import type { SpecificationWorkflowState } from "../src/index.ts";

test("runtime session store persists and loads a valid workflow state", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "runtime-store-"));
  const store = new RuntimeSessionStore({ clock: () => new Date("2026-09-20T00:00:00.000Z") });
  try {
    const saved = await store.save(projectRoot, state("session-1"));
    const loaded = await store.load(projectRoot, "session-1");

    assert.equal(saved.version, 1);
    assert.equal(loaded.sessionId, "session-1");
    assert.equal(loaded.state.changeName, "redis-cache");
    assert.equal(loaded.createdAt, "2026-09-20T00:00:00.000Z");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime session store reports missing, corrupt, incompatible, and traversal-like sessions", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "runtime-store-errors-"));
  const sessions = path.join(projectRoot, ".ai-spec-core", "sessions");
  await mkdir(sessions, { recursive: true });
  try {
    await assert.rejects(() => new RuntimeSessionStore().load(projectRoot, "missing"), errorWithCode("session-not-found"));
    await assert.rejects(() => new RuntimeSessionStore().load(projectRoot, "../escape"), errorWithCode("session-path-rejected"));

    await writeFile(path.join(sessions, "corrupt.json"), "{", "utf8");
    await assert.rejects(() => new RuntimeSessionStore().load(projectRoot, "corrupt"), errorWithCode("session-corrupt"));

    await writeFile(
      path.join(sessions, "future.json"),
      JSON.stringify({ version: 99, sessionId: "future", state: state("future") }),
      "utf8",
    );
    await assert.rejects(
      () => new RuntimeSessionStore().load(projectRoot, "future"),
      errorWithCode("session-version-unsupported"),
    );

    const files = await readFile(path.join(sessions, "future.json"), "utf8");
    assert.doesNotMatch(files, /API_KEY|Bearer|secret/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function errorWithCode(code: string) {
  return (error: unknown) => error instanceof RuntimeSessionStoreError && error.code === code;
}

function state(sessionId: string): SpecificationWorkflowState {
  return {
    projectRoot: "/project",
    changeName: "redis-cache",
    status: "needs-input",
    generation: { artifacts: [], attempts: 0 },
    validation: { repairAttempts: 0 },
    review: { attempts: [] },
    interview: {
      id: sessionId,
      projectRoot: "/project",
      changeName: "redis-cache",
      roughIdea: "Add Redis caching.",
      turnCount: 1,
      openspec: { gatewayResults: {} },
      facts: [],
      assumptions: [],
      choices: [],
      questions: [
        {
          id: "question-1",
          text: "What should happen when Redis is unavailable?",
          why: "Failure behavior matters.",
          gapId: "availability",
          askedAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      unresolvedQuestions: [
        {
          id: "question-1",
          text: "What should happen when Redis is unavailable?",
          why: "Failure behavior matters.",
          gapId: "availability",
          askedAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      gaps: [],
      contradictions: [],
      readiness: {
        ready: false,
        reason: "Needs fallback behavior.",
        blockingGaps: ["availability"],
        unresolvedContradictions: [],
      },
    },
  };
}
