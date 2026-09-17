import assert from "node:assert/strict";
import test from "node:test";
import { InterviewEngine, MiddlewareBus, ModelQuestionPlanner, createLimitsGuard } from "../src/index.ts";
import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  OpenSpecGateway,
  OpenSpecGatewayResult,
  QuestionPlan,
  QuestionPlanner,
  SpecContext,
} from "../src/index.ts";

const specContext: SpecContext = {
  system: "openspec",
  projectRoot: "/project",
  changeName: "add-redis-cache",
  openspec: {
    status: {
      nextArtifacts: ["capability-proposal"],
      customSchema: true,
    },
    instructions: {
      artifact: "capability-proposal",
      requires: ["runtime environment", "scale", "invalidation behavior", "failure behavior"],
      dependencyArtifacts: ["product-context.md"],
    },
    artifacts: {
      specs: [],
      other: [{ kind: "custom", path: "openspec/changes/add-redis-cache/product-context.md", absolutePath: "/project/file" }],
    },
  },
};

class FakeGateway implements OpenSpecGateway {
  calls: string[] = [];

  async createChange(): Promise<OpenSpecGatewayResult> {
    this.calls.push("createChange");
    return ok("created");
  }

  async getStatus(): Promise<OpenSpecGatewayResult> {
    this.calls.push("getStatus");
    return ok("status-read");
  }

  async getInstructions(): Promise<OpenSpecGatewayResult> {
    this.calls.push("getInstructions");
    return ok("instructions-read");
  }

  async validate(): Promise<OpenSpecGatewayResult> {
    this.calls.push("validate");
    return ok("valid");
  }
}

class QueuePlanner implements QuestionPlanner {
  sessions: unknown[] = [];
  private readonly plans: QuestionPlan[];

  constructor(plans: QuestionPlan[]) {
    this.plans = plans;
  }

  async plan(session: Parameters<QuestionPlanner["plan"]>[0]): Promise<QuestionPlan> {
    this.sessions.push(structuredClone(session));
    const plan = this.plans.shift();
    if (!plan) throw new Error("No queued plan");
    return plan;
  }
}

test("starts session, inspects OpenSpec, and asks adaptive first question", async () => {
  const gateway = new FakeGateway();
  const planner = new QueuePlanner([
    questionPlan("runtime", "Where will this change run?", "Runtime affects compatibility and deployment constraints."),
  ]);

  const result = await engine(gateway, planner).start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });

  assert.equal(result.ready, false);
  assert.equal(result.question?.text, "Where will this change run?");
  assert.deepEqual(gateway.calls, ["createChange", "getStatus", "getInstructions"]);
  assert.equal(result.session.facts[0]?.provenance.source, "user");
  assert.equal(result.session.facts[0]?.value, "Add Redis caching to WordPress REST responses.");
  assert.deepEqual(result.session.openspec.instructions, specContext.openspec.instructions);
  assert.ok(planner.sessions.length === 1);
});

test("integrates answer as explicit user fact and asks follow-up", async () => {
  const planner = new QueuePlanner([
    questionPlan("runtime", "Where will this change run?", "Runtime matters."),
    questionPlan("scale", "What scale must it support?", "Scale affects cache design."),
  ]);
  const first = await engine(new FakeGateway(), planner).start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });
  const second = await engine(new FakeGateway(), planner).answer({
    session: first.session,
    answer: "Existing WordPress multisite.",
  });

  assert.equal(second.question?.text, "What scale must it support?");
  const answerFact = second.session.facts.at(-1);
  assert.equal(answerFact?.label, "answer:runtime");
  assert.equal(answerFact?.value, "Existing WordPress multisite.");
  assert.equal(answerFact?.provenance.source, "user");
  assert.equal(second.session.unresolvedQuestions.length, 1);
  assert.equal(second.session.questions[0]?.answeredAt !== undefined, true);
});

test("preserves contradictions instead of overwriting earlier facts", async () => {
  const planner = new QueuePlanner([
    questionPlan("failure", "What should happen if Redis is unavailable?", "Failure behavior affects acceptance criteria."),
    questionPlan("failure", "These answers conflict. Which failure behavior is authoritative?", "Contradiction blocks readiness."),
    questionPlan("failure", "These answers conflict. Which failure behavior is authoritative?", "Contradiction blocks readiness."),
  ]);
  const first = await engine(new FakeGateway(), planner).start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });
  const second = await engine(new FakeGateway(), planner).answer({
    session: first.session,
    answer: "Fall back to the database.",
  });
  const third = await engine(new FakeGateway(), planner).answer({
    session: second.session,
    answer: "Return HTTP 503.",
  });

  assert.equal(third.session.contradictions.length, 1);
  assert.equal(third.session.contradictions[0]?.status, "unresolved");
  assert.equal(third.session.readiness.ready, false);
  assert.equal(third.question?.gapId, "failure");
});

test("resolves material contradictions through a follow-up answer", async () => {
  const planner = new QueuePlanner([
    questionPlan("failure", "What should happen if Redis is unavailable?", "Failure behavior affects acceptance criteria."),
    questionPlan("failure", "These answers conflict. Which failure behavior is authoritative?", "Contradiction blocks readiness."),
    questionPlan("failure", "These answers conflict. Which failure behavior is authoritative?", "Contradiction blocks readiness."),
    readyPlan("The failure behavior contradiction has been resolved."),
  ]);
  const interview = engine(new FakeGateway(), planner);
  const first = await interview.start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });
  const second = await interview.answer({ session: first.session, answer: "Fall back to the database." });
  const third = await interview.answer({ session: second.session, answer: "Return HTTP 503." });
  const resolved = await interview.answer({ session: third.session, answer: "Fall back to the database." });

  assert.equal(resolved.ready, true);
  assert.equal(resolved.session.contradictions[0]?.status, "resolved");
  assert.equal(resolved.session.contradictions[0]?.resolution, "Fall back to the database.");
  assert.equal(resolved.session.readiness.unresolvedContradictions.length, 0);
  assert.ok(resolved.session.facts.some((fact) => fact.supersededBy !== undefined));
});

