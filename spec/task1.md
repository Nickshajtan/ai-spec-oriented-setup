# Implementation Specification — OpenSpec Authority Cleanup & Artifact I/O Boundary

## Context

The repository already contains the implementation of Specs 01 and 02.

The current product direction is:

> An OpenSpec-based interactive specification assistant that gathers enough material information through an adaptive dialogue/quiz and produces high-quality OpenSpec feature specifications.

The product is a meaningful orchestration layer over OpenSpec, but it must not recreate OpenSpec itself.

OpenSpec remains the authority for:

- change structure;
- schema selection;
- artifact graph;
- artifact dependencies;
- artifact instructions;
- artifact paths;
- validation.

Our Core owns:

- interview state;
- elicitation;
- facts, assumptions and explicit choices;
- gap detection;
- readiness;
- contradiction tracking;
- model-assisted reasoning;
- future artifact generation/review orchestration.

Supporting concerns such as logging and simple limits remain thin middleware.

Model invocation remains behind `ModelPort`. `LiteLLMModelAdapter` is one implementation and must remain thin.

---

# Goal

Prepare the current architecture for Step 03 by removing remaining duplicated OpenSpec domain knowledge from our integration layer and introducing a minimal artifact-writing boundary.

After this change:

```text
OpenSpec CLI
    │
    │ authoritative status / instructions /
    │ artifact graph / artifact paths
    ▼
OpenSpecGateway
    │
    │ normalized transport/domain representation
    ▼
Core
    │
    ├── InterviewEngine
    ├── QuestionPlanner
    └── future ArtifactGeneration workflow
              │
              ▼
        ArtifactWriter
              │
              ▼
          filesystem
```

This specification MUST NOT implement the actual Step 03 artifact-generation workflow.

---

# 1. Inspect Before Modifying

Before making changes, inspect the current implementation and tests, especially:

- `src/openspec/openspec-gateway.ts`
- `src/openspec/types.ts`
- `src/interview/*`
- `src/model/*`
- `src/middleware/*`
- `src/process-runner.ts`
- `src/index.ts`
- existing OpenSpec fixtures/tests
- `docs/integrations/openspec.md`
- `docs/interview-core.md`
- `AGENTS.md`
- `README.md`

Preserve working behavior unless this specification explicitly changes it.

Do not reintroduce previously removed:

- static model routing;
- provider resolution;
- generic execution layer;
- FinOps subsystem;
- audit subsystem;
- control-plane abstractions.

---

# 2. OpenSpec Must Be the Authority

## Problem

The current `CliOpenSpecGateway` still contains knowledge about conventional OpenSpec artifacts.

For example, it explicitly discovers or recognizes concepts such as:

- `proposal.md`
- `design.md`
- `tasks.md`
- `specs/**`
- `.openspec.yaml`

It also manually parses selected `.openspec.yaml` fields.

This creates a second, partial model of OpenSpec inside this project.

That is undesirable.

OpenSpec may evolve, use custom schemas, define additional artifacts, omit standard artifacts, or change artifact dependencies.

Our integration should consume that information rather than independently reconstruct it.

## Required change

Refactor the OpenSpec integration so that authoritative information returned by OpenSpec CLI is preferred wherever the CLI exposes it.

The Core MUST NOT require hardcoded knowledge of:

```text
proposal
design
tasks
specs
```

to operate.

Artifacts should instead be represented generically.

Conceptually:

```ts
interface OpenSpecArtifact {
  id: string;
  path?: string;
  status?: string;
  dependencies?: string[];
  instructions?: unknown;
  metadata?: Record<string, unknown>;
}
```

This is illustrative, not a mandatory exact interface.

Choose names/types that fit the existing codebase.

---

# 3. Do Not Narrow OpenSpec

This cleanup must not throw away useful OpenSpec information merely because the current Interview Engine does not use it yet.

When OpenSpec returns useful structured information that does not deserve a first-class typed property yet, preserve it through an extensible representation.

Prefer a model similar to:

```text
known domain fields
+
generic metadata / raw structured payload
```

rather than:

```text
pick five fields we currently understand
and discard everything else
```

The integration boundary may normalize OpenSpec data, but it must not artificially narrow OpenSpec's model.

---

# 4. Remove Manual OpenSpec Metadata Interpretation Where Redundant

Review the current manual `.openspec.yaml` parsing.

If the OpenSpec CLI already exposes equivalent authoritative information, remove the duplicate parser.

Do not build or introduce a general YAML parser merely to reproduce information OpenSpec already provides.

