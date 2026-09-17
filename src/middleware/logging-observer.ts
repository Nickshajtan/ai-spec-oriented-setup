import type { ObserverMiddleware } from "./types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LifecycleLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export function createLoggingObserver(options: { level?: LogLevel; logger?: LifecycleLogger } = {}): ObserverMiddleware {
  const level = options.level ?? "info";
  const logger = options.logger ?? console;

  return {
    id: "logging-observer",
    type: "observer",
    priority: 100,
    failureMode: "fail-open",
    handler(context) {
      const write = logger[level] ?? logger.info ?? (() => undefined);
      write.call(logger, `specifier lifecycle event: ${context.event.name}`, {
        runId: context.runId,
        subjectId: context.subjectId,
        warnings: context.warnings,
      });
    },
  };
}
