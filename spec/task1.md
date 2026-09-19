# Task — PR #1 Review Remediation & CI Hardening

Work on the existing PR branch for PR #1:

`feature/open-spec-artifacts`

Do NOT start a new architectural/product step.

The goal is to remediate the Step 03 implementation based on code review, strengthen correctness around the workflow state machine and OpenSpec boundary, and upgrade CI so this repository has meaningful merge gates.

Do not merge the PR.

---

# 1. Inspect Before Modifying

Inspect the complete current PR diff against `main`, then inspect at minimum:

- `src/specification/specification-workflow.ts`
- `src/specification/types.ts`
- `src/specification/model-artifact-generator.ts`
- `src/specification/model-spec-reviewer.ts`
- `src/interview/interview-engine.ts`
- `src/interview/types.ts`
- `src/openspec/openspec-gateway.ts`
- `src/openspec/types.ts`
- `src/artifact-writer/*`
- `src/events.ts`
- `src/index.ts`
- all workflow/OpenSpec/artifact tests
- `package.json`
- `.github/workflows/ci.yml`
- `AGENTS.md`
- relevant docs

Also verify the actual OpenSpec CLI contract supported by the repository.

Do not blindly implement the recommendations below if the current code already provides a stronger equivalent.

Preserve the Step 03 product boundary.

---

# 2. Fix Validation Repair Targeting

## Current problem

Validation failure handling currently effectively assigns a generic OpenSpec validation failure to the first generated artifact.

Conceptually, behavior equivalent to this is unsafe:

```ts
artifactId: artifacts[0]?.artifactId
```

A validation error must not cause an arbitrary valid artifact to be rewritten.

## Required behavior

Use actual OpenSpec validation diagnostics where they identify an artifact/path.

Normalize enough validation information at the OpenSpec boundary to preserve actionable diagnostics.

Conceptually:

```ts
interface OpenSpecValidationFinding {
  artifactId?: string;
  path?: string;
  message: string;
  code?: string;
  raw?: unknown;
}
```

Exact type is flexible.

Preserve raw OpenSpec validation output.

When validation fails:

### Case A — target is deterministically identifiable

Revise the affected artifact(s).

### Case B — validation failure is repairable but target requires reasoning

Use a narrowly scoped repair-analysis step only if necessary.

Do NOT ask the human merely to diagnose a structural OpenSpec error.

### Case C — validation exposes a genuinely missing human/product decision

Convert it into an interview gap.

### Case D — target/cause cannot safely be determined

Return a structured non-ready/require-human workflow result.

Do NOT guess an artifact.

---

# 3. Preserve All Material `needs_input` Findings

## Current problem

The workflow currently selects only one material review finding when reopening the interview.

Multiple independent blocking findings can therefore be discarded from active interview state until another complete generation/review cycle rediscovers them.

## Required behavior

When review returns:

```text
needs_input
```

register all material findings requiring human input as structured interview gaps.

Do not necessarily ask all questions at once.

The existing Interview Engine / QuestionPlanner should determine which unresolved material question is presented next.

Desired flow:

```text
review
  ↓
3 material human-input findings
  ↓
3 structured interview gaps
  ↓
InterviewEngine / QuestionPlanner
  ↓
one focused question
```

Deduplicate equivalent findings/gaps.

Do not create duplicate unresolved questions on repeated review.

---

# 4. Move External Gap Integration Into InterviewEngine

## Current problem

`SpecificationWorkflow` directly mutates:

- `interview.gaps`
- `interview.questions`
- `interview.unresolvedQuestions`
- `interview.readiness`

This leaks InterviewEngine invariants into the workflow.

## Required change

Introduce the smallest InterviewEngine API needed to register externally discovered gaps.

For example:

```ts
addExternalGaps(...)
```

or equivalent.

The Interview Engine should own:

- gap insertion;
- provenance;
- deduplication;
- unresolved question planning;
- readiness transition.

`SpecificationWorkflow` should communicate:

> these material gaps were discovered by review/validation

rather than manually constructing InterviewSession internals.

Do NOT create another interview engine.

Do NOT create a generic issue-management subsystem.

---

# 5. Correct Revision Dependency Handling

## Current problem

A review may request revision of artifact A while artifact B depends on A.

Currently B may remain untouched even though its dependency changed.

Example:

```text
intent
  ↓
architecture-note
  ↓
implementation-plan
```

If `intent` changes, downstream artifacts may become stale.

## Required behavior

Do NOT implement a parallel dependency graph.

After revision:

1. write the revised artifact;
2. ask OpenSpec for fresh status;
3. allow OpenSpec to determine which artifacts are now incomplete/ready/stale;
4. regenerate whatever OpenSpec says requires generation.

