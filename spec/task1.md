You are working on the existing PR for the `ai-spec-oriented-setup` repository.

This is a focused final correctness/CI pass. Do not redesign the architecture, add unrelated abstractions, or expand product scope.

## Goal

Fix the remaining issues found during PR review, add regression coverage, and leave the PR with all existing quality gates passing.

### 1. Fix production handling of multiple external interview gaps

There is a behavioral divergence between the real `InterviewEngine.addExternalGaps()` and the fake used in specification workflow tests.

Current production behavior can receive multiple review/validation gaps, persist all of them in
`session.gaps`, but enqueue only one corresponding unresolved question.

This can lose the questioning flow for the remaining material external gaps after the first answer.

Example:

```text
review -> needs_input:
- runtime missing
- scale missing
- retention policy missing

All three become open gaps,
but only the first becomes an unresolved question.
```

After answering the first question, the ordinary planner may continue independently and the
remaining external gaps are not guaranteed to be asked before readiness.

This violates the invariant:

> Every open material external gap must remain actionable and must block readiness until explicitly resolved.

#### Required behavior

Implement a deterministic production mechanism for external-gap questioning.

Preferred design:

- treat external gaps as an explicit pending queue derived from persisted session state;
- do not rely on transient local arrays inside `addExternalGaps()`;
- before invoking the normal model-backed question planner, check whether an unresolved external gap already requires a question;
- ask external-gap questions deterministically, one at a time;
- after answering one external-gap question, continue with the next open external gap before
  returning control to ordinary question planning;
- an open external gap must always block `InterviewSession.readiness.ready`;
- answering one external gap must not accidentally resolve or discard another;
- duplicate findings must remain deduplicated;
- existing provenance/source information (`review` / `validation`) must be preserved;
- do not create duplicate questions for the same still-open gap.

Avoid introducing a second unrelated interview system. Reuse the existing `InterviewSession`,
gaps, questions, unresolvedQuestions, and `InterviewEngine`.

If a simpler implementation can guarantee these invariants cleanly, use it.

#### Tests

Add production-level regression tests using the real `InterviewEngine`, not only `FakeInterviewEngine`.

At minimum cover:

1. two or more external gaps are registered;
2. only the appropriate current question is presented at a time;
3. answering the first external question causes the second open external gap to become the next question;
4. the interview cannot become ready while another external gap remains open;
5. after all external gaps are answered, normal planning/readiness can resume;
6. duplicate external findings do not create duplicate gaps/questions;
7. both `review` and `validation` external-gap sources follow the same invariant.

Also review the existing fake implementation so tests do not accidentally encode behavior different from production.

### 2. Restore safe atomic artifact replacement semantics

Review `NodeArtifactWriter` overwrite behavior.

Current overwrite flow effectively does:

```ts
rm(destination)
rename(temp, destination)
```

This creates a window where the persisted artifact does not exist and can destroy the previous
valid artifact if the process fails between those operations.

The intended persistence contract is safe temp-file-based replacement.

#### Required behavior

Implement the safest practical cross-platform replacement strategy for supported Node.js platforms.

Requirements:

- never intentionally delete the destination before attempting the normal atomic replacement path
  where the platform supports replacement via rename;
- preserve the previous artifact if replacement fails before the new artifact has successfully replaced it;
- clean up temporary files on failure;
- preserve existing `overwrite: false` conflict semantics;
- do not silently swallow filesystem failures;
- keep `ArtifactWriter` generic and free of OpenSpec semantics.

If Windows requires a fallback because rename-over-existing semantics differ, implement a carefully
bounded fallback rather than making destructive `rm -> rename` the normal overwrite algorithm.

Document any unavoidable platform limitation in the code/docs.

#### Tests

Add filesystem-backed tests covering at minimum:

- normal new write;
- `overwrite: false` conflict;
- successful overwrite;
- failed replacement does not intentionally remove the existing artifact;
- temp files are cleaned up after failure where testable;
- path safety remains unchanged.

Prefer dependency injection or a small filesystem boundary only if required to test failure behavior
cleanly. Do not over-engineer the writer.

### 3. Fix formatting and run the complete quality gate

The current GitHub Actions run fails at `Format check`.

Apply the repository formatter and ensure the actual repository state satisfies it.

Then run all relevant checks, not only the previously failing one:

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run openspec:smoke
npm run audit:high
npm run check
```

The OpenSpec smoke test requires the pinned OpenSpec CLI version already defined by the
repository/CI. Use the existing project contract; do not weaken or skip the smoke test to make CI
green.

Do not lower coverage thresholds, disable lint rules, loosen tests, or weaken CI checks merely to pass the build.

### 4. Final consistency review

Before finishing, inspect the resulting implementation for consistency between:

- real `InterviewEngine`;
- workflow tests/fakes;
- `SpecificationWorkflow`;
- `NodeArtifactWriter`;
- documentation describing interview reopening and safe artifact persistence.

Update documentation only where behavior changed or existing documentation became inaccurate.

Do not add speculative features.

## Definition of Done

The task is complete only when:

- every open external review/validation gap is guaranteed to remain actionable until resolved;
- multiple `needs_input` findings cannot be accidentally lost after answering the first question;
- production tests cover that behavior using the real `InterviewEngine`;
- fake/test behavior no longer materially diverges from production semantics;
- overwrite no longer uses destructive destination deletion as the normal replacement path;
- filesystem failure behavior is regression-tested;
- formatting is fixed;
- all repository quality gates pass;
- existing OpenSpec architecture boundaries remain intact;
- no standard OpenSpec artifact names or lifecycle rules are newly hardcoded into Core;
- no unrelated refactoring or feature expansion is introduced.

At completion, provide a concise report containing:

1. root cause of the external-gap bug;
2. exact behavior implemented;
3. artifact overwrite strategy and its platform considerations;
4. regression tests added/changed;
5. commands executed and their results;
6. any remaining limitation that could not safely be eliminated.
