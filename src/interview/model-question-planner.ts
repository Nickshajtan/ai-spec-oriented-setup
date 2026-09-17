import type { ModelPort } from "../model/types.ts";
import { parseModelJson } from "../model/structured-output.ts";
import type { InterviewSession, QuestionPlan, QuestionPlanner } from "./types.ts";

export interface ModelQuestionPlannerConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class ModelQuestionPlanner implements QuestionPlanner {
  private readonly model: ModelPort;
  private readonly config: ModelQuestionPlannerConfig;

  constructor(model: ModelPort, config: ModelQuestionPlannerConfig) {
    this.model = model;
    this.config = config;
  }

  async plan(session: InterviewSession): Promise<QuestionPlan> {
    const response = await this.model.complete({
      model: this.config.model,
      purpose: "interview",
      parameters: {
        temperature: this.config.temperature ?? 0,
        maxTokens: this.config.maxTokens,
      },
      messages: [
        {
          role: "system",
          content: [
            "You are planning an OpenSpec-aware feature specification interview.",
            "Ask one focused question only when material information is missing.",
            "Do not use confidence scores.",
            "Return only JSON matching the requested shape.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            responseShape: {
              missingMaterialInfo: "boolean",
              nextQuestion: {
                text: "string",
                why: "string",
                gapId: "string",
                candidateChoices: ["optional string array"],
              },
              readiness: {
                ready: "boolean",
                reason: "string",
                blockingGaps: ["string array"],
                unresolvedContradictions: ["string array"],
              },
            },
            session: plannerView(session),
          }),
        },
      ],
      metadata: {
        sessionId: session.id,
        changeName: session.changeName,
      },
    });

    return normalizePlan(parseModelJson(response.content));
  }
}

function plannerView(session: InterviewSession): unknown {
  return {
    id: session.id,
    roughIdea: session.roughIdea,
    openspec: {
      status: session.openspec.status,
      instructions: session.openspec.instructions,
      artifacts: session.openspec.specContext?.openspec.artifacts,
      metadata: session.openspec.specContext?.openspec.metadata,
    },
    facts: session.facts.filter((fact) => fact.supersededBy === undefined),
    assumptions: session.assumptions,
    choices: session.choices,
    unresolvedQuestions: session.unresolvedQuestions,
    contradictions: session.contradictions.filter((contradiction) => contradiction.status === "unresolved"),
    readiness: session.readiness,
  };
}

function normalizePlan(value: Record<string, unknown>): QuestionPlan {
  const readiness = normalizeReadiness(value.readiness);
  const missingMaterialInfo = value.missingMaterialInfo === true;
  const nextQuestion = normalizeQuestion(value.nextQuestion);

  if (missingMaterialInfo && !nextQuestion) {
    throw new Error("Question planner reported missing information without a next question.");
  }

  return {
    missingMaterialInfo,
    ...(nextQuestion ? { nextQuestion } : {}),
    readiness,
  };
}

function normalizeReadiness(value: unknown): QuestionPlan["readiness"] {
  if (!isObject(value)) {
    return {
      ready: false,
      reason: "Planner did not provide readiness details.",
      blockingGaps: ["planner.readiness.missing"],
      unresolvedContradictions: [],
    };
  }

  return {
    ready: value.ready === true,
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : "No readiness reason supplied.",
    blockingGaps: stringArray(value.blockingGaps),
    unresolvedContradictions: stringArray(value.unresolvedContradictions),
  };
}

function normalizeQuestion(value: unknown): QuestionPlan["nextQuestion"] {
  if (!isObject(value)) return undefined;
  if (typeof value.text !== "string" || typeof value.why !== "string" || typeof value.gapId !== "string") return undefined;
  if (!value.text.trim() || !value.why.trim() || !value.gapId.trim()) return undefined;

  return {
    text: value.text,
    why: value.why,
    gapId: value.gapId,
    candidateChoices: stringArray(value.candidateChoices),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
