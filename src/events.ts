export const SPECIFIER_EVENT_NAMES = [
  "run.started",
  "interview.started",
  "interview.turn.before",
  "interview.turn.after",
  "interview.question.planned",
  "interview.answer.accepted",
  "interview.gap.detected",
  "interview.ready",
  "openspec.change.create.before",
  "openspec.change.create.after",
  "openspec.status.before",
  "openspec.status.after",
  "openspec.instructions.before",
  "openspec.instructions.after",
  "openspec.validate.before",
  "openspec.validate.after",
  "review.request.before",
  "review.request.after",
  "review.completed",
  "run.completed",
  "run.failed",
] as const;

export type SpecifierEventName = (typeof SPECIFIER_EVENT_NAMES)[number];

export interface SpecifierEvent {
  name: SpecifierEventName;
  version: 1;
}

export function specifierEvent(name: SpecifierEventName): SpecifierEvent {
  return { name, version: 1 };
}
