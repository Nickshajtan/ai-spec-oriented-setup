# OpenSpec-Aware Interview Core

The interview core is the first product vertical slice. It starts with a rough feature idea, asks OpenSpec for current change context, plans one material question at a time, integrates answers into structured state, and reports explainable readiness.

It is not a fixed questionnaire and it does not maintain a competing specification schema.

## Session State

`InterviewSession` is structured state rather than raw chat history. It preserves:

- explicit user facts with provenance;
- accepted, rejected, and proposed assumptions;
- user choices;
- unresolved questions;
- ambiguities and contradictions;
- relevant OpenSpec status, instructions, and context;
- question history;
- explainable readiness.

User-supplied facts are distinct from model-proposed information. The core does not invent confidence scores.

## Planning

`ModelQuestionPlanner` calls `ModelPort` with a compact view of the session and OpenSpec instructions. The expected planner result says whether material information is missing, the next question when needed, why it matters, which gap it addresses, optional choices, and readiness.

The planner is AI-assisted, but the engine keeps readiness explicit and blocks readiness when unresolved contradictions remain.

External gaps discovered by review or validation are part of the same `InterviewSession`. The engine stores every open external gap with provenance and asks deterministic external-gap questions one at a time before invoking the normal planner. An open external gap always blocks readiness until its corresponding user answer resolves it.

## Answer Integration

Answers create explicit user facts. If a new answer conflicts with an existing active fact for the same material gap, the engine records an unresolved contradiction and asks the planner for a resolution question instead of overwriting the earlier fact.

When the human answers that follow-up, the contradiction is marked resolved and superseded facts remain linked for provenance.

Current deterministic contradiction detection only catches directly comparable previously collected answers for the same material gap. Semantic contradictions across different facts are expected to be detected by later model-assisted review.

## Events

The implemented lifecycle emits:

```text
interview.started
interview.turn.before
interview.question.planned
interview.answer.accepted
interview.gap.detected
interview.ready
interview.turn.after
```

Core correctness does not depend on middleware.

## Non-Goals

This step does not generate OpenSpec artifacts, implement a polished CLI, route models, call provider-specific SDKs, or persist sessions.
