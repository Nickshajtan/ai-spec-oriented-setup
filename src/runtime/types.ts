import type { InterviewQuestion } from "../interview/types.ts";
import type { OpenSpecValidation } from "../openspec/types.ts";
import type { GeneratedArtifactContext, SpecReview, SpecificationWorkflowState } from "../specification/types.ts";

export interface StartSpecificationInput {
  projectRoot: string;
  roughIdea: string;
  changeName?: string;
  description?: string;
  goal?: string;
  schema?: string;
}

export interface AnswerSpecificationInput {
  projectRoot: string;
  sessionId: string;
  answer: string;
  acceptedAssumptionIds?: string[];
  rejectedAssumptionIds?: string[];
}

export interface RuntimeSessionInput {
  projectRoot: string;
  sessionId: string;
}

export interface RuntimeFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type RuntimeResult =
  | {
      status: "needs-input";
      sessionId: string;
      changeName: string;
      question: InterviewQuestion;
      state: SpecificationWorkflowState;
    }
  | {
      status: "ready";
      sessionId: string;
      changeName: string;
      changePath: string;
      artifacts: GeneratedArtifactContext[];
      validation: OpenSpecValidation;
      review: SpecReview;
      state: SpecificationWorkflowState;
    }
  | {
      status: "failed";
      sessionId?: string;
      changeName?: string;
      error: RuntimeFailure;
      state?: SpecificationWorkflowState;
    };

export interface SpecifierRuntime {
  start(input: StartSpecificationInput): Promise<RuntimeResult>;
  answer(input: AnswerSpecificationInput): Promise<RuntimeResult>;
  status(input: RuntimeSessionInput): Promise<RuntimeResult>;
}