test("eventually reaches explainable readiness from OpenSpec-driven requirements", async () => {
  const planner = new QueuePlanner([
    questionPlan("runtime", "Where will this change run?", "Runtime matters."),
    questionPlan("scale", "What scale must it support?", "Scale matters."),
    questionPlan("invalidation", "How should cached responses be invalidated?", "Invalidation defines correctness."),
    questionPlan("failure", "What should happen if Redis is unavailable?", "Failure behavior affects acceptance criteria."),
    readyPlan("Required runtime, scale, invalidation, and failure behavior are known."),
  ]);
  const interview = engine(new FakeGateway(), planner);
  const started = await interview.start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });
  const runtime = await interview.answer({ session: started.session, answer: "Existing WordPress multisite." });
  const scale = await interview.answer({ session: runtime.session, answer: "Approximately 3000 sites." });
  const invalidation = await interview.answer({ session: scale.session, answer: "Per site and resource." });
  const failure = await interview.answer({ session: invalidation.session, answer: "Fall back to the database." });

  assert.equal(failure.ready, true);
  assert.equal(failure.question, undefined);
  assert.equal(failure.session.readiness.ready, true);
  assert.match(failure.session.readiness.reason, /runtime, scale, invalidation, and failure/);
  assert.equal(failure.session.facts.length, 5);
});

test("emits interview lifecycle events that middleware can observe", async () => {
  const bus = new MiddlewareBus();
  const events: string[] = [];
  for (const eventName of ["interview.started", "interview.question.planned", "interview.gap.detected"] as const) {
    bus.use(eventName, {
      id: `${eventName}-observer`,
      type: "observer",
      priority: 1,
      handler(context) {
        events.push(context.event.name);
      },
    });
  }

  await engine(
    new FakeGateway(),
    new QueuePlanner([questionPlan("runtime", "Where will this change run?", "Runtime matters.")]),
    bus,
  ).start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });

  assert.deepEqual(events, ["interview.started", "interview.question.planned", "interview.gap.detected"]);
});

test("limits guard can stop runaway interview turns without core depending on middleware", async () => {
  const bus = new MiddlewareBus();
  bus.use("interview.turn.before", createLimitsGuard({ maxInterviewTurns: 0 }));

  const result = await engine(
    new FakeGateway(),
    new QueuePlanner([questionPlan("runtime", "Where will this change run?", "Runtime matters.")]),
    bus,
  ).start({
    projectRoot: "/project",
    changeName: "add-redis-cache",
    roughIdea: "Add Redis caching to WordPress REST responses.",
  });

  assert.equal(result.ready, false);
  assert.equal(result.question, undefined);
  assert.equal(result.middleware.at(-1)?.result.action, "deny");
});

test("model question planner sends structured session and parses structured output", async () => {
  const model = new FakeModel(
    JSON.stringify({
      missingMaterialInfo: true,
      nextQuestion: {
        text: "How should cached responses be invalidated?",
        why: "Invalidation determines correctness.",
        gapId: "invalidation",
        candidateChoices: ["per site", "per resource"],
      },
      readiness: {
        ready: false,
        reason: "Invalidation behavior is missing.",
        blockingGaps: ["invalidation"],
        unresolvedContradictions: [],
      },
    }),
  );
  const planner = new ModelQuestionPlanner(model, { model: "specifier-interviewer" });
  const session = (
    await engine(new FakeGateway(), new QueuePlanner([questionPlan("runtime", "Where will this change run?", "Runtime matters.")])).start({
      projectRoot: "/project",
      changeName: "add-redis-cache",
      roughIdea: "Add Redis caching to WordPress REST responses.",
    })
  ).session;

  const plan = await planner.plan(session);

  assert.equal(plan.nextQuestion?.gapId, "invalidation");
  assert.equal(model.requests[0]?.purpose, "interview");
  assert.equal(model.requests[0]?.model, "specifier-interviewer");
  assert.match(model.requests[0]?.messages[0]?.content ?? "", /OpenSpec-aware/);
  assert.match(model.requests[0]?.messages[1]?.content ?? "", /capability-proposal/);
});

class FakeModel implements ModelPort {
  requests: ModelRequest[] = [];
  private readonly content: string;

  constructor(content: string) {
    this.content = content;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return { content: this.content };
  }
}

function engine(gateway: OpenSpecGateway, planner: QuestionPlanner, bus?: MiddlewareBus): InterviewEngine {
  let next = 0;
  return new InterviewEngine(gateway, planner, {
    bus,
    idFactory() {
      next += 1;
      return String(next);
    },
    clock() {
      return new Date("2026-09-18T00:00:00.000Z");
    },
  });
}

function ok(status: OpenSpecGatewayResult["status"]): OpenSpecGatewayResult {
  return {
    ok: true,
    status,
    context: specContext,
    middleware: {},
  };
}

function questionPlan(gapId: string, text: string, why: string): QuestionPlan {
  return {
    missingMaterialInfo: true,
    nextQuestion: { text, why, gapId },
    readiness: {
      ready: false,
      reason: `${gapId} is missing.`,
      blockingGaps: [gapId],
      unresolvedContradictions: [],
    },
  };
}

function readyPlan(reason: string): QuestionPlan {
  return {
    missingMaterialInfo: false,
    readiness: {
      ready: true,
      reason,
      blockingGaps: [],
      unresolvedContradictions: [],
    },
  };
}
