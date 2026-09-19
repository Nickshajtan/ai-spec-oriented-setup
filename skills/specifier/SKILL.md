---
name: specifier
description: Turn a rough feature idea into a validated, independently reviewed OpenSpec change by driving the existing SpecificationWorkflow. Use for specification discovery and planning, not implementation.
---

# Specifier

Use the project's exported `SpecificationWorkflow` as the only authority for specification behavior.

1. Start the existing workflow with the project root, rough idea, and optional user-provided change name.
2. When Core returns `needs-input`, present its current generated question without materially replacing it. Send the user's answer back through `SpecificationWorkflow.answer`.
3. Continue only according to the returned Core state. Never decide readiness, artifact structure or order, validation policy, review outcome, or revision strategy yourself.
4. When Core returns `ready`, report the change name, OpenSpec change location, artifact summary, validation success, and independent review success. State that the change is ready for implementation; do not implement it.
5. Translate expected structured failures into concise actionable errors. Keep diagnostics available, but do not print a raw stack trace by default.

Do not call OpenSpec's implementation skills after readiness. Do not replace or modify existing `opsx:*` / OpenSpec skills. If the project's application integration has not wired the exported Core dependencies, report that missing integration rather than inventing a second interview or specification runtime.
