import { MiddlewareBus } from "../bus.ts";
import type { MiddlewareExecution } from "../middleware/types.ts";
import type { OpenSpecGateway } from "../openspec/types.ts";
import type {
  AnswerInterviewInput,
  InterviewContradiction,
  InterviewFact,
  InterviewQuestion,
  InterviewReadiness,
  InterviewSession,
  InterviewStepResult,
  Provenance,
  QuestionPlan,
  QuestionPlanner,
  StartInterviewInput,
} from "./types.ts";

export interface InterviewEngineOptions {
  bus?: MiddlewareBus;
  idFactory?: () => string;
  clock?: () => Date;
}

export class InterviewEngine {
  private readonly gateway: OpenSpecGateway;
  private readonly planner: QuestionPlanner;
  private readonly bus: MiddlewareBus;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(gateway: OpenSpecGateway, planner: QuestionPlanner, options: InterviewEngineOptions = {}) {
    this.gateway = gateway;
    this.planner = planner;
    this.bus = options.bus ?? new MiddlewareBus();
    this.idFactory = options.idFactory ?? randomId;
    this.clock = options.clock ?? (() => new Date());
  }

  async start(input: StartInterviewInput): Promise<InterviewStepResult> {
    const createChange = await this.gateway.createChange({
      projectRoot: input.projectRoot,
      changeName: input.changeName,
      title: input.title,
    });
    const status = await this.gateway.getStatus(input);
    const instructions = await this.gateway.getInstructions(input);
    const now = this.now();
    const session: InterviewSession = {
      id: this.idFactory(),
      projectRoot: input.projectRoot,
      changeName: input.changeName,
      roughIdea: input.roughIdea,
      turnCount: 0,
      openspec: {
        status: status.context?.openspec.status,
        instructions: instructions.context?.openspec.instructions,
        specContext: instructions.context ?? status.context ?? createChange.context,
        gatewayResults: { createChange, status, instructions },
      },
      facts: [
        {
          id: this.id("fact"),
          label: "rough feature idea",
          value: input.roughIdea,
          provenance: { source: "user", recordedAt: now, detail: "Initial rough idea" },
        },
      ],
      assumptions: [],
      choices: [],
      questions: [],
      unresolvedQuestions: [],
      contradictions: [],
      readiness: notReady("Interview has not evaluated material OpenSpec requirements yet.", ["interview.initial"]),
    };

    const started = await this.emit("interview.started", session);
    return this.planNext(session, [started]);
  }

  async answer(input: AnswerInterviewInput): Promise<InterviewStepResult> {
    const session = cloneSession(input.session);
    const activeQuestion = session.unresolvedQuestions.at(-1);
    const now = this.now();

    if (activeQuestion) {
      activeQuestion.answeredAt = now;
      session.unresolvedQuestions = session.unresolvedQuestions.filter((question) => question.id !== activeQuestion.id);
    }

    const accepted = new Set(input.acceptedAssumptionIds ?? []);
    const rejected = new Set(input.rejectedAssumptionIds ?? []);
    session.assumptions = session.assumptions.map((assumption) => {
      if (accepted.has(assumption.id)) return { ...assumption, status: "accepted" };
      if (rejected.has(assumption.id)) return { ...assumption, status: "rejected" };
      return assumption;
    });

    const fact = this.answerFact(input.answer, activeQuestion);
    const resolvedContradictions = resolveContradictions(session, fact, activeQuestion);
    const contradiction =
      resolvedContradictions.length > 0
        ? undefined
        : findContradiction(session.facts, fact, activeQuestion, this.provenance("system", "Contradiction detection"));
    session.facts.push(fact);

    if (activeQuestion?.candidateChoices?.length) {
      const selectedChoice = matchingChoice(input.answer, activeQuestion.candidateChoices);
      if (selectedChoice) {
        session.choices.push({
          id: this.id("choice"),
          questionId: activeQuestion.id,
          value: selectedChoice,
          provenance: fact.provenance,
        });
      }
    }

    if (contradiction) {
      session.contradictions.push(contradiction);
      session.readiness = notReady("A material contradiction must be resolved before proceeding.", [activeQuestion?.gapId ?? "interview.contradiction"], [
        contradiction.id,
      ]);
      const acceptedEvent = await this.emit("interview.answer.accepted", session, { answer: input.answer, question: activeQuestion });
      const gapEvent = await this.emit("interview.gap.detected", session, { contradiction });
      return this.planNext(session, [acceptedEvent, gapEvent]);
    }

    const acceptedEvent = await this.emit("interview.answer.accepted", session, { answer: input.answer, question: activeQuestion });
    return this.planNext(session, [acceptedEvent]);
  }

