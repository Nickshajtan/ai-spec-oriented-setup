# OpenSpec Gateway

`CliOpenSpecGateway` is a thin integration over the official OpenSpec CLI. OpenSpec remains authoritative for schema, artifact graph, artifact dependencies, templates, instructions, resolved paths, and validation.

The gateway enriches OpenSpec information for Specifier runtime use, but it must not replace OpenSpec with a narrower internal artifact model.

## Runtime Dependency

The gateway expects `openspec` on `PATH` unless a custom command is passed. Commands are executed through `ProcessRunner` with executable and arguments separated; shell command strings are not constructed.

Validation command:

```text
openspec validate <change-name> --json --no-interactive
```

## API Example

```ts
import { CliOpenSpecGateway } from "../src/index.ts";

const gateway = new CliOpenSpecGateway();
const result = await gateway.validate({
  projectRoot: "/path/to/project",
  changeName: "add-health-check",
});

if (result.status === "valid") {
  console.log(result.context?.openspec.artifacts.proposal?.path);
}
```

## Context Shape

`SpecContext` keeps OpenSpec context under `context.openspec` and leaves room for later `interview` and `review` enrichment. Metadata preserves raw `.openspec.yaml` text and exposes a small `known` convenience view. CLI JSON output is carried without semantic narrowing.

## Supported Operations

Current gateway methods:

- `createChange`
- `getStatus`
- `getInstructions`
- `validate`

These methods are intentionally thin. If the OpenSpec CLI provides machine-readable output, prefer preserving that output over inventing local dependency rules.

## Middleware Events

The gateway emits Specifier domain events:

```text
openspec.change.create.before
openspec.change.create.after
openspec.status.before
openspec.status.after
openspec.instructions.before
openspec.instructions.after
openspec.validate.before
openspec.validate.after
```

Middleware can observe, deny, require human input, or transform explicit lifecycle metadata. Core OpenSpec behavior does not depend on middleware being installed.

## Integration Tests

Unit tests mock the process runner. The optional real OpenSpec CLI fixture test runs only when `openspec` is available on `PATH`; otherwise it skips. CI therefore does not require installing OpenSpec.
