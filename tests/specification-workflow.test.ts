import assert from "node:assert/strict";
import test from "node:test";
import { SpecificationWorkflow } from "../src/index.ts";
import type {
  ArtifactReader,
  ArtifactWriter,
  GenerateArtifactInput,
  GeneratedArtifact,
  InterviewSession,
  OpenSpecArtifact,
  OpenSpecGateway,
  OpenSpecGatewayResult,
  QuestionPlan,
  SpecReview,
  SpecReviewer,
  WriteArtifactInput,
} from "../src/index.ts";

test("generates custom OpenSpec artifacts, validates, reviews, and becomes ready", async () => {
  const gateway = new FakeOpenSpecGateway([
    [
      artifact("intent", "openspec/changes/custom/intent.md", "missing"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "blocked", ["intent"]),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "missing", ["intent"]),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "complete", ["intent"]),
    ],
  ]);
  const store = new MemoryArtifacts();
  const generator = new QueueGenerator(["intent content", "architecture content"]);
  const reviewer = new QueueReviewer([{ verdict: "pass", findings: [] }]);

  const result = await workflow(gateway, store, generator, reviewer).start(startInput());

  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.deepEqual(generator.calls.map((call) => call.artifact.id), ["intent", "architecture-note"]);
  assert.deepEqual(generator.calls[1]?.dependencies.map((dependency) => dependency.artifactId), ["intent"]);
  assert.equal(store.files.get("openspec/changes/custom/intent.md"), "intent content");
  assert.equal(store.files.get("openspec/changes/custom/architecture.md"), "architecture content");
  assert.equal(gateway.validationCalls, 1);
  assert.equal(reviewer.calls.length, 1);
});

test("review needs_revision revises only affected artifact with explicit overwrite", async () => {
  const gateway = new FakeOpenSpecGateway([
    [
      artifact("intent", "openspec/changes/custom/intent.md", "missing"),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete"),
    ],
  ]);
  const store = new MemoryArtifacts();
  const generator = new QueueGenerator(["intent v1", "plan v1", "plan v2"]);
  const reviewer = new QueueReviewer([
    {
      verdict: "needs_revision",
      findings: [
        {
          id: "plan-missing",
          severity: "error",
          artifactId: "implementation-plan",
          issue: "Plan omitted known fact.",
          reason: "Known fact was not represented.",
        },
      ],
    },
    { verdict: "pass", findings: [] },
  ]);

  const result = await workflow(gateway, store, generator, reviewer).start(startInput());

  assert.equal(result.status, "ready");
  assert.deepEqual(generator.calls.map((call) => `${call.mode}:${call.artifact.id}`), [
    "create:intent",
    "create:implementation-plan",
    "revise:implementation-plan",
  ]);
  assert.deepEqual(store.writes.map((write) => `${write.path}:${write.overwrite === true}`), [
    "openspec/changes/custom/intent.md:false",
    "openspec/changes/custom/plan.md:false",
    "openspec/changes/custom/plan.md:true",
  ]);
  assert.equal(gateway.validationCalls, 2);
  assert.equal(reviewer.calls.length, 2);
});

