---
name: specifier
description: Turn a rough feature idea into a validated, independently reviewed OpenSpec change by driving the existing SpecificationWorkflow. Use for specification discovery and planning, not implementation.
---

# Specifier

Use the project's `ai-spec-core` runtime executable as the concrete bridge into `SpecificationWorkflow`.

1. Invoke `ai-spec-core start` with one JSON object containing the project root, rough idea, and optional user-provided change name.
2. Read the structured JSON result from stdout. Diagnostics belong on stderr and must not be treated as workflow state.
3. When Core returns `needs-input`, present its current generated question without materially replacing it. Collect the user's answer, then invoke `ai-spec-core answer` with the same project root, returned `sessionId`, and answer.
4. Continue only according to returned Core state. Never decide readiness, artifact structure or order, validation policy, review outcome, revision strategy, model routing, or provider selection yourself.
5. When Core returns `ready`, report the change name, OpenSpec change location, artifact summary, validation success, and independent review success. State that the change is ready for implementation; do not implement it.
6. When Core returns `failed`, translate the structured error into a concise actionable message. Keep diagnostics available, but do not print a raw stack trace by default.

Use `ai-spec-core status` only to inspect a persisted session without advancing it. Do not call OpenSpec's implementation skills after readiness. Do not replace or modify existing `opsx:*` / OpenSpec skills. If the runtime cannot be configured, report that missing integration rather than inventing a second interview or specification runtime.
