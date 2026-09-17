# Implementation Specification — OpenSpec-Aware Interview Core

## Goal

Implement the first vertical slice of the actual product:

> Given a rough feature idea and an OpenSpec project, systematically gather enough material information from a human to prepare a high-quality OpenSpec change.

The interview must be adaptive and OpenSpec-aware.

It must NOT be a fixed questionnaire.

---

## Core principle

OpenSpec defines what artifacts exist and what those artifacts require.

Specifier determines what information is still missing from the human.

Conceptual loop:

```text
rough idea
   ↓
create/introspect OpenSpec change
   ↓
read OpenSpec status + artifact instructions
   ↓
evaluate known information
   ↓
material information missing?
   ├── yes → ask best next question
   │          ↓
   │       integrate answer
   │          ↓
   │       repeat
   │
   └── no → artifact generation
```

Do not maintain a competing specification schema.

---

## InterviewSession

Introduce explicit session state.

The state is not raw chat history.

It should preserve structured knowledge such as:

- explicit user facts;
- accepted assumptions;
- model proposals where relevant;
- user choices;
- unresolved questions;
- ambiguities;
- contradictions;
- provenance;
- relevant OpenSpec context;
- question history.

Distinguish information explicitly supplied by the user from information inferred or proposed by the model.

Do not invent fake numerical confidence scores.

---

## OpenSpec-driven planning

For the current OpenSpec change:

1. query OpenSpec for current artifact status;
2. determine which artifact(s) can/should be worked on next;
3. retrieve official artifact instructions;
4. include relevant dependency artifacts/context;
5. evaluate what material information is missing.

The Interview Engine must not hardcode a universal artifact graph.

Custom OpenSpec schemas should remain possible.

---

## Question planning

Implement an AI-assisted QuestionPlanner through `ModelPort`.

The planner receives structured session state plus relevant OpenSpec instructions.

It should produce structured output describing:

- whether material information is missing;
- the next question if required;
- why the information matters;
- what gap the question addresses;
- optional candidate choices when useful.

Ask one focused question at a time by default.

Do not ask questions merely because more detail could theoretically exist.

Prefer questions that materially affect:

- behavior;
- implementation constraints;
- architecture;
- compatibility;
- failure behavior;
- acceptance criteria.

Do not force the human to make low-level implementation choices that a competent coding agent can reasonably derive unless those choices materially change the feature.

---

## Answer integration

Answers must update structured state.

Support:

- new facts;
- explicit choices;
- clarification of previous information;
- accepted/rejected assumptions.

Detect obvious conflicts with existing session knowledge.

When a material contradiction exists, resolve it through the interview rather than silently overwriting earlier information.

---

## Readiness

Readiness means:

> The system has enough material information to proceed with the current OpenSpec requirements without unresolved blocking ambiguity or contradiction.

It does NOT mean every conceivable question has been answered.

Readiness should be represented explicitly and explainably.

Do not base readiness on an opaque LLM confidence number.

---

## First vertical slice

Implement enough behavior to demonstrate:

```text
start session
→ rough feature idea
→ inspect OpenSpec
→ ask adaptive question
→ accept answer
→ update structured state
→ ask follow-up
→ determine readiness
```

The implementation must be usable through a programmatic API.

Do not implement a polished CLI yet.

---

## Middleware integration

Emit only useful semantic domain events arising from the implemented lifecycle.

Examples may include:

```text
interview.started
interview.question.planned
interview.answer.accepted
interview.gap.detected
interview.ready
```

Do not create events speculatively.

Bundled logging/limits middleware should be able to observe this lifecycle.

Core correctness must not depend on optional middleware.

---

## Tests

Tests must cover at least:

- session creation;
- explicit user fact provenance;
- adaptive next-question planning;
- answer integration;
- contradiction preservation/resolution behavior;
- readiness behavior;
- OpenSpec schema/instruction input;
- custom/non-default artifact structures where practical;
- middleware event emission;
- limits guard interaction;
- mocked ModelPort behavior.

Tests must not call paid model APIs.

---

## Definition of Done

A test/demo can start with:

```text
"Add Redis caching to WordPress REST responses."
```

and produce a sequence conceptually like:

```text
Where will this change run?
→ Existing WordPress multisite.

What scale must it support?
→ Approximately 3000 sites.

How should cached responses be invalidated?
→ Per site and resource.

What should happen if Redis is unavailable?
→ Fall back to the database.
```

The exact questions must NOT be hardcoded to this example.

The session eventually reaches an explainable `ready` state based on OpenSpec requirements and collected information.

No OpenSpec artifact generation is required in this step.

## Non-goals

Do not implement:

- fixed 20/30-question questionnaire;
- hardcoded proposal/design/tasks workflow;
- full CLI UX;
- model routing;
- autonomous code implementation;
- web UI;
- provider-specific LLM logic;
- sophisticated semantic parsing subsystem;
- persistent session database.