If the actual OpenSpec CLI does not automatically expose downstream staleness after a file changes, use its documented dependency information to invalidate only necessary downstream generated artifacts.

Keep any fallback small and explicitly documented.

Do not regenerate every artifact by default.

Add a test proving a revised dependency causes the appropriate downstream artifact to be reconsidered.

---

# 6. Stop Interpreting Raw OpenSpec Status Strings in Core

## Current problem

Core currently contains logic equivalent to:

```ts
status === "complete"
|| status === "completed"
|| status === "ready"
|| status === "valid"
|| status === "done"
|| status === "written"
```

This recreates OpenSpec semantics inside the workflow.

## Required change

Normalize documented OpenSpec artifact lifecycle/status at the `OpenSpecGateway` boundary.

Expose a narrow Core-facing lifecycle representation.

For example:

```ts
type OpenSpecArtifactState =
  | "pending"
  | "ready"
  | "blocked"
  | "complete";
```

Use the actual verified OpenSpec CLI semantics rather than blindly adopting these exact values.

Core should reason about normalized state.

Core should not interpret arbitrary OpenSpec status strings.

Preserve the original status/raw payload separately.

---

# 7. Remove `metadata.normalization` From Core Authority Decisions

## Current problem

Core currently determines whether an artifact is authoritative using implementation metadata such as:

```ts
artifact.metadata?.normalization === "documented"
```

That is a gateway implementation detail leaking into domain orchestration.

## Required change

Make the OpenSpec gateway contract explicit.

Generation-facing artifacts returned by the authoritative API should already be safe for workflow decisions.

Compatibility/heuristically discovered artifacts must not be mixed indistinguishably into that collection.

Possible approaches:

```ts
authoritativeArtifacts
compatibilityArtifacts
```

or a strongly typed authority field at the boundary.

Choose the smallest clean design.

Core must not know how JSON normalization was implemented.

---

# 8. OpenSpec Failures Must Block Review

## Current problem

Before review, the workflow calls OpenSpec status/instructions but does not reliably stop if those calls fail.

The reviewer may therefore receive incomplete/undefined OpenSpec context and potentially return `pass`.

## Required behavior

Before invoking `SpecReviewer`, verify all required OpenSpec calls succeeded.

If status or instructions retrieval fails:

```text
DO NOT call reviewer
DO NOT allow pass
DO NOT become ready
```

Return an appropriate structured workflow failure.

Add tests for both status and instructions failures before review.

---

# 9. Persisted Dependency Reads Must Fail Safely

## Current problem

Dependency reading may silently fall back to cached in-memory generated content after filesystem read failure.

Persisted artifacts are supposed to be the authoritative current artifact state.

## Required behavior

Differentiate read outcomes.

For example:

```text
read
not-found
path-rejected
read-failed
```

`path-rejected` and `read-failed` must fail the generation/revision workflow.

Do not silently use cached content after an I/O/security failure.

If `not-found` has a legitimate lifecycle meaning, handle it explicitly.

Otherwise fail.

The same authority principle applies:

> when persisted content is expected to exist, review/generation should reason about persisted content.

---

# 10. Separate Iteration Counters

## Current problem

Validation repair limits currently depend on review-attempt counts.

These are different lifecycle dimensions.

## Required change

Track appropriate counters separately.

At minimum distinguish:

```text
artifact generation/revision attempts
validation repair attempts
AI review attempts
```

Exact state representation is flexible.

Example:

```ts
generation.attempts
validation.repairAttempts
review.attempts.length
```

Do not report a validation-repair failure as a review iteration failure.

Use accurate failure codes, e.g.:

```text
generation-iteration-limit
validation-repair-limit
review-iteration-limit
```

or equivalent.

Defaults should remain conservative.

No infinite retries.

---

# 11. Keep Review Independent

Preserve the current good behavior:

```text
artifact generation
    ↓
fresh ModelPort request
    ↓
spec review
```

Do not turn review into a continuation of generation messages.

Add/retain tests proving separate model requests.

Same physical model is allowed.

Fresh logical context is required.

---

# 12. Preserve Final Readiness Invariant

The workflow may return:

```text
ready
```

only when:

```text
Interview ready
AND
OpenSpec validation valid
AND
latest independent review == pass
```

Keep this centralized in Core.

Add regression tests if necessary.

No caller, skill, CLI, middleware or model response may bypass it.

---

# 13. CI Hardening

The repository has moved beyond a skeleton.

Current CI effectively runs:

```text
npm ci
npm run check
```

Strengthen it into meaningful merge gates.

Do not create an enterprise-scale CI platform.

---

# 14. Add ESLint

Add a current TypeScript-aware ESLint setup appropriate for this repository.

Prefer modern flat configuration if supported by the selected versions.

