# Implementation Specification — Repository Realignment and Engineering Baseline

## Context

This repository has changed direction.

The product is now an **OpenSpec-based interactive feature specification assistant**.

Its purpose is to guide a human through an adaptive dialogue/quiz, collect missing implementation information, detect material gaps/ambiguities/contradictions, generate native OpenSpec changes through OpenSpec's own workflow, and always perform a final AI review.

The repository currently contains infrastructure from an earlier generic AI control-plane direction. Preserve useful primitives, but remove or demote infrastructure that does not serve the new product.

Do not rewrite working code unnecessarily.

## Product boundary

Target conceptual architecture:

```text
Agent Skill ─────────────┐
                        │
CLI / Agent Launcher ───┤
                        ▼
                 Specifier Core
                 ├── Interview
                 ├── enriched spec context
                 ├── gap/ambiguity handling
                 ├── OpenSpec orchestration
                 └── mandatory review
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
    OpenSpecGateway   ModelPort   Domain EventBus
          │             │
     OpenSpec CLI   LiteLLM adapter

Optional cross-cutting behavior:
Domain EventBus → middleware
```

OpenSpec is the canonical specification framework. The project enriches OpenSpec; it must not replace it with a narrower internal specification model.

## 1. Inspect before modifying

Before implementation:

1. Inspect the entire current repository.
2. Identify all consumers of:
    - routing;
    - provider resolution;
    - model execution;
    - audit;
    - middleware events;
    - OpenSpec adapter;
    - shared types.
3. Run the current tests and record the baseline.
4. Preserve valuable code where compatible with this specification.

Do not retain obsolete architecture merely to keep old tests passing.

---

## 2. Remove model routing from the product

Model routing is a separate future product/service.

Remove the current model-routing subsystem from active production architecture, including obsolete:

- `StaticModelRouter`;
- semantic model tiers;
- risk/complexity promotion rules;
- task-type-to-model routing;
- model-tier middleware/examples;
- routing-specific documentation and tests.

If the existing routing implementation contains genuinely non-trivial reusable code, move only that valuable prototype into a clearly isolated location such as:

```text
future-tools/model-router/
```

Include a README stating that it is:

- not part of Specifier runtime;
- not imported by production code;
- retained only as source material for a future standalone model-routing tool.

Do not archive trivial code that is cheaper to recreate.

---

## 3. Simplify model execution

The Core requires model invocation, especially for mandatory specification review.

However, provider abstraction is delegated to LiteLLM.

Target:

```text
Specifier Core
      ↓
   ModelPort
      ↓
LiteLLMModelAdapter
      ↓
    LiteLLM
```

Create/retain a minimal provider-neutral `ModelPort`.

Conceptually:

```ts
interface ModelPort {
    complete(request: ModelRequest): Promise<ModelResponse>;
}
```

Model request metadata MAY contain semantic purpose such as `interview` or `review`, but the Specifier must not perform routing based on it.

Collapse unnecessary layers around:

- LiteLLM gateway;
- provider resolver;
- model executor.

Prefer one thin `LiteLLMModelAdapter`.

Its responsibilities are limited to:

- mapping `ModelRequest` to the LiteLLM API;
- invoking LiteLLM;
- normalizing the response;
- normalizing relevant errors.

It must NOT implement:

- model routing;
- provider selection;
- dynamic pricing;
- FinOps;
- retries orchestration;
- model scoring;
- provider-specific business logic.

LiteLLM is the only supported standalone LLM backend for v1.

---

## 4. Replace OpenSpecAdapter with an OpenSpec Gateway

OpenSpec must own its lifecycle and artifact schema.

Evolve the existing adapter into a thin `OpenSpecGateway` over the official OpenSpec CLI.

Reuse existing safe process execution and validation logic where appropriate.

The gateway should eventually support operations required by the product such as:

- creating a change;
- obtaining change/artifact status;
- obtaining artifact instructions;
- validation;
- schema discovery where required.

Do NOT implement OpenSpec artifact dependency rules independently.

Do NOT hardcode the assumption that every schema is exactly:

```text
proposal → specs → design → tasks
```

Use machine-readable OpenSpec CLI output wherever available.

OpenSpec CLI remains authoritative for:

- selected schema;
- artifact graph;
- dependencies;
- instructions;
- templates;
- resolved artifact paths;
- validation.

### No lossy OpenSpec normalization

The internal model may extend OpenSpec information but must never reduce OpenSpec into a narrower domain model.

Preserve OpenSpec-defined information without semantic loss.

An enriched context may conceptually contain:

```text
SpecContext
├── OpenSpec context
├── Interview context
└── Review context
```

Do not fully design Interview/Review state in this step.

---

## 5. Keep ProcessRunner as infrastructure

Retain a generic process execution abstraction.

It must:

- accept executable and arguments separately;
- support working directory;
- expose stdout/stderr/exit code;
- support timeout if already implemented or inexpensive to retain;
- avoid shell-string construction.

The same abstraction should be reusable by OpenSpec CLI integration and future agent launchers.

Do not turn ProcessRunner into a process framework.

---

## 6. Reframe middleware

Retain the existing middleware mechanism where useful:

- Observer;
- Policy;
- Transformer;
- deterministic ordering;
- appropriate failure semantics.

