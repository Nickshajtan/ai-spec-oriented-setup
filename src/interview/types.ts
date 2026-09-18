import type { MiddlewareExecution } from "../middleware/types.ts";
import type { OpenSpecGatewayResult, SpecContext } from "../openspec/types.ts";

export type KnowledgeSource = "user" | "model" | "openspec" | "review" | "validation" | "system";

export interface Provenance {
  source: KnowledgeSource;
  recordedAt: string;
  detail?: string;
}

export interface InterviewFact {
  id: string;
  label: string;
  value: string;
  provenance: Provenance;
  supersededBy?: string;
}

export interface InterviewAssumption {
  id: string;
  statement: string;
  status: "proposed" | "accepted" | "rejected";
  provenance: Provenance;
}

export interface InterviewChoice {
  id: string;
  questionId: string;
  value: string;
  provenance: Provenance;
}

export interface InterviewQuestion {
  id: string;
  text: string;
  why: string;
  gapId: string;
  candidateChoices?: string[];
  askedAt: string;
  answeredAt?: string;
}

export interface InterviewGap {
  id: string;
  source: "planner" | "review" | "validation";
  reason: string;
  artifactId?: string;
  suggestedQuestion?: string;
  status: "open" | "resolved";
  provenance: Provenance;
}

export interface InterviewContradiction {
  id: string;
  description: string;
  factIds: string[];
  status: "unresolved" | "resolved";
  resolution?: string;
  provenance: Provenance;
}

export interface InterviewReadiness {
  ready: boolean;
  reason: string;
  blockingGaps: string[];
  unresolvedContradictions: string[];
}

export interface InterviewOpenSpecContext {
  status?: unknown;
  instructions?: unknown;
  specContext?: SpecContext;
  gatewayResults: {
    createChange?: OpenSpecGatewayResult;
    status?: OpenSpecGatewayResult;
    instructions?: OpenSpecGatewayResult;
  };
}

export interface InterviewSession {
  id: string;
  projectRoot: string;
  changeName: string;
  roughIdea: string;
  turnCount: number;
  openspec: InterviewOpenSpecContext;
  facts: InterviewFact[];
  assumptions: InterviewAssumption[];
  choices: InterviewChoice[];
  questions: InterviewQuestion[];
  unresolvedQuestions: InterviewQuestion[];
  gaps: InterviewGap[];
  contradictions: InterviewContradiction[];
  readiness: InterviewReadiness;
}

export interface CandidateQuestion {
  text: string;
  why: string;
  gapId: string;
  candidateChoices?: string[];
}

export interface QuestionPlan {
  missingMaterialInfo: boolean;
  nextQuestion?: CandidateQuestion;
  addressedGapId?: string;
  readiness: InterviewReadiness;
}

export interface QuestionPlanner {
  plan(session: InterviewSession): Promise<QuestionPlan>;
}

export interface StartInterviewInput {
  projectRoot: string;
  changeName: string;
  roughIdea: string;
  description?: string;
  goal?: string;
  schema?: string;
}

export interface AnswerInterviewInput {
  session: InterviewSession;
  answer: string;
  acceptedAssumptionIds?: string[];
  rejectedAssumptionIds?: string[];
}

export interface InterviewStepResult {
  session: InterviewSession;
  question?: InterviewQuestion;
  ready: boolean;
  middleware: MiddlewareExecution[];
}
