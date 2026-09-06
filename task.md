# Task: Implement the first OpenSpec integration bridge

## Context

The repository already contains a minimal vendor-neutral middleware kernel.

Do not redesign or expand that kernel unless strictly necessary.

This task adds the first real integration on top of it:

> Read an OpenSpec change from a consumer repository, normalize its metadata/state, validate it through the official OpenSpec CLI, and emit semantic middleware events.

This is an adapter.

It is NOT an OpenSpec replacement.

It must not reimplement OpenSpec parsing/validation rules that OpenSpec itself already owns.

---

# Goal

Given:

```text
/path/to/project
openspec/changes/<change-name>/
```

the control-plane library should be able to:

1. locate the requested OpenSpec change;
2. invoke official OpenSpec validation;
3. read minimal relevant metadata/artifacts;
4. normalize them into an internal `SpecContext`;
5. emit semantic middleware events;
6. return a structured result.

No AI model execution yet.

---

# 1. Architectural boundary

The adapter must treat OpenSpec as an external system.

OpenSpec owns:

* spec format;
* change layout;
* validation rules;
* lifecycle;
* archive behavior;
* task representation.

Our control plane owns:

* normalized execution context;
* semantic events;
* middleware decisions;
* future policy/routing integration.

Do not duplicate OpenSpec behavior.

---

# 2. Adapter API

Introduce a small adapter interface conceptually similar to:

```ts
interface SpecAdapter {
  inspect(input: SpecInspectInput): Promise<SpecInspectionResult>;
}
```

OpenSpec implementation:

```ts
class OpenSpecAdapter implements SpecAdapter
```

Input should contain only what is needed, for example:

```ts
interface SpecInspectInput {
  projectRoot: string;
  changeName: string;
}
```

Do not make the adapter depend on the current process working directory.

---

# 3. Normalized SpecContext

Create a provider-neutral representation.

Conceptually:

```ts
interface SpecContext {
  system: "openspec";

  changeName: string;
  projectRoot: string;

  metadata?: {
    schema?: string;
    created?: string;
    goal?: string;
    affectedAreas?: string[];
    skipSpecs?: boolean;
  };

  artifacts: {
    proposal?: ArtifactRef;
    design?: ArtifactRef;
    tasks?: ArtifactRef;
    specs: ArtifactRef[];
  };

  validation: {
    valid: boolean;
    exitCode: number;
    findings?: unknown[];
  };

  taskProgress?: {
    completed: number;
    total: number;
  };
}
```

Adapt this to the actual language and existing contracts.

Do not parse arbitrary prose into semantic meaning yet.

For example, do NOT infer:

* risk level;
* architecture complexity;
* model tier;
* security category.

Those belong to future layers.

---

# 4. OpenSpec metadata

Read `.openspec.yaml` when present.

Support only currently documented metadata needed for the normalized context:

```text
schema
created
goal
affected_areas
skip_specs
```

Ignore unknown keys.

Do not implement OpenSpec's validation rules yourself.

Invalid metadata should ultimately be reflected by the official OpenSpec validation/inspection result.

---

# 5. Official CLI integration

Use the official `openspec` CLI for validation.

Expected command should be equivalent to:

```bash
openspec validate <change-name> --json --no-interactive
```

or another official structured-output command if repository inspection proves more suitable.

Important:

* never scrape human-readable terminal output when JSON is available;
* capture stdout;
* capture stderr;
* capture exit code;
* distinguish:

  * CLI unavailable;
  * project not initialized;
  * change not found;
  * change invalid;
  * command execution failure.

Wrap these into typed adapter errors/results.

Do not hide the underlying reason.

---

# 6. Middleware lifecycle

Use the semantic middleware kernel.

For inspection/validation emit:

```text
spec.validate.before
spec.validate.after
```

Expected flow:

```text
load request
   ↓
spec.validate.before
   ↓
middleware
   ↓
OpenSpec CLI validation
   ↓
normalize result
   ↓
spec.validate.after
   ↓
middleware
   ↓
return SpecInspectionResult
```

The adapter must respect middleware results already supported by the kernel.

For example:

* policy deny before validation → do not run OpenSpec;
* require-human → stop cleanly;
* fail-closed middleware error → stop;
* observer errors obey existing semantics.

Do not add new middleware action types.

---

# 7. Artifact discovery

Discover only standard artifacts inside the requested change:

```text
proposal.md
design.md
tasks.md
specs/**
.openspec.yaml
```

Represent them as references.

Do not load every file fully into memory unless necessary.

Do not recursively inspect unrelated repository files.

Path handling must prevent escaping the consumer project/change directory.

---

# 8. Task progress

If practical using official OpenSpec structured commands, expose simple task progress:

```text
completed / total
```

Prefer official OpenSpec output over manually interpreting task syntax.

If official structured output cannot provide this cleanly, manual checkbox counting inside `tasks.md` is acceptable only as a small isolated fallback and must be documented.

Do not build a task execution engine.

---

# 9. Process runner abstraction

Do not hard-wire process execution throughout the adapter.

Create or reuse a tiny abstraction such as:

```ts
interface ProcessRunner {
  run(command, args, options): Promise<ProcessResult>;
}
```

This is primarily for testing.

Do not build a generic shell framework.

Requirements:

* command + args separated;
* no shell string concatenation;
* configurable working directory;
* timeout support if existing project conventions make this straightforward;
* stdout/stderr/exit code captured.

---

# 10. Security constraints

Project root and change name are untrusted inputs.

Requirements:

* prevent path traversal;
* do not interpolate them into shell strings;
* do not execute content from OpenSpec markdown;
* do not execute tasks from `tasks.md`;
* do not follow arbitrary commands contained in artifacts.

This adapter reads and validates specifications only.

---

# 11. Tests

Tests are mandatory.

Use temporary fixture repositories.

Cover at minimum:

## Valid change

Given a valid OpenSpec fixture:

* adapter finds it;
* validation succeeds;
* metadata is normalized;
* artifacts are listed;
* before/after events fire.

## Invalid change

* official validation failure returns `valid: false`;
* reason/output remains inspectable;
* `spec.validate.after` still fires where appropriate.

## Missing change

* typed failure/result;
* no misleading "invalid spec" result.

## OpenSpec CLI unavailable

* distinct error;
* actionable message.

## Middleware deny

At `spec.validate.before`:

* validation command is not executed.

## Middleware require-human

* validation command is not executed;
* result reflects halted execution.

## Middleware ordering

* existing kernel semantics are preserved.

## Path traversal

Inputs such as:

```text
../../something
```

must be rejected.

## Metadata

* known `.openspec.yaml` fields normalize correctly;
* unknown fields do not break the adapter.

## Optional artifacts

* missing `design.md` is allowed;
* adapter handles tooling/doc-only changes where specs may legitimately be absent.

---

# 12. Integration fixture

Add one tiny sample OpenSpec project under tests/fixtures or equivalent.

Do not turn it into production configuration.

Fixture should contain one simple change such as:

```text
add-health-check
```

with enough artifacts to demonstrate validation and normalization.

---

# 13. Documentation

Add concise documentation:

```text
docs/integrations/openspec.md
```

Explain:

* what the adapter does;
* what it deliberately does not do;
* runtime dependency on OpenSpec CLI;
* example API call;
* resulting normalized context;
* middleware events emitted;
* error behavior.

---

# Non-goals

Do NOT implement:

* OpenSpec initialization;
* OpenSpec proposal generation;
* OpenSpec apply;
* OpenSpec archive;
* OpenSpec sync;
* OpenSpec verification workflow;
* model routing;
* LiteLLM;
* OpenRouter;
* Langfuse;
* Claude/Codex adapters;
* LLM calls;
* task execution;
* automatic spec modification;
* parsing proposal prose into AI metadata;
* autonomous workflow orchestration.

Especially:

Do not add:

```text
controlPlane.runFeature(...)
```

yet.

This task only introduces the integration boundary.

---

# Definition of Done

The task is complete when:

1. A generic `SpecAdapter` boundary exists, or an equivalent minimal abstraction justified by the implementation.
2. `OpenSpecAdapter` exists.
3. Consumer repository root is supplied explicitly.
4. OpenSpec validation uses the official CLI.
5. Structured CLI output is preferred where available.
6. `.openspec.yaml` known metadata is normalized.
7. Standard change artifacts are represented.
8. `spec.validate.before` is emitted.
9. `spec.validate.after` is emitted.
10. Existing middleware decisions are respected.
11. No provider/model/agent integration is introduced.
12. No OpenSpec validation logic is duplicated unnecessarily.
13. Path traversal is prevented.
14. Shell command injection is prevented.
15. Process execution is testable without invoking a real shell in unit tests.
16. Unit tests pass.
17. At least one integration test runs against a real OpenSpec fixture if the CLI is available in CI/dev environment.
18. Existing lint/type/test checks pass.
19. Documentation exists.
20. Final response reports:

    * changed files;
    * tests run;
    * exact OpenSpec CLI commands relied upon;
    * any OpenSpec assumptions made;
    * architectural decisions;
    * deliberately deferred work.

## Final instruction

Do not implement routing, provider integration, orchestration, or AI execution.

When this adapter can inspect and validate one OpenSpec change through the middleware kernel, stop.
