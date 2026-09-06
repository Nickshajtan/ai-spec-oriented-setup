# OpenSpec Adapter

## Purpose

`OpenSpecAdapter` is the first integration bridge on top of the vendor-neutral middleware kernel. It inspects one OpenSpec change in a consumer repository, runs official OpenSpec CLI validation, normalizes a small amount of metadata and artifact references, emits semantic middleware events, and returns a structured result.

This is an adapter, not an OpenSpec implementation.

## Runtime Dependency

The adapter relies on the official OpenSpec CLI being available on `PATH` unless a custom command is passed.

Validation command:

```text
openspec validate <change-name> --json --no-interactive
```

The adapter passes command and arguments separately through `ProcessRunner`; it does not build shell command strings.

## API Example

```ts
import { MiddlewareBus, OpenSpecAdapter } from "../src/index.ts";

const bus = new MiddlewareBus();
const adapter = new OpenSpecAdapter({ bus });

const result = await adapter.inspect({
  projectRoot: "/path/to/project",
  changeName: "add-health-check",
});

if (result.status === "valid") {
  console.log(result.context?.artifacts.proposal?.path);
}
```

## Normalized Context

Successful validation execution returns a provider-neutral `SpecContext`:

```ts
{
  system: "openspec",
  changeName: "add-health-check",
  projectRoot: "/path/to/project",
  metadata: {
    schema: "1.0.0",
    created: "2026-09-05",
    goal: "Add a simple health check capability.",
    affectedAreas: ["api", "ops"],
    skipSpecs: false
  },
  artifacts: {
    proposal: { kind: "proposal", path: "openspec/changes/add-health-check/proposal.md" },
    design: { kind: "design", path: "openspec/changes/add-health-check/design.md" },
    tasks: { kind: "tasks", path: "openspec/changes/add-health-check/tasks.md" },
    metadata: { kind: "metadata", path: "openspec/changes/add-health-check/.openspec.yaml" },
    specs: []
  },
  validation: {
    valid: true,
    exitCode: 0,
    stdout: "...",
    stderr: "..."
  },
  taskProgress: {
    completed: 1,
    total: 2
  }
}
```

Only known `.openspec.yaml` fields are normalized:

```text
schema
created
goal
affected_areas
skip_specs
```

Unknown metadata fields are ignored. The adapter does not infer risk, complexity, model tier, or security category from prose.

## Middleware Events

The adapter emits:

```text
spec.validate.before
spec.validate.after
```

Flow:

```text
inspect request
  -> spec.validate.before
  -> openspec validate <change-name> --json --no-interactive
  -> normalize result
  -> spec.validate.after
  -> return result
```

Middleware decisions are respected:

```text
deny before validation          -> CLI is not executed
require-human before validation -> CLI is not executed
deny after validation           -> result includes normalized context and halted status
require-human after validation  -> result includes normalized context and halted status
```

## Error Behavior

Structured result statuses:

```text
valid
invalid
missing-change
project-not-initialized
cli-unavailable
command-failed
middleware-denied
requires-human
path-rejected
```

`invalid` means the official OpenSpec validation command ran and returned a non-zero exit code. Missing changes, unavailable CLI, path traversal, and command execution failures are distinct statuses.

## Artifact Discovery

The adapter only discovers standard files inside the requested change:

```text
proposal.md
design.md
tasks.md
.openspec.yaml
specs/**
```

Artifacts are represented as references. Markdown content is not executed.

Task progress uses isolated checkbox counting in `tasks.md` as a fallback because this adapter does not currently depend on an official structured task-progress command.

## Security Boundary

`projectRoot` and `changeName` are treated as untrusted input.

The adapter:

```text
prevents path traversal
uses command + args instead of shell strings
does not execute markdown
does not execute OpenSpec tasks
does not follow commands contained in artifacts
does not inspect unrelated repository files
```

## Deliberately Out Of Scope

Do not add these here:

```text
OpenSpec initialization, apply, archive, sync, or generation
model routing
LiteLLM or OpenRouter
Langfuse
Claude/Codex/Gemini adapters
LLM calls
task execution
automatic spec modification
workflow orchestration
```