Focus on correctness and maintainability.

Avoid excessive stylistic rules already handled by formatting.

At minimum catch useful issues such as:

- unused imports/variables;
- suspicious async usage;
- accidental promises;
- obviously unsafe TypeScript patterns where practical;
- unreachable/dead constructs.

Add:

```json
"lint": "..."
```

and make lint non-mutating in CI.

---

# 15. Add Prettier Format Check

Add Prettier for deterministic formatting.

Provide separate scripts:

```json
"format": "... --write ..."
"format:check": "... --check ..."
```

CI uses only:

```text
format:check
```

Do not mix formatting responsibilities into ESLint unless there is a compelling reason.

---

# 16. Improve `npm run check`

`npm run check` should represent the complete fast local quality gate.

Recommended:

```text
format:check
lint
typecheck
test
```

Ordering may differ.

Keep it deterministic and network-free.

---

# 17. Coverage

Add test coverage reporting using tooling compatible with the existing Node test setup.

Do not switch test frameworks solely for coverage.

Prefer Node-native coverage if it cleanly supports the current environment.

Establish meaningful but achievable thresholds.

Initial target:

```text
lines:      >= 80%
functions:  >= 80%
branches:   >= 70–75%
```

Adjust slightly if justified by the actual baseline, but do not silently choose trivial thresholds.

Branch coverage is particularly valuable for:

- `SpecificationWorkflow`
- InterviewEngine
- OpenSpec normalization
- ArtifactWriter/Reader

Expose:

```text
npm run test:coverage
```

CI should enforce thresholds.

Do not chase 100% coverage.

---

# 18. Real OpenSpec Integration Smoke Test

This is important.

Most workflow tests correctly use fake infrastructure, but OpenSpec is a central external contract.

CI must contain at least one real smoke/integration test against a pinned supported OpenSpec CLI version.

The test should:

1. create/use a temporary fixture project;
2. initialize/use a minimal OpenSpec configuration as required;
3. exercise the actual CLI through `CliOpenSpecGateway`;
4. verify machine-readable status/instructions;
5. verify artifact-specific instructions;
6. verify resolved artifact path;
7. verify validation;
8. preferably use a small custom schema/artifact naming case.

Do not require model credentials.

Do not call paid APIs.

The smoke test must **not silently skip in CI** because OpenSpec is unavailable.

CI should explicitly install the pinned OpenSpec CLI version first.

If OpenSpec CLI installation fails, the integration job fails.

Keep the OpenSpec version explicit and documented.

---

# 19. CI Job Structure

Split CI into useful visible checks rather than one opaque job.

Recommended shape:

```text
CI
├── quality
│   ├── format check
│   ├── lint
│   └── typecheck
│
├── tests
│   ├── unit/core tests
│   └── coverage thresholds
│
└── openspec-integration
    └── pinned real OpenSpec smoke test
```

Exact YAML organization is flexible.

These should be suitable as required branch-protection checks.

Avoid unnecessary job fragmentation.

---

# 20. Node Version Policy

Inspect the actual project requirement.

If the repository intentionally targets Node 22 only, explicitly document and enforce Node 22.

For example:

```json
"engines": {
  "node": ">=22"
}
```

or a narrower supported policy if appropriate.

Do not add a Node 20 matrix merely to look comprehensive if the project relies on Node 22 functionality such as the current TypeScript execution path.

If Node 20 is genuinely intended to be supported, test it.

Otherwise use Node 22 consistently.

---

# 21. Dependency Security Check

Add an npm dependency audit.

Recommended initial policy:

```text
npm audit --audit-level=high
```

Evaluate the actual dependency tree first.

If the current ecosystem produces unavoidable/noisy findings, keep this job advisory rather than weakening or ignoring vulnerabilities blindly.

Do not use `npm audit fix --force` automatically.

Do not automatically mutate dependencies in CI.

---

# 22. GitHub Actions Hygiene

Use maintained official actions.

Current major-version pinning such as:

```text
actions/checkout@v4
actions/setup-node@v4
```

is acceptable for this task.

Do not introduce unnecessary third-party actions when a shell/npm command is sufficient.

Do not add secrets.

Do not grant write permissions.

Explicitly use least privilege where practical:

```yaml
permissions:
  contents: read
```

---

# 23. Concurrency

Add PR CI concurrency so obsolete runs are cancelled after a new push.

Conceptually:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Use valid GitHub Actions syntax.

This avoids wasting CI on stale Codex pushes.

---

# 24. Branch Protection Documentation

CI cannot configure repository branch protection merely by editing workflow files.

Document the recommended required checks in README/contributor docs if appropriate.

Recommended required checks after this PR:

```text
quality
tests
openspec-integration
```

Recommend:

