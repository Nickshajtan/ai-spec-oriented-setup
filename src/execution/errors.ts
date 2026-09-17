import type { ModelExecutionError, ModelExecutionFailureCode } from "./types.ts";

export class ModelExecutionFailure extends Error {
  readonly executionError: ModelExecutionError;

  constructor(error: ModelExecutionError) {
    super(error.message);
    this.name = "ModelExecutionFailure";
    this.executionError = error;
  }
}

export function executionError(
  code: ModelExecutionFailureCode,
  message: string,
  deployment: string,
  details: Omit<ModelExecutionError, "code" | "message" | "deployment"> = {},
): ModelExecutionError {
  return {
    code,
    message,
    deployment,
    ...details,
  };
}
