import type { ObserverMiddleware } from "../types.ts";

export function createAuditObserver(onObserve?: (eventName: string) => void): ObserverMiddleware {
  return {
    id: "audit-observer",
    type: "observer",
    priority: 100,
    failureMode: "fail-open",
    handler(context) {
      onObserve?.(context.event.name);
    },
  };
}
