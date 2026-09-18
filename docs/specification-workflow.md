# Specification Workflow

`SpecificationWorkflow` is the Core orchestrator for the Specifier product lifecycle:

```text
Interview -> Generate -> Persist -> Validate -> Review -> Revise/Reopen -> Ready
```

It is not a generic workflow engine. It coordinates existing ports:

- `InterviewEngine`
- `OpenSpecGateway`
- `ArtifactGenerator`
- `ArtifactWriter`
- `ArtifactReader`
- `SpecReviewer`

## Readiness Invariants

A specification can become `ready` only when all three conditions are true:

1. `InterviewSession.readiness.ready === true`
2. OpenSpec validation is valid
3. The latest mandatory independent review verdict is `pass`

Generation cannot start while the interview has blocking gaps or unresolved contradictions. Review cannot run before valid OpenSpec validation.

## Artifact Generation

OpenSpec status determines the next artifact. OpenSpec artifact-specific instructions determine how that artifact should be generated. The workflow does not hardcode standard artifact names or construct OpenSpec paths.

`ArtifactGenerator` returns complete content for one artifact. It does not write files, call OpenSpec, or decide what comes next. `ArtifactWriter` persists the OpenSpec-resolved path. `ArtifactReader` reads the persisted content for dependency context, review, and revision.

## Review Outcomes

`pass` means the validated artifacts are implementation-ready.

`needs_revision` means existing information is sufficient, but the artifacts need repair. The workflow revises affected artifacts with explicit overwrite, validates again, and runs another fresh-context review.

`needs_input` means a material human/product decision is missing. The finding becomes a structured gap in the existing `InterviewSession`; after the human answers, the workflow resumes the same change.

Review history is retained in workflow state. It is domain state, not a generic audit subsystem.

## Guards

The workflow has deterministic guards for runaway generation/review loops and no-progress OpenSpec status. It fails non-ready rather than retrying forever or marking the change ready.