Filesystem inspection is acceptable only where it provides infrastructure behavior that the OpenSpec CLI does not provide.

Examples:

- verifying that a resolved path exists;
- safely reading/writing a known artifact path;
- enforcing project-root/path-traversal boundaries.

It must not become a second schema interpreter.

---

# 5. Preserve Raw OpenSpec Information

The gateway should make it possible for future Core behavior to use information OpenSpec understands today without modifying the gateway for every new field.

For relevant CLI responses, preserve the structured raw result in addition to normalized fields where useful.

For example:

```ts
interface OpenSpecCommandResult<T> {
  normalized: T;
  raw?: unknown;
}
```

Do not mechanically introduce this exact abstraction if the current types already provide an equivalent mechanism.

The principle matters:

> normalization must not destroy information.

---

# 6. Generic Artifact Representation

Replace standard-artifact-specific representation where practical with a generic artifact collection/graph.

The desired conceptual model is:

```text
OpenSpec Change
    │
    ├── Artifact A
    │      dependencies: [...]
    │      path: ...
    │      status: ...
    │
    ├── Artifact B
    │      dependencies: [...]
    │      path: ...
    │      status: ...
    │
    └── Artifact N
```

Core code should be capable of consuming custom OpenSpec schemas without needing code changes merely because artifact names differ.

Do not implement our own dependency resolver if OpenSpec already determines what artifact is available/required next.

---

# 7. OpenSpecGateway Responsibilities

After refactoring, `OpenSpecGateway` should remain a thin anti-corruption boundary around OpenSpec.

Its responsibilities may include:

```ts
createChange(...)
getStatus(...)
getInstructions(...)
validate(...)
```

and other similarly thin operations if required by the actual installed OpenSpec CLI.

It MAY:

- invoke OpenSpec CLI safely;
- normalize CLI failures;
- expose structured OpenSpec results;
- enforce safe project/change paths;
- preserve raw OpenSpec output;
- emit domain middleware events.

It MUST NOT:

- implement OpenSpec schema semantics itself;
- independently determine artifact dependencies;
- decide which standard artifacts should exist;
- implement artifact-generation orchestration;
- generate specification prose;
- make model calls;
- become a generic process framework.

---

# 8. Verify Actual OpenSpec CLI Contract

Do not guess OpenSpec commands or response fields.

Before implementing the refactor, inspect the OpenSpec version/API available to this repository and verify the actual CLI behavior used for:

- change creation;
- change status;
- artifact/change instructions;
- validation;
- artifact paths;
- artifact dependency/status information.

Prefer machine-readable CLI output when available.

If a required piece of information is genuinely unavailable from OpenSpec CLI, document that limitation and implement the smallest safe fallback.

Any fallback MUST be isolated and explicitly identified as compatibility behavior rather than treated as canonical OpenSpec semantics.

---

# 9. Introduce ArtifactWriter Port

Introduce a deliberately small filesystem-writing abstraction.

For example:

```ts
export interface ArtifactWriter {
  write(input: WriteArtifactInput): Promise<WriteArtifactResult>;
}
```

A reasonable input shape may contain:

```ts
interface WriteArtifactInput {
  projectRoot: string;
  path: string;
  content: string;
}
```

Exact naming is flexible.

The abstraction should express one capability:

> persist generated artifact content to a resolved project-relative path.

Nothing more.

---

# 10. Filesystem ArtifactWriter

Provide the default Node filesystem implementation.

For example:

```text
ArtifactWriter
    ↑
NodeArtifactWriter
```

The implementation must:

- resolve paths relative to `projectRoot`;
- reject path traversal outside `projectRoot`;
- reject malformed/unsafe paths;
- create required parent directories when appropriate;
- write UTF-8 text;
- return a small normalized result.

Use Node filesystem APIs directly.

Do not introduce a filesystem framework or dependency.

---

# 11. ArtifactWriter Must Not Understand OpenSpec

This boundary is intentionally generic.

Bad:

```ts
writer.writeProposal(...)
writer.writeDesign(...)
writer.writeTasks(...)
```

Good:

```ts
writer.write({
  projectRoot,
  path,
  content,
});
```

The writer must not know:

- OpenSpec artifact names;
- OpenSpec schemas;
- dependency ordering;
- interview state;
- models;
- prompts;
- review logic.

OpenSpec/Core decides **what and where**.

ArtifactWriter only performs **safe persistence**.

---

# 12. Overwrite Semantics

Do not silently overwrite existing artifacts by accident.

Define explicit behavior.

Recommended API:

