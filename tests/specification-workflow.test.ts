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
    [artifact("intent", "openspec/changes/custom/intent.md", "missing"), artifact("architecture-note", "openspec/changes/custom/architecture.md", "blocked", ["intent"])],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete"), artifact("architecture-note", "openspec/changes/custom/architecture.md", "missing", ["intent"])],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete"), artifact("architecture-note", "openspec/changes/custom/architecture.md", "complete", ["intent"])],
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
    [artifact("intent", "openspec/changes/custom/intent.md", "missing"), artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete"), artifact("implementation-plan", "openspec/changes/custom/plan.md", "missing")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete"), artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete")],
    [artifact("intent", "openspec/changes/custom/intent.md", "complete"), artifact("implementation-plan", "openspec/changes/custom/plan.md", "complete")],
  ]);
  const store = new MemoryArtifacts();
  const generator = new QueueGenerator(["intent v1", "plan v1", "plan v2"]);
  const reviewer = new QueueReviewer([
    {
      verdict: "needs_revision",
      findings: [{ id: "plan-missing", severity: "error", artifactId: "implementation-plan", issue: "Plan omitted known fact.", reason: "Known fact was not represented." }],
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
  const blocked = await workflow(noProgress, store, new QueueGenerator(["one", "two"]), new QueueReviewer([{ verdict: "pass", findings: [] }]), {
    maxGenerationIterations: 2,
  }).start(startInput());

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
    new FakeOpenSpecGateway([[artifact("intent", "openspec/changes/custom/intent.md", "missing")], [artifact("intent", "openspec/changes/custom/intent.md", "complete")]]),
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
    new FakeOpenSpecGateway([[artifact("intent", "openspec/changes/custom/intent.md", "missing")], [artifact("intent", "openspec/changes/custom/intent.md", "complete")]]),
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
    validation: { valid: true, exitCode: 0, stdout: "{}", stderr: "", raw: {} },
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
  options: { maxGenerationIterations?: number; maxReviewIterations?: number } = {},
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
    dependencies,
    instructions: { artifact: id },
    metadata: { normalization: "documented" },
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
    }
    session.facts.push({
      id: `fact-${session.facts.length + 1}`,
      label: question ? `answer:${question.gapId}` : "user answer",
      value: input.answer,
      provenance: { source: "user", recordedAt: "2026-09-18T00:00:00.000Z", detail: "Answer" },
    });
    session.readiness = { ready: true, reason: "External gap resolved.", blockingGaps: [], unresolvedContradictions: [] };
    return { session, ready: true, middleware: [] };
  }
}

class FakeOpenSpecGateway implements OpenSpecGateway {
  validationCalls = 0;
  private statusIndex = 0;
  private readonly statuses: OpenSpecArtifact[][];
  private readonly validationResults: boolean[];

  constructor(statuses: OpenSpecArtifact[][], validationResults: boolean[] = [true]) {
    this.statuses = statuses;
    this.validationResults = validationResults;
  }

  async createChange(): Promise<OpenSpecGatewayResult> {
    return ok([]);
  }

  async getStatus(): Promise<OpenSpecGatewayResult> {
    const current = this.statuses[Math.min(this.statusIndex, this.statuses.length - 1)] ?? [];
    this.statusIndex += 1;
    return ok(current);
  }

  async getInstructions(): Promise<OpenSpecGatewayResult> {
    return ok(this.statuses.at(-1) ?? []);
  }

  async getArtifactInstructions(input: { artifactId: string }): Promise<OpenSpecGatewayResult> {
    const artifact = this.statuses.flat().find((item) => item.id === input.artifactId);
    return ok(artifact ? [artifact] : []);
  }

  async validate(): Promise<OpenSpecGatewayResult> {
    const valid = this.validationResults[Math.min(this.validationCalls, this.validationResults.length - 1)] ?? true;
    this.validationCalls += 1;
    return ok(this.statuses.at(-1) ?? [], { valid, exitCode: valid ? 0 : 1, stdout: valid ? "{}" : '{"valid":false}', stderr: valid ? "" : "invalid", raw: { valid } });
  }
}

class MemoryArtifacts implements ArtifactWriter, ArtifactReader {
  files = new Map<string, string>();
  writes: WriteArtifactInput[] = [];

  async write(input: WriteArtifactInput) {
    this.writes.push({ ...input });
    if (input.overwrite !== true && this.files.has(input.path)) {
      return { ok: false, status: "conflict" as const, error: { code: "conflict" as const, message: "exists" }, middleware: {} };
    }
    this.files.set(input.path, input.content);
    return { ok: true, status: "written" as const, path: input.path, absolutePath: input.path, bytesWritten: input.content.length, middleware: {} };
  }

  async read(input: { path: string }) {
    const content = this.files.get(input.path);
    if (content === undefined) return { ok: false, status: "not-found" as const, error: { code: "not-found" as const, message: "missing" } };
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

function ok(artifacts: OpenSpecArtifact[], validation?: OpenSpecGatewayResult["context"]["openspec"]["validation"]): OpenSpecGatewayResult {
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
