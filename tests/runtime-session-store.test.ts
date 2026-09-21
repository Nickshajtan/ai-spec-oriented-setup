import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSpecifierRuntime, RuntimeSessionStore, RuntimeSessionStoreError } from "../src/index.ts";
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

test("production runtime composition ignores former deterministic test-model environment switch", () => {
  const previousBaseUrl = process.env.AI_SPEC_LITELLM_BASE_URL;
  const previousTestModel = process.env.AI_SPEC_RUNTIME_TEST_MODEL;
  try {
    delete process.env.AI_SPEC_LITELLM_BASE_URL;
    process.env.AI_SPEC_RUNTIME_TEST_MODEL = "1";
    assert.throws(() => createSpecifierRuntime(), /AI_SPEC_LITELLM_BASE_URL is required/);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.AI_SPEC_LITELLM_BASE_URL;
    else process.env.AI_SPEC_LITELLM_BASE_URL = previousBaseUrl;
    if (previousTestModel === undefined) delete process.env.AI_SPEC_RUNTIME_TEST_MODEL;
    else process.env.AI_SPEC_RUNTIME_TEST_MODEL = previousTestModel;
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
    await assert.rejects(() => new RuntimeSessionStore().load(projectRoot, "future"), errorWithCode("session-version-unsupported"));

    const files = await readFile(path.join(sessions, "future.json"), "utf8");
    assert.doesNotMatch(files, /API_KEY|Bearer|secret/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime session store rejects malformed persisted workflow state before Core use", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "runtime-store-invalid-state-"));
  const sessions = path.join(projectRoot, ".ai-spec-core", "sessions");
  await mkdir(sessions, { recursive: true });
  try {
    const cases: Array<{ name: string; mutate: (session: any) => void; code?: string }> = [
      {
        name: "missing projectRoot",
        mutate: (session) => {
          delete session.state.projectRoot;
        },
      },
      {
        name: "invalid workflow status",
        mutate: (session) => {
          session.state.status = "done";
        },
      },
      {
        name: "missing generation state",
        mutate: (session) => {
          delete session.state.generation;
        },
      },
      {
        name: "invalid validation state",
        mutate: (session) => {
          session.state.validation = { latest: { valid: true } };
        },
      },
      {
        name: "invalid review state",
        mutate: (session) => {
          session.state.review = { attempts: [{ verdict: "maybe", findings: [] }] };
        },
      },
      {
        name: "malformed interview state",
        mutate: (session) => {
          session.state.interview.readiness = { ready: "yes" };
        },
      },
      {
        name: "session and interview id mismatch",
        mutate: (session) => {
          session.state.interview.id = "other-session";
        },
      },
      {
        name: "unsupported version",
        code: "session-version-unsupported",
        mutate: (session) => {
          session.version = 2;
        },
      },
    ];

    for (const testCase of cases) {
      const sessionId = testCase.name.replace(/[^a-z0-9]+/gi, "-");
      const session = persisted(sessionId);
      testCase.mutate(session);
      await writeFile(path.join(sessions, `${sessionId}.json`), JSON.stringify(session), "utf8");
      await assert.rejects(
        () => new RuntimeSessionStore().load(projectRoot, sessionId),
        errorWithCode(testCase.code ?? "session-corrupt"),
        testCase.name,
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function errorWithCode(code: string) {
  return (error: unknown) => error instanceof RuntimeSessionStoreError && error.code === code;
}

function persisted(sessionId: string) {
  return {
    version: 1,
    sessionId,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    state: state(sessionId),
  };
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