test("review needs_input reopens the same interview and resumes after answer", async () => {
  const gateway = new FakeOpenSpecGateway([
    [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
  ]);
  const store = new MemoryArtifacts();
  const generator = new QueueGenerator(["intent v1", "intent v2"]);
  const reviewer = new QueueReviewer([
    {
      verdict: "needs_input",
      findings: [
        {
          id: "runtime",
          severity: "error",
          artifactId: "intent",
          issue: "Runtime target is missing.",
          reason: "Runtime affects implementation.",
          suggestedQuestion: "Where will this run?",
        },
      ],
    },
    { verdict: "pass", findings: [] },
  ]);
  const flow = workflow(gateway, store, generator, reviewer);

  const blocked = await flow.start(startInput());

  assert.equal(blocked.status, "needs-input");
  assert.equal(blocked.question?.text, "Where will this run?");
  assert.equal(blocked.state.interview.gaps[0]?.source, "review");

  const ready = await flow.answer({ state: blocked.state, answer: "Node 22 on Linux." });

  assert.equal(ready.status, "ready");
  assert.equal(ready.state.interview.facts.at(-1)?.provenance.source, "user");
  assert.deepEqual(generator.calls.map((call) => `${call.mode}:${call.artifact.id}`), ["create:intent", "revise:intent"]);
});

test("validation failure is repaired before mandatory independent review", async () => {
  const gateway = new FakeOpenSpecGateway(
    [
      [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
      [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
    ],
    [false, true],
  );
  const store = new MemoryArtifacts();
  const generator = new QueueGenerator(["invalid content", "valid content"]);
  const reviewer = new QueueReviewer([{ verdict: "pass", findings: [] }]);

  const result = await workflow(gateway, store, generator, reviewer).start(startInput());

  assert.equal(result.status, "ready");
  assert.deepEqual(generator.calls.map((call) => call.mode), ["create", "revise"]);
  assert.equal(gateway.validationCalls, 2);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(reviewer.calls[0]?.validation.valid, true);
});

test("guards generation no-progress loops and writer conflicts", async () => {
  const noProgress = new FakeOpenSpecGateway([[artifact("intent", "openspec/changes/custom/intent.md", "missing")]]);
  const store = new MemoryArtifacts();
  const blocked = await workflow(
    noProgress,
    store,
    new QueueGenerator(["one", "two"]),
    new QueueReviewer([{ verdict: "pass", findings: [] }]),
    {
      maxGenerationIterations: 2,
    },
  ).start(startInput());

  assert.equal(blocked.status, "failed");
  assert.equal(blocked.state.failure?.code, "generation-no-progress");

  const conflictStore = new MemoryArtifacts();
  conflictStore.files.set("openspec/changes/custom/intent.md", "existing");
  const conflict = await workflow(
    new FakeOpenSpecGateway([[artifact("intent", "openspec/changes/custom/intent.md", "missing")]]),
    conflictStore,
    new QueueGenerator(["replacement"]),
    new QueueReviewer([{ verdict: "pass", findings: [] }]),
  ).start(startInput());

  assert.equal(conflict.status, "failed");
  assert.equal(conflict.state.failure?.code, "artifact-write-conflict");
});

test("guards review iteration limits and malformed review output", async () => {
  const reviewLimited = await workflow(
    new FakeOpenSpecGateway([
      [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
      [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
    ]),
    new MemoryArtifacts(),
    new QueueGenerator(["intent"]),
    new QueueReviewer([
      {
        verdict: "needs_revision",
        findings: [{ id: "intent", severity: "error", artifactId: "intent", issue: "weak", reason: "weak" }],
      },
    ]),
    { maxReviewIterations: 1 },
  ).start(startInput());

  assert.equal(reviewLimited.status, "failed");
  assert.equal(reviewLimited.state.failure?.code, "review-iteration-limit");

  const malformed = await workflow(
    new FakeOpenSpecGateway([
      [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
      [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
    ]),
    new MemoryArtifacts(),
    new QueueGenerator(["intent"]),
    {
      async review() {
        throw new Error("Model returned invalid JSON.");
      },
    },
  ).start(startInput());

  assert.equal(malformed.status, "failed");
  assert.equal(malformed.state.failure?.code, "spec-review");
});

test("validation repair targets diagnostics and never guesses the first artifact", async () => {
  const gateway = new FakeOpenSpecGateway(
    [
      [
        artifact("intent", "openspec/changes/custom/intent.md", "complete"),
        artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete"),
      ],
      [
        artifact("intent", "openspec/changes/custom/intent.md", "complete"),
        artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete"),
      ],
    ],
    [false, true],
  );
  gateway.validate = async function validate() {
    const valid = this.validationCalls > 0;
    this.validationCalls += 1;
    return ok(this.statuses.at(-1) ?? [], {
      valid,
      exitCode: valid ? 0 : 1,
      findings: valid ? [] : [{ path: "openspec/changes/custom/plan.md", message: "Plan is structurally invalid." }],
      stdout: "{}",
      stderr: "",
      raw: { valid },
    });
  };
  const store = new MemoryArtifacts();
  store.files.set("openspec/changes/custom/intent.md", "intent");
  store.files.set("openspec/changes/custom/plan.md", "plan");
  const generator = new QueueGenerator(["plan fixed"]);

  const result = await workflow(gateway, store, generator, new QueueReviewer([{ verdict: "pass", findings: [] }])).start(startInput());

  assert.equal(result.status, "ready");
  assert.deepEqual(generator.calls.map((call) => `${call.mode}:${call.artifact.id}`), ["revise:implementation-plan"]);
  assert.equal(store.files.get("openspec/changes/custom/intent.md"), "intent");
});

test("validation failure without deterministic target fails non-ready", async () => {
  const gateway = new FakeOpenSpecGateway([[artifact("intent", "openspec/changes/custom/intent.md", "complete")]], [false]);
  gateway.validate = async function validate() {
    this.validationCalls += 1;
    return ok(this.statuses.at(-1) ?? [], {
      valid: false,
      exitCode: 1,
      findings: [{ message: "Unknown structural error." }],
      stdout: "{}",
      stderr: "",
      raw: { valid: false },
    });
  };

  const result = await workflow(gateway, new MemoryArtifacts(), new QueueGenerator([]), new QueueReviewer([])).start(startInput());

  assert.equal(result.status, "failed");
  assert.equal(result.state.failure?.code, "validation-target-unknown");
});

test("multiple needs_input findings become deduplicated interview gaps", async () => {
  const gateway = new FakeOpenSpecGateway([
    [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
  ]);
  const reviewer = new QueueReviewer([
    {
      verdict: "needs_input",
      findings: [
        {
          id: "runtime",
          severity: "error",
          artifactId: "intent",
          issue: "Runtime missing.",
          reason: "Runtime matters.",
          suggestedQuestion: "Where will this run?",
        },
        {
          id: "scale",
          severity: "error",
          artifactId: "intent",
          issue: "Scale missing.",
          reason: "Scale matters.",
          suggestedQuestion: "What scale is required?",
        },
        {
          id: "runtime",
          severity: "error",
          artifactId: "intent",
          issue: "Runtime missing.",
          reason: "Runtime matters.",
          suggestedQuestion: "Where will this run?",
        },
      ],
    },
  ]);

  const blocked = await workflow(gateway, new MemoryArtifacts(), new QueueGenerator(["intent"]), reviewer).start(startInput());

  assert.equal(blocked.status, "needs-input");
  assert.deepEqual(blocked.state.interview.gaps.map((gap) => gap.id), ["review.runtime", "review.scale"]);
  assert.equal(blocked.state.interview.unresolvedQuestions.length, 1);
});

test("revising a dependency reconsiders downstream generated artifacts only", async () => {
  const gateway = new FakeOpenSpecGateway([
    [
      artifact("intent", "openspec/changes/custom/intent.md", "missing"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "missing", ["intent"]),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing", ["architecture-note"]),
      artifact("unrelated", "openspec/changes/custom/unrelated.md", "missing"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "missing", ["intent"]),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing", ["architecture-note"]),
      artifact("unrelated", "openspec/changes/custom/unrelated.md", "missing"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "complete", ["intent"]),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing", ["architecture-note"]),
      artifact("unrelated", "openspec/changes/custom/unrelated.md", "missing"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "complete", ["intent"]),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete", ["architecture-note"]),
      artifact("unrelated", "openspec/changes/custom/unrelated.md", "missing"),
    ],
    [
      artifact("intent", "openspec/changes/custom/intent.md", "complete"),
      artifact("architecture-note", "openspec/changes/custom/architecture.md", "complete", ["intent"]),
      artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete", ["architecture-note"]),
      artifact("unrelated", "openspec/changes/custom/unrelated.md", "complete"),
    ],
  ]);
  const generator = new QueueGenerator([
    "intent",
    "architecture",
    "plan",
    "unrelated",
    "intent revised",
    "architecture revised",
    "plan revised",
  ]);
  const reviewer = new QueueReviewer([
    {
      verdict: "needs_revision",
      findings: [
        {
          id: "intent",
          severity: "error",
          artifactId: "intent",
          issue: "Intent stale.",
          reason: "Known information was omitted.",
        },
      ],
    },
    { verdict: "pass", findings: [] },
  ]);

  const result = await workflow(gateway, new MemoryArtifacts(), generator, reviewer).start(startInput());

  assert.equal(result.status, "ready");
  assert.deepEqual(generator.calls.map((call) => `${call.mode}:${call.artifact.id}`), [
    "create:intent",
    "create:architecture-note",
    "create:implementation-plan",
    "create:unrelated",
    "revise:intent",
    "revise:architecture-note",
    "revise:implementation-plan",
  ]);
});

test("OpenSpec status or instructions failures before review block reviewer invocation", async () => {
  const statusGateway = new FakeOpenSpecGateway([
    [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
  ]);
  statusGateway.failStatusBeforeReview = true;
  const statusReviewer = new QueueReviewer([{ verdict: "pass", findings: [] }]);
  const statusResult = await workflow(statusGateway, new MemoryArtifacts(), new QueueGenerator(["intent"]), statusReviewer).start(
    startInput(),
  );

  assert.equal(statusResult.status, "failed");
  assert.equal(statusResult.state.failure?.code, "openspec-status-before-review");
  assert.equal(statusReviewer.calls.length, 0);

  const instructionsGateway = new FakeOpenSpecGateway([
    [artifact("intent", "openspec/changes/custom/intent.md", "missing")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete")],
  ]);
  instructionsGateway.failInstructionsBeforeReview = true;
  const instructionsReviewer = new QueueReviewer([{ verdict: "pass", findings: [] }]);
  const instructionsResult = await workflow(
    instructionsGateway,
    new MemoryArtifacts(),
    new QueueGenerator(["intent"]),
    instructionsReviewer,
  ).start(startInput());

  assert.equal(instructionsResult.status, "failed");
  assert.equal(instructionsResult.state.failure?.code, "openspec-instructions-before-review");
  assert.equal(instructionsReviewer.calls.length, 0);
});

test("dependency path-rejected and read-failed fail safely without cached fallback", async () => {
  for (const failureStatus of ["path-rejected", "read-failed"] as const) {
    const store = new MemoryArtifacts();
    const dependencyPath = "openspec/changes/custom/intent.md";
    store.readFailures.set(dependencyPath, failureStatus);
    store.readFailureAfterReads.set(dependencyPath, 1);
    const result = await workflow(
      new FakeOpenSpecGateway([
        [
          artifact("intent", dependencyPath, "missing"),
          artifact("architecture-note", "openspec/changes/custom/architecture.md", "missing", ["intent"]),
        ],
        [
          artifact("intent", dependencyPath, "complete"),
          artifact("architecture-note", "openspec/changes/custom/architecture.md", "missing", ["intent"]),
        ],
      ]),
      store,
      new QueueGenerator(["intent", "architecture"]),
      new QueueReviewer([{ verdict: "pass", findings: [] }]),
    ).start(startInput());

    assert.equal(result.status, "failed");
    assert.equal(result.state.failure?.code, `artifact-read-${failureStatus}`);
  }
});

test("model generator and reviewer use separate fresh model requests", async () => {
  const { ModelArtifactGenerator, ModelSpecReviewer } = await import("../src/index.ts");
  const model = new RecordingModel(["artifact body", JSON.stringify({ verdict: "pass", findings: [] })]);
  const generator = new ModelArtifactGenerator(model, { model: "specifier" });
  const reviewer = new ModelSpecReviewer(model, { model: "specifier" });

  await generator.generate({
    mode: "create",
    artifact: artifact("intent", "intent.md", "missing"),
    interview: readySession(),
    instructions: { write: "intent" },
    dependencies: [],
  });
  await reviewer.review({
    projectRoot: "/project",
    changeName: "custom",
    interview: readySession(),
    artifacts: [{ artifactId: "intent", path: "intent.md", content: "artifact body" }],
    status: {},
    instructions: {},
    validation: { valid: true, exitCode: 0, findings: [], stdout: "{}", stderr: "", raw: {} },
  });

  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[0]?.purpose, "artifact-generation");
  assert.equal(model.requests[1]?.purpose, "spec-review");
  assert.notDeepEqual(model.requests[0]?.messages, model.requests[1]?.messages);
});

function workflow(
  gateway: OpenSpecGateway,
  store: MemoryArtifacts,
  generator: QueueGenerator,
  reviewer: SpecReviewer,
  options: {
    maxGenerationIterations?: number;
    maxValidationRepairIterations?: number;
    maxReviewIterations?: number;
  } = {},
): SpecificationWorkflow {
  return new SpecificationWorkflow(
    {
      interviewEngine: new FakeInterviewEngine(),
      openSpecGateway: gateway,
      artifactGenerator: generator,
      artifactWriter: store,
      artifactReader: store,
      reviewer,
    },
    { clock: () => new Date("2026-09-18T00:00:00.000Z"), ...options },
  );
}

function startInput() {
  return {
    projectRoot: "/project",
    changeName: "custom",
    roughIdea: "Build a custom capability.",
  };
}

function artifact(id: string, artifactPath: string, status: string, dependencies: string[] = []): OpenSpecArtifact {
  return {
    id,
    path: artifactPath,
    status,
    state: status === "complete" ? "complete" : status === "blocked" ? "blocked" : "pending",
    authority: "workflow",
    dependencies,
    instructions: { artifact: id },
  };
}

class FakeInterviewEngine {
  async start(input: { projectRoot: string; changeName: string; roughIdea: string }) {
    return { session: readySession(input), ready: true, middleware: [] };
  }

  async answer(input: { session: InterviewSession; answer: string }) {
    const session = structuredClone(input.session);
    const question = session.unresolvedQuestions.at(-1);
    if (question) {
      question.answeredAt = "2026-09-18T00:00:00.000Z";
      session.unresolvedQuestions = [];
      session.gaps = session.gaps.map((gap) => (gap.id === question.gapId ? { ...gap, status: "resolved" } : gap));
    }
    session.facts.push({
      id: `fact-${session.facts.length + 1}`,
      label: question ? `answer:${question.gapId}` : "user answer",
      value: input.answer,
      provenance: { source: "user", recordedAt: "2026-09-18T00:00:00.000Z", detail: "Answer" },
    });
    const nextQuestion = ensureExternalGapQuestion(session);
    if (nextQuestion) return { session, question: nextQuestion, ready: false, middleware: [] };
    session.readiness = { ready: true, reason: "External gap resolved.", blockingGaps: [], unresolvedContradictions: [] };
    return { session, ready: true, middleware: [] };
  }

  async addExternalGaps(input: {
    session: InterviewSession;
    gaps: Array<{
      id: string;
      source: "review" | "validation";
      reason: string;
      artifactId?: string;
      suggestedQuestion?: string;
      issue?: string;
    }>;
  }) {
    const session = structuredClone(input.session);
    for (const gapInput of input.gaps) {
      const gapId = `${gapInput.source}.${gapInput.id}`;
      if (session.gaps.some((gap) => gap.id === gapId && gap.status === "open")) continue;
      session.gaps.push({
        id: gapId,
        source: gapInput.source,
        reason: gapInput.reason,
        artifactId: gapInput.artifactId,
        suggestedQuestion: gapInput.suggestedQuestion,
        status: "open",
        provenance: { source: gapInput.source, recordedAt: "2026-09-18T00:00:00.000Z", detail: gapInput.issue },
      });
    }
    const question = ensureExternalGapQuestion(session);
    return { session, question, ready: false, middleware: [] };
  }
}

function ensureExternalGapQuestion(session: InterviewSession) {
  const openGaps = session.gaps.filter((gap) => gap.status === "open");
  if (openGaps.length === 0) return undefined;
  session.readiness = {
    ready: false,
    reason: "Externally discovered material gaps must be resolved before proceeding.",
    blockingGaps: openGaps.map((gap) => gap.id),
    unresolvedContradictions: [],
  };
  const existing = session.unresolvedQuestions.find((question) => openGaps.some((gap) => gap.id === question.gapId));
  if (existing) return existing;
  const gap = openGaps[0];
  const question = {
    id: `question-${gap.id}`,
    text: gap.suggestedQuestion ?? gap.reason,
    why: gap.reason,
    gapId: gap.id,
    askedAt: "2026-09-18T00:00:00.000Z",
  };
  session.questions.push(question);
  session.unresolvedQuestions.push(question);
  return question;
}

class FakeOpenSpecGateway implements OpenSpecGateway {
  validationCalls = 0;
  private statusIndex = 0;
  private readonly statuses: OpenSpecArtifact[][];
  private readonly validationResults: boolean[];
  failStatusBeforeReview = false;
  failInstructionsBeforeReview = false;

  constructor(statuses: OpenSpecArtifact[][], validationResults: boolean[] = [true]) {
    this.statuses = statuses;
    this.validationResults = validationResults;
  }

  async createChange(): Promise<OpenSpecGatewayResult> {
    return ok([]);
  }

  async getStatus(): Promise<OpenSpecGatewayResult> {
    if (this.failStatusBeforeReview && this.validationCalls > 0) return failure("status exploded");
    const current = this.statuses[Math.min(this.statusIndex, this.statuses.length - 1)] ?? [];
    this.statusIndex += 1;
    return ok(current);
  }

  async getInstructions(): Promise<OpenSpecGatewayResult> {
    if (this.failInstructionsBeforeReview && this.validationCalls > 0) return failure("instructions exploded");
    return ok(this.statuses.at(-1) ?? []);
  }

  async getArtifactInstructions(input: { artifactId: string }): Promise<OpenSpecGatewayResult> {
    const artifact = this.statuses.flat().find((item) => item.id === input.artifactId);
    return ok(artifact ? [artifact] : []);
  }

  async validate(): Promise<OpenSpecGatewayResult> {
    const valid = this.validationResults[Math.min(this.validationCalls, this.validationResults.length - 1)] ?? true;
    this.validationCalls += 1;
    return ok(this.statuses.at(-1) ?? [], {
      valid,
      exitCode: valid ? 0 : 1,
      findings: valid ? [] : [{ artifactId: "intent", message: "invalid", raw: { valid } }],
      stdout: valid ? "{}" : '{"valid":false}',
      stderr: valid ? "" : "invalid",
      raw: { valid },
    });
  }
}

class MemoryArtifacts implements ArtifactWriter, ArtifactReader {
  files = new Map<string, string>();
  writes: WriteArtifactInput[] = [];
  readFailures = new Map<string, "path-rejected" | "read-failed">();
  readFailureAfterReads = new Map<string, number>();

  async write(input: WriteArtifactInput) {
    this.writes.push({ ...input });
    if (input.overwrite !== true && this.files.has(input.path)) {
      return { ok: false, status: "conflict" as const, error: { code: "conflict" as const, message: "exists" }, middleware: {} };
    }
    this.files.set(input.path, input.content);
    return {
      ok: true,
      status: "written" as const,
      path: input.path,
      absolutePath: input.path,
      bytesWritten: input.content.length,
      middleware: {},
    };
  }

  async read(input: { path: string }) {
    const failureStatus = this.readFailures.get(input.path);
    if (failureStatus) {
      const remainingSuccessfulReads = this.readFailureAfterReads.get(input.path) ?? 0;
      if (remainingSuccessfulReads <= 0) {
        return { ok: false, status: failureStatus, error: { code: failureStatus, message: failureStatus } };
      }
      this.readFailureAfterReads.set(input.path, remainingSuccessfulReads - 1);
    }
    const content = this.files.get(input.path);
    if (content === undefined) {
      return { ok: false, status: "not-found" as const, error: { code: "not-found" as const, message: "missing" } };
    }
    return { ok: true, status: "read" as const, path: input.path, absolutePath: input.path, content };
  }
}

class QueueGenerator {
  calls: GenerateArtifactInput[] = [];
  private readonly contents: string[];

  constructor(contents: string[]) {
    this.contents = contents;
  }

  async generate(input: GenerateArtifactInput): Promise<GeneratedArtifact> {
    this.calls.push(structuredClone(input));
    return { artifactId: input.artifact.id, content: this.contents.shift() ?? `${input.artifact.id} content` };
  }
}

class QueueReviewer implements SpecReviewer {
  calls: Parameters<SpecReviewer["review"]>[0][] = [];
  private readonly reviews: SpecReview[];

  constructor(reviews: SpecReview[]) {
    this.reviews = reviews;
  }

  async review(input: Parameters<SpecReviewer["review"]>[0]): Promise<SpecReview> {
    this.calls.push(structuredClone(input));
    const review = this.reviews.shift();
    if (!review) throw new Error("No queued review");
    return review;
  }
}

class RecordingModel {
  requests: unknown[] = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async complete(request: unknown) {
    this.requests.push(structuredClone(request));
    return { content: this.responses.shift() ?? "{}" };
  }
}

function readySession(input = startInput()): InterviewSession {
  return {
    id: "session-1",
    projectRoot: input.projectRoot,
    changeName: input.changeName,
    roughIdea: input.roughIdea,
    turnCount: 0,
    openspec: { gatewayResults: {} },
    facts: [
      {
        id: "fact-1",
        label: "rough feature idea",
        value: input.roughIdea,
        provenance: { source: "user", recordedAt: "2026-09-18T00:00:00.000Z" },
      },
    ],
    assumptions: [],
    choices: [],
    questions: [],
    unresolvedQuestions: [],
    gaps: [],
    contradictions: [],
    readiness: { ready: true, reason: "Enough information.", blockingGaps: [], unresolvedContradictions: [] },
  };
}

function ok(
  artifacts: OpenSpecArtifact[],
  validation?: NonNullable<OpenSpecGatewayResult["context"]>["openspec"]["validation"],
): OpenSpecGatewayResult {
  return {
    ok: validation?.valid ?? true,
    status: validation ? (validation.valid ? "valid" : "invalid") : "status-read",
    context: {
      system: "openspec",
      projectRoot: "/project",
      changeName: "custom",
      openspec: {
        artifacts,
        status: { normalized: { artifacts, metadata: {} }, raw: { artifacts }, stdout: "{}", stderr: "", exitCode: 0 },
        instructions: { normalized: { artifacts, metadata: {} }, raw: { artifacts }, stdout: "{}", stderr: "", exitCode: 0 },
        ...(validation ? { validation } : {}),
      },
    },
    middleware: {},
  };
}

function failure(message: string): OpenSpecGatewayResult {
  return {
    ok: false,
    status: "command-failed",
    error: { code: "command-failed", message },
    middleware: {},
  };
}
