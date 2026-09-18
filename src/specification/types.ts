import type { ArtifactReader, ArtifactWriter } from "../artifact-writer/types.ts";
import type { MiddlewareExecution } from "../middleware/types.ts";
import type { ModelPort } from "../model/types.ts";
import type { OpenSpecArtifact, OpenSpecGateway, OpenSpecValidation } from "../openspec/types.ts";
import type { InterviewEngine } from "../interview/interview-engine.ts";
import type { InterviewFact, InterviewSession } from "../interview/types.ts";

export type GenerationMode = "create" | "revise";

export interface GeneratedArtifactContext {
  artifactId: string;
  path: string;
  content: string;
}

export interface GenerateArtifactInput {
  mode: GenerationMode;
  artifact: OpenSpecArtifact;
  instructions?: unknown;
  interview: InterviewSession;
  dependencies: GeneratedArtifactContext[];
  currentContent?: string;
  findings?: ReviewFinding[];
}

export interface GeneratedArtifact {
  artifactId: string;
  content: string;
}

export interface ArtifactGenerator {
  generate(input: GenerateArtifactInput): Promise<GeneratedArtifact>;
}

export type ReviewVerdict = "pass" | "needs_revision" | "needs_input";

export interface ReviewFinding {
  id: string;
  severity: "error" | "warning";
  artifactId?: string;
  issue: string;
  reason: string;
  category?: "missing-requirement" | "contradiction" | "ambiguity" | "openspec-compliance" | "implementation-readiness" | "consistency";
  suggestedQuestion?: string;
}

export interface SpecReview {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  summary?: string;
}

export interface SpecReviewInput {
  projectRoot: string;
  changeName: string;
  interview: InterviewSession;
  artifacts: GeneratedArtifactContext[];
  status: unknown;
  instructions: unknown;
  validation: OpenSpecValidation;
}

export interface SpecReviewer {
  review(input: SpecReviewInput): Promise<SpecReview>;
}

export interface GenerationState {
  artifacts: GeneratedArtifactContext[];
  attempts: number;
  lastArtifactId?: string;
}

export interface ReviewState {
  attempts: SpecReview[];
  latest?: SpecReview;
}

export type SpecificationWorkflowStatus =
  | "interview"
  | "generating"
  | "validating"
  | "reviewing"
  | "needs-input"
  | "needs-revision"
  | "ready"
  | "failed";

export interface SpecificationWorkflowState {
  projectRoot: string;
  changeName: string;
  interview: InterviewSession;
  generation: GenerationState;
  validation?: OpenSpecValidation;
  review: ReviewState;
  status: SpecificationWorkflowStatus;
  failure?: {
    code: string;
    message: string;
    cause?: unknown;
  };
}

export interface SpecificationWorkflowResult {
  status: SpecificationWorkflowStatus;
  state: SpecificationWorkflowState;
  question?: InterviewSession["unresolvedQuestions"][number];
  ready: boolean;
  middleware: MiddlewareExecution[];
}

export interface StartSpecificationWorkflowInput {
  projectRoot: string;
  changeName: string;
  roughIdea: string;
  description?: string;
  goal?: string;
  schema?: string;
}

export interface AnswerSpecificationWorkflowInput {
  state: SpecificationWorkflowState;
  answer: string;
  acceptedAssumptionIds?: string[];
  rejectedAssumptionIds?: string[];
}

export interface SpecificationWorkflowOptions {
  maxGenerationIterations?: number;
  maxReviewIterations?: number;
}

export interface SpecificationWorkflowDependencies {
  interviewEngine: InterviewEngine;
  openSpecGateway: OpenSpecGateway;
  artifactGenerator: ArtifactGenerator;
  artifactWriter: ArtifactWriter;
  artifactReader: ArtifactReader;
  reviewer: SpecReviewer;
}

export interface ModelArtifactGeneratorConfig {
  model: string;
  parameters?: Parameters<ModelPort["complete"]>[0]["parameters"];
}

export interface ModelSpecReviewerConfig {
  model: string;
  parameters?: Parameters<ModelPort["complete"]>[0]["parameters"];
}

export type ReviewGapSource = "review" | "validation";

export interface ExternalGapInput {
  source: ReviewGapSource;
  finding: ReviewFinding;
  recordedAt: string;
}

export interface ActiveInterviewFact extends InterviewFact {
  supersededBy?: undefined;
}
