import { specifierEvent, type SpecifierEventName } from "./events.ts";
import type {
  ContextPatch,
  Middleware,
  MiddlewareAction,
  MiddlewareContext,
  MiddlewareExecution,
  MiddlewareRecord,
  MiddlewareResult,
  MiddlewareType,
} from "./middleware/types.ts";

type RegisteredMiddleware = Middleware & { registrationOrder: number };

const PHASE_ORDER: MiddlewareType[] = ["observer", "policy", "transformer"];

export class MiddlewareBus {
  private readonly registry = new Map<SpecifierEventName, RegisteredMiddleware[]>();
  private nextRegistrationOrder = 0;

  use(eventName: SpecifierEventName, middleware: Middleware): void {
    const existing = this.registry.get(eventName) ?? [];
    if (existing.some((registered) => registered.id === middleware.id)) {
      throw new Error(`Middleware id already registered for ${eventName}: ${middleware.id}`);
    }

    existing.push({
      ...middleware,
      registrationOrder: this.nextRegistrationOrder++,
    });
    this.registry.set(eventName, existing);
  }

  getMiddleware(eventName: SpecifierEventName): Middleware[] {
    return this.getOrdered(eventName).map(({ registrationOrder: _registrationOrder, ...middleware }) => middleware);
  }

  async execute(eventName: SpecifierEventName, input: Omit<MiddlewareContext, "event">): Promise<MiddlewareExecution> {
    let context: MiddlewareContext = cloneContext({
      ...input,
      event: specifierEvent(eventName),
      metadata: input.metadata ?? {},
    });
    const records: MiddlewareRecord[] = [];

    for (const middleware of this.getOrdered(eventName)) {
      const started = new Date();
      const startedMs = performance.now();

      try {
        const rawResult = await middleware.handler(readonlyContext(context));
        const result = normalizeResult(middleware, rawResult);
        const record = createRecord(eventName, middleware, started, startedMs, result.action);
        records.push(record);

        if (result.action === "modify") {
          context = applyPatch(context, result.patch);
          continue;
        }

        if (result.action === "deny" || result.action === "require-human") {
          return { context, result, records };
        }
      } catch (error) {
        const failureMode = middleware.failureMode ?? defaultFailureMode(middleware.type);
        const resultAction: MiddlewareAction = failureMode === "fail-open" ? "continue" : "deny";
        const record = createRecord(eventName, middleware, started, startedMs, resultAction, toRecordError(error));
        records.push(record);

        if (failureMode === "fail-closed") {
          return {
            context,
            result: { action: "deny", reason: `Middleware ${middleware.id} failed closed` },
            records,
          };
        }
      }
    }

    return { context, result: { action: "continue" }, records };
  }

  private getOrdered(eventName: SpecifierEventName): RegisteredMiddleware[] {
    const registered = this.registry.get(eventName) ?? [];
    return [...registered].sort((left, right) => {
      const phaseDelta = PHASE_ORDER.indexOf(left.type) - PHASE_ORDER.indexOf(right.type);
      if (phaseDelta !== 0) return phaseDelta;

      const priorityDelta = left.priority - right.priority;
      if (priorityDelta !== 0) return priorityDelta;

      return left.registrationOrder - right.registrationOrder;
    });
  }
}

function normalizeResult(middleware: Middleware, rawResult: unknown): MiddlewareResult {
  if (middleware.type === "observer") {
    if (rawResult === undefined || isAction(rawResult, "continue")) {
      return { action: "continue" };
    }
    throw new Error(`Observer ${middleware.id} returned an executable action`);
  }

  if (middleware.type === "policy") {
    if (isAction(rawResult, "continue") || isAction(rawResult, "deny") || isAction(rawResult, "require-human")) {
      return rawResult;
    }
    throw new Error(`Policy ${middleware.id} returned an unsupported action`);
  }

  if (isAction(rawResult, "continue") || isAction(rawResult, "modify")) {
    if (rawResult.action === "modify" && !isObject(rawResult.patch)) {
      throw new Error(`Transformer ${middleware.id} returned modify without a patch`);
    }
    if (rawResult.action === "modify") {
      validatePatch(middleware.id, rawResult.patch);
    }
    return rawResult;
  }

  throw new Error(`Transformer ${middleware.id} returned an unsupported action`);
}

function validatePatch(middlewareId: string, patch: Record<string, unknown>): void {
  const allowedKeys = new Set(["lifecycle", "warnings", "metadata"]);
  const invalidKeys = Object.keys(patch).filter((key) => !allowedKeys.has(key));

  if (invalidKeys.length > 0) {
    throw new Error(`Transformer ${middlewareId} returned unsupported patch keys: ${invalidKeys.join(", ")}`);
  }
}

function isAction<TAction extends MiddlewareAction>(
  value: unknown,
  action: TAction,
): value is Extract<MiddlewareResult, { action: TAction }> {
  return isObject(value) && value.action === action;
}

function readonlyContext(context: MiddlewareContext): Readonly<MiddlewareContext> {
  return deepFreeze(cloneContext(context));
}

function applyPatch(context: MiddlewareContext, patch: ContextPatch): MiddlewareContext {
  return cloneContext(deepMerge(context, patch));
}

function deepMerge<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(patch)) {
    const current = next[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      next[key] = deepMerge(current, value);
    } else {
      next[key] = cloneValue(value);
    }
  }

  return next as T;
}

function cloneContext(context: MiddlewareContext): MiddlewareContext {
  return cloneValue(context) as MiddlewareContext;
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (!isObject(value) || Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function defaultFailureMode(type: MiddlewareType): "fail-open" | "fail-closed" {
  return type === "observer" ? "fail-open" : "fail-closed";
}

function createRecord(
  eventName: SpecifierEventName,
  middleware: Middleware,
  started: Date,
  startedMs: number,
  resultAction: MiddlewareAction,
  error?: { name: string; message: string },
): MiddlewareRecord {
  const ended = new Date();
  return {
    event: eventName,
    middlewareId: middleware.id,
    middlewareType: middleware.type,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: Math.max(0, performance.now() - startedMs),
    resultAction,
    ...(error ? { error } : {}),
  };
}

function toRecordError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
