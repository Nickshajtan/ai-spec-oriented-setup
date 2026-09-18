# OpenSpec Gateway

`CliOpenSpecGateway` is a thin integration over the official OpenSpec CLI. OpenSpec remains authoritative for schema, artifact graph, artifact dependencies, templates, instructions, resolved paths, and validation.

The gateway enriches OpenSpec information for Specifier runtime use, but it must not replace OpenSpec with a narrower internal artifact model.

## Runtime Dependency

The gateway expects `openspec` on `PATH` unless a custom command is passed. Commands are executed through `ProcessRunner` with executable and arguments separated; shell command strings are not constructed.

Verified with OpenSpec CLI `1.12.0`, the gateway uses:

```text
openspec new change <change-name> --json
openspec status --change <change-name> --json
openspec instructions --change <change-name> --json
openspec instructions <artifact-id> --change <change-name> --json
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

if (result.status === "status-read") {
  console.log(result.context?.openspec.artifacts);
}
```

## Context Shape

`SpecContext` keeps OpenSpec context under `context.openspec` and leaves room for later `interview` and `review` enrichment. CLI JSON output is preserved as `raw` alongside generic normalized fields.

Artifacts are represented generically:

```ts
{
  id: "capability-brief",
  path: "openspec/changes/example/capability.md",
  status: "missing",
  dependencies: ["context-note"],
  instructions: {},
  metadata: {},
  raw: {}
}
```

The gateway does not know that any particular schema must contain `proposal`, `design`, `tasks`, or `specs`.

## Supported Operations

Current gateway methods:

- `createChange`
- `getStatus`
- `getInstructions`
- `getArtifactInstructions`
- `validate`

These methods are intentionally thin. If the OpenSpec CLI provides machine-readable output, preserve that output instead of inventing local dependency rules.

## Generation Authority

The gateway preserves both normalized data and raw CLI JSON. Compatibility normalization may still discover artifact-like data in older or unusual responses, but Core generation decisions use only documented artifact fields normalized from top-level OpenSpec artifact payloads. Compatibility discoveries are context, not authority for what to generate or where to write.

`SpecificationWorkflow` asks OpenSpec for artifact-specific instructions before generation. The resolved artifact path from OpenSpec is passed directly to `ArtifactWriter`; generation code must not construct standard paths such as `proposal.md`, `design.md`, `tasks.md`, or `specs/...`.

## Compatibility Fallback

The gateway still checks that `openspec/` exists and, for existing-change operations, that the requested change directory exists. This is path safety and command hygiene, not schema interpretation.

The bundled fixture contains legacy `.openspec.yaml` metadata with `schema: "1.0.0"`. OpenSpec CLI `1.12.0` reports that schema as unknown for `status` and `instructions`, even with a schema flag. Tests therefore mock those JSON responses when verifying generic artifact normalization. Validation remains covered against the real CLI.

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