- require PR before merge;
- require required status checks;
- require branch to be up to date before merge;
- require at least one human approval;
- dismiss stale approvals after new commits.

Do not attempt to modify repository settings from code.

---

# 25. Tests Required for This Remediation

Add regression tests covering at least:

### Validation

- validation finding targets the correct artifact when OpenSpec provides a target;
- validation does not arbitrarily rewrite the first artifact;
- unresolvable validation target does not guess;
- validation repair limit is independent from review limit.

### Review input

- multiple material `needs_input` findings become structured gaps;
- gaps are deduplicated;
- InterviewEngine owns external-gap insertion;
- user answers preserve user provenance.

### Revision dependencies

Given:

```text
A → B → C
```

if A is materially revised, verify downstream stale artifacts are reconsidered according to OpenSpec state/dependencies.

Do not blindly regenerate unrelated D.

### Review prerequisites

- OpenSpec status failure prevents reviewer invocation;
- OpenSpec instructions failure prevents reviewer invocation.

### Artifact reads

- dependency `path-rejected` fails workflow;
- dependency `read-failed` fails workflow;
- no silent cached fallback for these failures.

### Status normalization

- documented OpenSpec statuses normalize correctly at gateway boundary;
- Core does not interpret raw status synonyms;
- compatibility artifact discoveries cannot drive generation.

### Existing behavior

Retain regression coverage for:

- happy path;
- custom artifact names;
- `needs_revision`;
- `needs_input`;
- explicit overwrite during revision;
- writer conflict;
- fresh-context review;
- generation no-progress;
- malformed structured review output;
- final readiness invariant.

---

# 26. Do Not Overengineer

Do NOT introduce:

- generic workflow engine;
- graph execution framework;
- event sourcing;
- database;
- queue;
- agent runtime;
- model router;
- provider router;
- FinOps;
- tracing platform;
- generic validation framework;
- generic issue tracker;
- semantic embeddings;
- vector database.

Use the existing architecture.

Add only the smallest abstractions required to make Step 03 correct.

---

# 27. Preserve Existing Product Boundaries

After remediation, responsibilities should remain:

```text
OpenSpec
    artifact/schema/dependency/path/validation authority

InterviewEngine
    human-information state and questions

SpecificationWorkflow
    product lifecycle orchestration

ArtifactGenerator
    artifact content generation

ArtifactWriter / ArtifactReader
    safe persistence boundary

SpecReviewer
    independent specification-quality review

ModelPort
    generic model invocation

Middleware
    optional semantic guards/observers
```

Do not blur these responsibilities while fixing the bugs.

---

# 28. Verification

Before considering the task complete, run locally:

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run check
```

Also run the real OpenSpec integration test using the pinned CLI version.

Inspect the final diff against `main`.

Confirm that no generated coverage/build/cache files are committed.

---

# 29. Final Codex Report

When finished, provide a concise implementation report containing:

1. review finding → fix mapping;
2. any review recommendation intentionally not implemented and why;
3. OpenSpec CLI version used;
4. new/changed public APIs;
5. new CI jobs;
6. coverage thresholds and actual achieved coverage;
7. commands executed and results;
8. any remaining risks before merge.

Do not merely say “all tests pass.”

---

# Definition of Done

This remediation is complete when:

1. validation repair never arbitrarily targets the first artifact;
2. validation diagnostics preserve actionable OpenSpec information;
3. multiple material review gaps are retained;
4. InterviewEngine owns external-gap integration;
5. revised dependencies cause appropriate downstream reconsideration;
6. Core no longer interprets arbitrary raw OpenSpec status synonyms;
7. gateway implementation metadata does not leak into Core authority decisions;
8. OpenSpec status/instruction failures block review;
9. persisted dependency read failures fail safely;
10. validation repair, generation, and review iteration limits are distinct;
11. mandatory fresh-context review remains intact;
12. final readiness invariant remains centralized;
13. ESLint is configured and passing;
14. Prettier format checking is configured and passing;
15. coverage thresholds are enforced;
16. a real pinned OpenSpec integration smoke test runs in CI without silent skipping;
17. CI exposes useful separate merge checks;
18. CI uses least-privilege permissions and concurrency cancellation;
19. dependency security audit is present with an appropriate required/advisory policy;
20. all regression and remediation tests pass;
21. `npm run check` passes;
22. the PR remains within Step 03 scope;
23. no generic platform/framework has been introduced.

## Guiding principle

Prefer:

```text
deterministic boundary
→ explicit state
→ targeted repair
→ revalidate
→ independent review
```

over:

```text
guess
→ rewrite something
→ hope the next model call catches it
```

And for CI:

```text
tests should protect the architecture's real external contracts,
not only prove that mocks agree with our implementation.
```
