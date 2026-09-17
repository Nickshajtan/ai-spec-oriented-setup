export const SEMANTIC_EVENT_NAMES = [
  "run.started",
  "task.classify.before",
  "task.classify.after",
  "spec.validate.before",
  "spec.validate.after",
  "model.route.before",
  "model.route.after",
  "provider.resolve.before",
  "provider.resolve.after",
  "model.request.before",
  "model.request.after",
  "tool.execute.before",
  "tool.execute.after",
  "verify.before",
  "verify.after",
  "run.complete.before",
  "run.completed",
  "run.failed",
] as const;

export type SemanticEventName = (typeof SEMANTIC_EVENT_NAMES)[number];

export interface SemanticEvent {
  name: SemanticEventName;
  version: 1;
}

export function semanticEvent(name: SemanticEventName): SemanticEvent {
  return { name, version: 1 };
}