```ts
interface WriteArtifactInput {
  projectRoot: string;
  path: string;
  content: string;
  overwrite?: boolean;
}
```

Default:

```text
overwrite = false
```

If the file exists and overwrite is false, return/throw a typed conflict result.

Future review/regeneration workflows will be able to explicitly request replacement.

Do not introduce versioning, backups, snapshots or transactions in this step.

---

# 13. Atomicity

Use the simplest reliable filesystem behavior appropriate for text artifacts.

If an atomic temp-file + rename implementation can be added cleanly and cheaply, prefer it.

However, do not build a transactional filesystem subsystem.

The hierarchy is:

```text
safe > simple > sophisticated
```

---

# 14. Domain Events

Artifact writing should expose semantic middleware extension points.

Add only the events that are useful at the domain boundary, such as:

```text
artifact.write.before
artifact.write.after
```

Do not add events for:

```text
file.open
file.chunk.write
directory.create
filesystem.rename
```

Middleware observes semantic actions, not implementation details.

The `before` event must allow existing policy middleware such as limits/guards to deny or require human intervention before persistence occurs.

---

# 15. Keep Middleware Thin

Do not expand middleware architecture in this specification.

Existing thin bundled middleware remains appropriate:

- logging observer;
- simple limits guard.

The new artifact-write events should merely participate in the existing extension mechanism.

Do not implement:

- tracing backend;
- telemetry platform;
- event persistence;
- message broker;
- plugin discovery;
- event replay;
- workflow engine.

---

# 16. Keep ModelPort and LiteLLM Thin

Do not redesign `ModelPort`.

Do not expand `LiteLLMModelAdapter`.

The existing architecture:

```text
Core
  ↓
ModelPort
  ↓
LiteLLMModelAdapter
  ↓
LiteLLM
```

is sufficient.

Do not add:

- model router;
- semantic tiers;
- provider resolver;
- provider SDK adapters;
- retry orchestration;
- fallback chains;
- cost optimizer.

Those belong outside this product if they become necessary.

---

# 17. Structured Model Output — Small Shared Utility

The current `ModelQuestionPlanner` contains local logic for extracting/parsing JSON from model output.

Step 03 will introduce at least one more structured model consumer: specification review.

Avoid duplicating this parser.

Extract the smallest useful shared utility for structured JSON model responses.

For example:

```ts
parseModelJson(...)
```

or equivalent.

It may:

- accept plain JSON;
- tolerate surrounding Markdown/code-fence noise if currently necessary;
- reject malformed output clearly.

If the project already has a lightweight schema-validation mechanism, reuse it.

Otherwise do NOT introduce a large validation framework solely for this.

This is a utility, not a model-output subsystem.

Update `ModelQuestionPlanner` to use it.

---

# 18. Contradiction Detection

Do not build semantic contradiction analysis in this step.

The current deterministic contradiction handling may remain as a cheap guard.

Its limitation should be documented:

> deterministic contradiction detection only catches directly comparable previously collected answers; semantic contradictions across different facts are expected to be detected by later model-assisted review.

Do not introduce embeddings, semantic parsers, classifiers or extra model calls here.

---

# 19. Interview Core

Do not redesign the working interview state model.

Preserve concepts such as:

- facts;
- provenance;
- assumptions;
- choices;
- questions;
- unresolved questions;
- contradictions;
- readiness.

Only adapt its OpenSpec-facing types as required by the generic OpenSpec artifact model.

The Interview Engine must continue to consume OpenSpec context without needing to understand hardcoded standard artifact names.

---

# 20. No Artifact Generation Yet

This specification creates the boundary needed by Step 03.

It MUST NOT yet implement:

```text
Interview READY
→ generate proposal
→ generate specs
→ generate design
→ generate tasks
→ review
→ regenerate
```

Specifically do not add:

- `ArtifactGenerator`;
- `SpecReviewer`;
- generation prompts;
- review prompts;
- regeneration loops;
- artifact orchestration;
- automatic transition from interview readiness into generation.

Those belong to the next implementation specification.

---

# 21. Tests

Add/update tests covering at minimum:

### OpenSpec integration

- gateway uses verified OpenSpec CLI commands;
- generic artifact information is preserved;
- custom/non-standard artifact names do not break normalization;
- raw structured OpenSpec information is retained where designed;
- path safety remains enforced;
- CLI unavailable/failure behavior remains normalized;
- validation behavior remains intact.

### ArtifactWriter

- writes a UTF-8 artifact;
- creates necessary parent directory;
- rejects path traversal;
- does not overwrite by default;
- overwrites only when explicitly allowed;
- emits before/after middleware events;
- middleware deny prevents the write;
- middleware require-human prevents the write.

