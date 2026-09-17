import type { ProviderResolutionFailureCode } from "./types.ts";

export class ProviderResolutionError extends Error {
  readonly code: ProviderResolutionFailureCode;

  constructor(code: ProviderResolutionFailureCode, message: string) {
    super(message);
    this.name = "ProviderResolutionError";
    this.code = code;
  }
}
