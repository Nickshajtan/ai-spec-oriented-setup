import path from "node:path";
import { SpecificationWorkflow } from "../specification/specification-workflow.ts";
import type { SpecificationWorkflowResult, SpecificationWorkflowState } from "../specification/types.ts";
import { RuntimeSessionStore, RuntimeSessionStoreError } from "./session-store.ts";
import type {
  AnswerSpecificationInput,
  RuntimeResult,
  RuntimeSessionInput,
  SpecifierRuntime,
  StartSpecificationInput,
} from "./types.ts";

export interface CoreSpecifierRuntimeOptions {
  workflow: SpecificationWorkflow;
  sessionStore?: RuntimeSessionStore;
  idFactory?: () => string;
}

export class CoreSpecifierRuntime implements SpecifierRuntime {
  private readonly workflow: SpecificationWorkflow;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly idFactory: () => string;

  constructor(options: CoreSpecifierRuntimeOptions) {
    this.workflow = options.workflow;
    this.sessionStore = options.sessionStore ?? new RuntimeSessionStore();
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async start(input: StartSpecificationInput): Promise<RuntimeResult> {
    try {
      const result = await this.workflow.start({
        ...input,
        changeName: input.changeName ?? changeNameFromIdea(input.roughIdea, this.idFactory()),
      });
      await this.sessionStore.save(input.projectRoot, result.state);
      return runtimeResult(result);
    } catch (error) {
      return failedFromError(error);
    }
  }

  async answer(input: AnswerSpecificationInput): Promise<RuntimeResult> {
    try {
      const persisted = await this.sessionStore.load(input.projectRoot, input.sessionId);
      const result = await this.workflow.answer({
        state: persisted.state,
        answer: input.answer,
        acceptedAssumptionIds: input.acceptedAssumptionIds,
        rejectedAssumptionIds: input.rejectedAssumptionIds,
      });
      await this.sessionStore.save(input.projectRoot, result.state);
      return runtimeResult(result);
    } catch (error) {
      return failedFromError(error, input.sessionId);
    }
  }

  async status(input: RuntimeSessionInput): Promise<RuntimeResult> {
    try {
      const persisted = await this.sessionStore.load(input.projectRoot, input.sessionId);
      return runtimeResultFromState(persisted.state);
    } catch (error) {
      return failedFromError(error, input.sessionId);
    }
  }
}

function runtimeResult(result: SpecificationWorkflowResult): RuntimeResult {
  if (result.status === "failed") {
    return failedFromState(result.state);
  }
  return runtimeResultFromState(result.state);
}

function runtimeResultFromState(state: SpecificationWorkflowState): RuntimeResult {
  const sessionId = state.interview.id;
  if (state.status === "ready") {
    const validation = state.validation.latest;
    const review = state.review.latest;
    if (validation?.valid === true && review?.verdict === "pass") {
      return {
        status: "ready",
        sessionId,
        changeName: state.changeName,
        changePath: path.join(state.projectRoot, "openspec", "changes", state.changeName),
        artifacts: state.generation.artifacts,
        validation,
        review,
        state,
      };
    }
    return failed("ready-invariant", "Persisted ready state does not satisfy validation and review invariants.", sessionId, state);
  }

  const question = state.interview.unresolvedQuestions.at(-1);
  if (state.status === "needs-input" && question) {
    return {
      status: "needs-input",
      sessionId,
      changeName: state.changeName,
      question,
      state,
    };
  }

  return failedFromState(state);
}

function failedFromState(state: SpecificationWorkflowState): RuntimeResult {
  const failure = state.failure;
  return failed(
    failure?.code ?? state.status,
    failure?.message ?? `Specification workflow stopped with status ${state.status}.`,
    state.interview.id,
    state,
    failure?.cause,
  );
}

function failedFromError(error: unknown, sessionId?: string): RuntimeResult {
  if (error instanceof RuntimeSessionStoreError) {
    return failed(error.code, error.message, sessionId, undefined, error.details);
  }
  return failed("runtime-error", error instanceof Error ? error.message : "Runtime execution failed.", sessionId);
}

function failed(
  code: string,
  message: string,
  sessionId?: string,
  state?: SpecificationWorkflowState,
  details?: unknown,
): RuntimeResult {
  return {
    status: "failed",
    sessionId,
    changeName: state?.changeName,
    error: { code, message, ...(details ? { details } : {}) },
    ...(state ? { state } : {}),
  };
}

function changeNameFromIdea(idea: string, suffix: string): string {
  const slug =
    idea
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "spec-change";
  const safeSuffix = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "session";
  return `${slug}-${safeSuffix}`;
}