### Structured model utility

- parses valid JSON;
- handles currently supported wrapper/noise format;
- rejects invalid model output;
- `ModelQuestionPlanner` uses the shared implementation.

### Regression

Existing interview tests must remain green.

Existing model adapter tests must remain green.

Existing middleware tests must remain green.

---

# 22. Documentation

Update relevant documentation to clearly state the authority boundaries.

The architecture documentation should communicate:

```text
OpenSpec
  = specification schema/artifact authority

Interview Core
  = elicitation and readiness

ModelPort
  = generic model invocation boundary

ArtifactWriter
  = generic safe persistence boundary

Middleware
  = optional semantic extension/guard mechanism
```

Explicitly document that this project does not own OpenSpec artifact semantics.

Document the ArtifactWriter as infrastructure rather than specification-domain logic.

---

# 23. Public Exports

Expose only useful public boundaries from `src/index.ts`.

Likely public APIs include:

```text
InterviewEngine
QuestionPlanner
ModelPort
OpenSpecGateway
ArtifactWriter
```

plus default implementations where appropriate.

Avoid exporting internal parsing helpers merely because they exist.

---

# 24. Cleanup

While implementing this specification, remove obsolete code/docs/tests that still describe the previous architecture.

Specifically search for stale concepts such as:

```text
StaticModelRouter
semantic model tiers
provider resolver
ModelExecutor
audit subsystem
control plane
budget policy
hardcoded proposal/design/tasks assumptions
```

Do not delete historical implementation specifications under `spec/` merely because they describe completed work unless repository convention explicitly treats them as temporary files.

Do remove runtime/documentation references that incorrectly present obsolete concepts as current architecture.

---

# Non-goals

This specification does NOT implement:

- CLI user interface;
- skill facade;
- pipe mode;
- artifact generation;
- artifact review;
- regeneration;
- automatic interview resume after review;
- model routing;
- FinOps;
- semantic parsing subsystem;
- semantic contradiction engine;
- persistent sessions;
- database;
- web API;
- UI;
- autonomous agent;
- generic workflow engine.

---

# Expected Architecture After Completion

```text
                 ┌──────────────────┐
                 │     OpenSpec     │
                 │ CLI + schemas    │
                 └────────┬─────────┘
                          │
                 authoritative data
                          │
                          ▼
                ┌───────────────────┐
                │  OpenSpecGateway  │
                └─────────┬─────────┘
                          │
                          ▼
                ┌───────────────────┐
                │  Interview Core   │
                │                   │
                │ facts             │
                │ assumptions       │
                │ choices           │
                │ gaps              │
                │ contradictions    │
                │ readiness         │
                └──────┬─────┬──────┘
                       │     │
             model use │     │ future generated
                       ▼     │ artifact
                 ┌─────────┐ │
                 │ModelPort│ │
                 └────┬────┘ │
                      │      ▼
                ┌─────▼──┐ ┌──────────────┐
                │LiteLLM │ │ArtifactWriter│
                └────────┘ └──────┬───────┘
                                  │
                                  ▼
                              filesystem

MiddlewareBus surrounds semantic boundaries as an optional
extension/guard mechanism.
```

---

# Definition of Done

This specification is complete when:

1. OpenSpec CLI is the authoritative source for artifact/schema/status/instruction information wherever supported.
2. Core no longer depends on hardcoded `proposal/design/tasks/specs` semantics.
3. Useful OpenSpec information is not discarded merely because Core does not currently understand it.
4. Manual OpenSpec metadata parsing is removed where redundant.
5. Any unavoidable compatibility fallback is isolated and documented.
6. A minimal generic `ArtifactWriter` port exists.
7. A safe Node filesystem implementation exists.
8. Existing files are not overwritten unless explicitly requested.
9. Artifact writes participate in semantic middleware before/after events.
10. Structured model JSON parsing is factored into a small reusable utility.
11. Interview behavior remains functional.
12. LiteLLM remains a thin `ModelPort` implementation.
13. No artifact generation or review workflow has been implemented yet.
14. Tests cover the new boundaries and regressions.
15. Documentation reflects the resulting architecture.
16. `npm run check` passes.
17. CI remains green.

## Final implementation principle

When choosing between:

> reproducing OpenSpec behavior inside this repository

and

> asking OpenSpec for the information and consuming it generically

choose the second.

When choosing between:

> adding another subsystem

and

> adding a small port/helper/middleware

prefer the smallest abstraction that preserves future extensibility.
