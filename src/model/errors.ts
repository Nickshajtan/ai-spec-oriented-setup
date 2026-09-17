import type { ModelError, ModelFailureCode } from "./types.ts";

export class ModelInvocationError extends Error {
  readonly modelError: ModelError;

  constructor(error: ModelError) {
    super(error.message);
    this.name = "ModelInvocationError";
    this.modelError = error;
  }
}

export function modelError(
  code: ModelFailureCode,
  message: string,
  model: string,
  details: Omit<ModelError, "code" | "message" | "model"> = {},
): ModelError {
  return { code, message, model, ...details };
}