Remove generic AI control-plane event vocabulary.

The EventBus should operate on **Specifier domain events**.

Do not finalize a huge event taxonomy yet.

Introduce only events required by existing/new behavior and prepare the API for lifecycle concepts such as:

```text
interview.*
openspec.*
review.*
```

Remove obsolete concepts such as:

```text
model.route.*
task.classify.*
tool.execute.*
```

Technical model-call observability should not masquerade as Specifier domain behavior.

### Architectural invariant

Core owns required product behavior.

Middleware owns optional cross-cutting behavior that observes or influences lifecycle events.

Utilities are not automatically middleware.

---

## 7. Remove audit subsystem

The product does not currently require an audit subsystem.

Remove the dedicated in-memory audit architecture/examples unless some tiny reusable component is genuinely useful.

Do not build:

- immutable audit storage;
- audit sinks;
- retention;
- audit persistence.

Instead, provide a thin optional logging Observer middleware.

Logging may support:

- debug;
- info;
- warn;
- error.

Actual interview decisions/provenance will later belong to domain state, not an audit log.

---

## 8. Add thin default middleware

Provide a very small bundled middleware set.

### LoggingObserver

Optional lifecycle logging.

Core must work correctly without it.

### LimitsGuard

Implement only cheap deterministic guardrails.

Possible configurable limits:

- maximum interview turns;
- maximum review iterations;
- context-size warning threshold;
- artifact-size warning threshold.

Prefer warnings over hard stops except for obvious runaway conditions.

Do NOT implement:

- provider price discovery;
- billing;
- budget accounting;
- dynamic model routing;
- cost optimization;
- provider adapters for FinOps.

Those belong to a future external tool/service.

Keep bundled middleware intentionally small.

---

## 9. Clean shared types

Inspect the current global `src/types.ts`.

Move surviving types to the module/domain that owns them.

Delete obsolete generic control-plane types.

Do not replace it with another dumping ground such as `shared/types.ts`.

Do not prematurely reorganize the entire source tree merely for aesthetics.

---

## 10. Repository hygiene

Remove committed IDE-specific files such as `.idea/` if they are local development artifacts and ensure they are ignored.

Inspect `task.md`.

If it represents obsolete implementation direction, remove it or replace it with current project guidance rather than leaving contradictory instructions for agents.

Clean obsolete docs/examples/tests together with the architecture they describe.

---

## 11. Agent engineering baseline

Add a root `AGENTS.md` as the canonical engineering contract.

It must clearly state:

- product purpose;
- OpenSpec-first architecture;
- OpenSpec must not be reimplemented;
- internal state may enrich but not narrow OpenSpec;
- required Core vs optional middleware boundary;
- model routing is outside this product;
- LiteLLM is the v1 provider abstraction;
- heavy FinOps belongs outside this product;
- semantic domain events;
- avoid speculative abstractions.

Add thin agent-specific guidance where appropriate.

Preserve existing TOML configuration. Do not delete it.

Before adding Claude/Codex skills, inspect existing OpenSpec-generated agent skills/instructions and avoid duplicating functionality OpenSpec already provides.

Skills should represent operational workflows, not module documentation.

---

## 12. CI

Add or normalize scripts:

```text
typecheck
test
check
```

`check` should run the complete local quality gate.

Add GitHub Actions CI for:

- pull requests;
- pushes to `main`.

Use a supported Node LTS version and reproducible dependency installation.

CI must not require:

- real LLM credentials;
- a running LiteLLM instance;
- paid external API calls.

Mock infrastructure boundaries in tests.

Where OpenSpec CLI integration tests require the actual CLI, choose an explicit deterministic strategy and document it.

---

## 13. README

Create/update README to explain:

- what the product actually is;
- that it is OpenSpec-based;
- current development status;
- Core vs middleware vs infrastructure;
- LiteLLM role;
- development commands;
- high-level intended workflow.

Do not market unfinished functionality as complete.

---

## Definition of Done

- Current useful infrastructure has been preserved rather than blindly rewritten.
- Static model routing is no longer part of production architecture.
- Provider resolution/routing complexity has been removed.
- Model invocation has a small `ModelPort`.
- LiteLLM integration is thin.
- OpenSpec integration is moving toward a CLI-backed `OpenSpecGateway`.
- OpenSpec information is not lossily normalized.
- Middleware uses Specifier domain semantics.
- Dedicated audit subsystem is gone.
- Thin logging and deterministic limits middleware exist.
- ProcessRunner remains generic and safe.
- Obsolete shared types/docs/examples/tests are cleaned.
- IDE artifacts are not committed.
- AGENTS.md reflects the new product.
- Existing TOML is preserved.
- CI exists and is green.
- `npm run check` passes.
- No Interview Engine is implemented yet beyond abstractions strictly necessary for this cleanup.

## Non-goals

Do NOT implement yet:

- full interactive interview engine;
- question planning;
- contradiction analysis;
- full artifact generation loop;
- autonomous coding agents;
- generic workflow engine;
- model router;
- provider-selection system;
- full FinOps;
- persistent database;
- web UI;
- queue infrastructure.

Keep this step focused on making the repository an honest foundation for the next implementation.
