import { MiddlewareBus } from "../bus.ts";
import { ModelExecutionFailure, executionError } from "./errors.ts";
import { LiteLlmChatGateway } from "./litellm-chat-gateway.ts";
import type {
  LiteLlmModelExecutorConfig,
  ModelExecutionAudit,
  ModelExecutionOutcome,
  ModelExecutionRequest,
  ModelExecutionResult,
  ModelExecutor,
  ModelGateway,
  ModelMessage,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

export class LiteLlmModelExecutor implements ModelExecutor {
  private readonly bus: MiddlewareBus;
  private readonly gateway: ModelGateway;
  private readonly timeoutMs: number;

  constructor(config: LiteLlmModelExecutorConfig, options: { bus?: MiddlewareBus; gateway?: ModelGateway } = {}) {
    this.bus = options.bus ?? new MiddlewareBus();
    this.gateway = options.gateway ?? new LiteLlmChatGateway(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(request: ModelExecutionRequest): Promise<ModelExecutionOutcome> {
    const before = await this.bus.execute("model.request.before", requestMiddlewareContext(request));

    if (before.result.action === "deny") {
      return { status: "denied", reason: before.result.reason, middleware: { before } };
    }
    if (before.result.action === "require-human") {
      return { status: "requires-human", reason: before.result.reason, middleware: { before } };
    }

    const transformedRequest = requestFromMiddlewareContext(request, before.context);
    const validationError = validateRequest(transformedRequest);
    if (validationError) {
      return {
        status: "failed",
        error: validationError,
        audit: failureAudit(transformedRequest, validationError),
        middleware: { before },
      };
    }

    const startedAt = new Date();
    const startedMs = performance.now();

    try {
      const completion = await this.gateway.chatCompletion(
        {
          model: transformedRequest.deployment,
          messages: transformedRequest.messages,
          temperature: transformedRequest.parameters?.temperature,
          max_tokens: transformedRequest.parameters?.maxTokens,
        },
        { timeoutMs: this.timeoutMs },
      );
      const latencyMs = Math.max(0, performance.now() - startedMs);
      const result: ModelExecutionResult = {
        content: completion.content,
        deployment: transformedRequest.deployment,
        provider: completion.provider,
        model: completion.model,
        usage: completion.usage,
        cost: completion.cost,
        finishReason: completion.finishReason,
        latencyMs,
        rawResponseId: completion.id,
        metadata: transformedRequest.metadata,
      };
      const audit = successAudit(transformedRequest, result, startedAt, latencyMs);
      const after = await this.bus.execute("model.request.after", {
        ...requestMiddlewareContext(transformedRequest),
        routing: {
          provider: result.provider,
          model: result.model,
        },
        metadata: {
          ...(transformedRequest.metadata ?? {}),
          modelExecutionResult: result,
          modelExecutionAudit: audit,
        },
      });

      if (after.result.action === "deny") {
        return { status: "denied", reason: after.result.reason, middleware: { before, after } };
      }
      if (after.result.action === "require-human") {
        return { status: "requires-human", reason: after.result.reason, middleware: { before, after } };
      }

      return { status: "completed", result, audit, middleware: { before, after } };
    } catch (error) {
      const executionError =
        error instanceof ModelExecutionFailure
          ? error.executionError
          : executionErrorFactory("UnknownExecutionFailure", "Unknown model execution failure.", transformedRequest.deployment);
      const latencyMs = Math.max(0, performance.now() - startedMs);
      const audit = failureAudit(transformedRequest, executionError, startedAt, latencyMs);
      const after = await this.bus.execute("model.request.after", {
        ...requestMiddlewareContext(transformedRequest),
        metadata: {
          ...(transformedRequest.metadata ?? {}),
          modelExecutionError: executionError,
          modelExecutionAudit: audit,
        },
      });

      return { status: "failed", error: executionError, audit, middleware: { before, after } };
    }
  }
}

function validateRequest(request: ModelExecutionRequest) {
  if (!request.deployment.trim()) {
    return executionError("InvalidRequest", "Model execution deployment is required.", request.deployment);
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return executionError("InvalidRequest", "Model execution requires at least one message.", request.deployment);
  }

  for (const message of request.messages) {
    if (!isValidMessage(message)) {
      return executionError("InvalidRequest", "Model execution message has unsupported role or content.", request.deployment);
    }
  }

  const temperature = request.parameters?.temperature;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return executionError("InvalidRequest", "temperature must be between 0 and 2.", request.deployment);
  }

  const maxTokens = request.parameters?.maxTokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    return executionError("InvalidRequest", "maxTokens must be a positive integer.", request.deployment);
  }

  return undefined;
}

function isValidMessage(value: unknown): value is ModelMessage {
  return (
    isObject(value) &&
    typeof value.role === "string" &&
    ALLOWED_ROLES.has(value.role) &&
    typeof value.content === "string" &&
    value.content.length > 0
  );
}

function requestMiddlewareContext(request: ModelExecutionRequest) {
  return {
    runId: request.runId,
    taskId: request.taskId,
    metadata: {
      ...(request.metadata ?? {}),
      modelExecutionRequest: sanitizedRequest(request),
    },
  };
}

function requestFromMiddlewareContext(original: ModelExecutionRequest, context: { metadata: Record<string, unknown> }): ModelExecutionRequest {
  const candidate = context.metadata.modelExecutionRequest;
  if (!isObject(candidate)) {
    return structuredClone(original);
  }

  return {
    ...structuredClone(original),
    messages: Array.isArray(candidate.messages) ? structuredClone(candidate.messages) : structuredClone(original.messages),
    parameters: isObject(candidate.parameters)
      ? {
          ...original.parameters,
          ...structuredClone(candidate.parameters),
        }
      : structuredClone(original.parameters),
    metadata: isObject(candidate.metadata)
      ? {
          ...(original.metadata ?? {}),
          ...structuredClone(candidate.metadata),
        }
      : structuredClone(original.metadata),
  };
}

function sanitizedRequest(request: ModelExecutionRequest): Partial<ModelExecutionRequest> {
  return {
    messages: structuredClone(request.messages),
    parameters: structuredClone(request.parameters),
    metadata: structuredClone(request.metadata),
  };
}

function successAudit(
  request: ModelExecutionRequest,
  result: ModelExecutionResult,
  startedAt: Date,
  latencyMs: number,
): ModelExecutionAudit {
  return {
    runId: request.runId,
    taskId: request.taskId,
    deployment: request.deployment,
    requestStartedAt: startedAt.toISOString(),
    requestEndedAt: new Date().toISOString(),
    latencyMs,
    status: "completed",
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    cost: result.cost,
    finishReason: result.finishReason,
  };
}

function failureAudit(
  request: ModelExecutionRequest,
  error: ReturnType<typeof executionError>,
  startedAt = new Date(),
  latencyMs = 0,
): ModelExecutionAudit {
  return {
    runId: request.runId,
    taskId: request.taskId,
    deployment: request.deployment,
    requestStartedAt: startedAt.toISOString(),
    requestEndedAt: new Date().toISOString(),
    latencyMs,
    status: "failed",
    errorCategory: error.code,
  };
}

function executionErrorFactory(
  code: Parameters<typeof executionError>[0],
  message: string,
  deployment: string,
) {
  return executionError(code, message, deployment);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