  private async planNext(session: InterviewSession, priorMiddleware: MiddlewareExecution[]): Promise<InterviewStepResult> {
    const before = await this.emit("interview.turn.before", session, undefined, {
      interviewTurn: session.turnCount + 1,
    });
    const middleware = [...priorMiddleware, before];

    if (before.result.action === "deny" || before.result.action === "require-human") {
      return { session, ready: false, middleware };
    }

    const plan = await this.planner.plan(session);
    session.readiness = accountForContradictions(plan.readiness, session);

    if (session.readiness.ready) {
      const readyEvent = await this.emit("interview.ready", session, { readiness: session.readiness });
      const after = await this.emit("interview.turn.after", session);
      return { session, ready: true, middleware: [...middleware, readyEvent, after] };
    }

    if (!plan.missingMaterialInfo || !plan.nextQuestion) {
      const gapEvent = await this.emit("interview.gap.detected", session, { readiness: session.readiness });
      const after = await this.emit("interview.turn.after", session);
      return { session, ready: false, middleware: [...middleware, gapEvent, after] };
    }

    const question = this.questionFromPlan(plan);
    session.turnCount += 1;
    session.questions.push(question);
    session.unresolvedQuestions.push(question);

    const planned = await this.emit("interview.question.planned", session, { question });
    const gap = await this.emit("interview.gap.detected", session, { gapId: question.gapId, question });
    const after = await this.emit("interview.turn.after", session);

    return { session, question, ready: false, middleware: [...middleware, planned, gap, after] };
  }

  private questionFromPlan(plan: QuestionPlan): InterviewQuestion {
    if (!plan.nextQuestion) throw new Error("Cannot create question from a ready plan.");
    return {
      id: this.id("question"),
      text: plan.nextQuestion.text,
      why: plan.nextQuestion.why,
      gapId: plan.nextQuestion.gapId,
      candidateChoices: plan.nextQuestion.candidateChoices,
      askedAt: this.now(),
    };
  }

  private answerFact(answer: string, question?: InterviewQuestion): InterviewFact {
    return {
      id: this.id("fact"),
      label: question ? `answer:${question.gapId}` : "user answer",
      value: answer,
      provenance: this.provenance("user", question ? `Answer to question ${question.id}` : "Unprompted answer"),
    };
  }

  private provenance(source: Provenance["source"], detail: string): Provenance {
    return { source, detail, recordedAt: this.now() };
  }

  private id(prefix: string): string {
    return `${prefix}-${this.idFactory()}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private emit(
    eventName: Parameters<MiddlewareBus["execute"]>[0],
    session: InterviewSession,
    extraMetadata?: Record<string, unknown>,
    lifecycle?: { interviewTurn?: number },
  ): Promise<MiddlewareExecution> {
    return this.bus.execute(eventName, {
      runId: session.id,
      subjectId: session.changeName,
      lifecycle,
      metadata: {
        session,
        ...(extraMetadata ?? {}),
      },
    });
  }
}

function accountForContradictions(readiness: InterviewReadiness, session: InterviewSession): InterviewReadiness {
  const unresolvedContradictions = session.contradictions
    .filter((contradiction) => contradiction.status === "unresolved")
    .map((contradiction) => contradiction.id);
  if (unresolvedContradictions.length === 0) return readiness;

  return {
    ready: false,
    reason: readiness.ready ? "Unresolved contradictions block readiness." : readiness.reason,
    blockingGaps: readiness.blockingGaps.length ? readiness.blockingGaps : ["interview.contradiction"],
    unresolvedContradictions,
  };
}

function findContradiction(
  existingFacts: InterviewFact[],
  nextFact: InterviewFact,
  question: InterviewQuestion | undefined,
  provenance: Provenance,
): InterviewContradiction | undefined {
  if (!question) return undefined;
  const sameLabelFacts = existingFacts.filter((fact) => fact.label === nextFact.label && fact.supersededBy === undefined);
  const conflict = sameLabelFacts.find((fact) => normalizeFactValue(fact.value) !== normalizeFactValue(nextFact.value));
  if (!conflict) return undefined;

  return {
    id: `contradiction-${nextFact.id}`,
    description: `Answer for ${question.gapId} conflicts with earlier information.`,
    factIds: [conflict.id, nextFact.id],
    status: "unresolved",
    provenance,
  };
}

function resolveContradictions(
  session: InterviewSession,
  nextFact: InterviewFact,
  question: InterviewQuestion | undefined,
): InterviewContradiction[] {
  if (!question) return [];

  const questionLabel = `answer:${question.gapId}`;
  const matching = session.contradictions.filter((contradiction) => {
    return (
      contradiction.status === "unresolved" &&
      session.facts.some((fact) => contradiction.factIds.includes(fact.id) && fact.label === questionLabel)
    );
  });
  if (matching.length === 0) return [];

  const resolvedFactIds = new Set(matching.flatMap((contradiction) => contradiction.factIds));
  session.facts = session.facts.map((fact) => (resolvedFactIds.has(fact.id) ? { ...fact, supersededBy: nextFact.id } : fact));
  session.contradictions = session.contradictions.map((contradiction) =>
    matching.some((item) => item.id === contradiction.id)
      ? {
          ...contradiction,
          status: "resolved",
          resolution: nextFact.value,
        }
      : contradiction,
  );

  return matching;
}

function matchingChoice(answer: string, choices: string[]): string | undefined {
  const normalizedAnswer = normalizeFactValue(answer);
  return choices.find((choice) => normalizedAnswer.includes(normalizeFactValue(choice)));
}

function normalizeFactValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function notReady(reason: string, blockingGaps: string[], unresolvedContradictions: string[] = []): InterviewReadiness {
  return {
    ready: false,
    reason,
    blockingGaps,
    unresolvedContradictions,
  };
}

function cloneSession(session: InterviewSession): InterviewSession {
  return structuredClone(session);
}

function randomId(): string {
  return crypto.randomUUID();
}
