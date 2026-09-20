# Spec 05 — Thin Core Runtime Bridge, True End-to-End Flow & Targeted Quality Hardening

## 0. Context

Repository:

`Nickshajtan/ai-spec-oriented-setup`

This specification assumes Specs 01, 02, 02.5, 03, and 04 are merged into `main`.

Before modifying anything:

1. inspect the current repository and merged implementation;
2. verify the actual public Core API and `SpecificationWorkflow` contract;
3. verify current OpenSpec integration and project-local skill layout;
4. verify how the Specifier skill currently expects to enter Core;
5. preserve all existing architectural boundaries unless this specification explicitly changes them.

Do not blindly implement examples from this document if the merged code already exposes a cleaner equivalent.

---

# 1. Goal

Close the final missing runtime gap between:

```text
User
 ↓
ai-spec / Specifier skill
 ↓
host agent
 ↓
???
 ↓
SpecificationWorkflow
 ↓
OpenSpec artifacts
```

After this step, the repository must support a real end-to-end product flow:

```text
rough feature idea
 ↓
ai-spec
 ↓
supported host agent
 ↓
Specifier skill
 ↓
thin Core runtime bridge
 ↓
SpecificationWorkflow
 ↓
adaptive interview
 ↓
artifact generation
 ↓
OpenSpec validation
 ↓
independent AI review
 ↓
revision / additional user input when required
 ↓
READY
```

This is the final substantive feature step for v0.1.

The implementation must make the existing Core executable and usable.

It must **not create another specification engine**.

---

# 2. Architectural Principle

There must remain exactly one source of specification behavior:

```text
SpecificationWorkflow
```

The new runtime layer is composition and transport only.

It may:

- construct dependencies;
- create/load workflow state;
- invoke existing Core operations;
- serialize structured requests/results;
- persist the minimum state necessary for continuation;
- expose a stable local entry point for the Specifier skill.

It must NOT decide:

- what questions should be asked;
- whether information is sufficient;
- OpenSpec artifact structure;
- artifact ordering;
- validation policy;
- review outcome;
- revision strategy;
- model routing;
- provider selection;
- specification semantics.

Those remain owned by existing Core components.

---

# 3. Desired Architecture

Prefer a small composition root:

```text
Specifier skill
      ↓
CoreRuntime / application entry point
      ↓
SpecificationWorkflow
      ↓
existing ports
 ├── OpenSpecGateway
 ├── ModelPort
 ├── ArtifactReader
 ├── ArtifactWriter
 ├── MiddlewareBus
 └── existing guards
```

The exact names may differ.

Do NOT introduce:

- generic dependency injection containers;
- service locators;
- application frameworks;
- workflow frameworks;
- command buses;
- CQRS;
- generic RPC frameworks.

Explicit construction is preferred.

---

# 4. Runtime Boundary

Introduce the smallest useful application-facing boundary.

Conceptually:

```ts
interface SpecifierRuntime {
  start(input: StartSpecificationInput): Promise<RuntimeResult>;
  answer(input: AnswerSpecificationInput): Promise<RuntimeResult>;
  status(input: RuntimeSessionInput): Promise<RuntimeResult>;
}
```

Exact API may differ based on the existing `SpecificationWorkflow`.

Add `resume` only if it represents behavior genuinely distinct from `status` or `answer`.

Do not add commands merely for symmetry.

The runtime should expose existing workflow behavior rather than duplicate it.

---

# 5. Runtime Result

The runtime must return a small structured result that the skill can reliably interpret.

For example:

```ts
type RuntimeResult =
  | {
      status: "needs-input";
      sessionId: string;
      question: ...;
    }
  | {
      status: "ready";
      sessionId: string;
      changeName: string;
      changePath: string;
      artifacts: ...;
      validation: ...;
      review: ...;
    }
  | {
      status: "failed";
      sessionId?: string;
      error: ...;
    };
```

Reuse existing Core types where appropriate.

Do not build a second set of workflow-domain models.

The runtime representation should be a thin application contract.

---

# 6. Runtime Transport for Agent Skills

Provide a concrete repository-local executable or equivalent stable invocation surface that Codex/Claude can call.

Prefer something conceptually similar to:

```text
ai-spec-core start ...
ai-spec-core answer ...
ai-spec-core status ...
```

or a clearly namespaced equivalent.

The exact UX is secondary.

Requirements:

- machine-readable input/output;
- JSON preferred;
- stdout reserved for structured result where practical;
- diagnostics/errors must not corrupt structured output;
- meaningful process exit codes;
- no interactive prompting inside the Core runtime executable;
- host agent remains responsible for presenting questions to the human;
- runtime executable remains responsible for executing Core.

Do not expose internal classes directly through fragile ad-hoc scripts if a tiny stable executable boundary is cleaner.

Do not build an HTTP server.

Do not build a daemon.

Do not build sockets.

Everything remains local and process-based.

---

# 7. Skill Integration

Update the canonical Specifier skill so it invokes the real runtime bridge.

The skill must no longer rely on vague instructions such as:

```text
use the exported SpecificationWorkflow
```

without a concrete execution mechanism.

Instead, its behavior should become approximately:

```text
invoke runtime start
 ↓
inspect structured result
 ↓
if needs-input:
    present Core question
    collect human answer
    invoke runtime answer
    repeat
 ↓
if ready:
    report result
 ↓
if failed:
    report actionable failure
```

The skill remains a facade.

It must not recreate workflow decisions.

Keep the canonical skill + generated/synchronized Codex/Claude representations introduced by Spec 04.

---

# 8. Dependency Composition

Add one explicit composition root for production runtime dependencies.

It should wire the existing implementations, such as:

```text
OpenSpecGateway
ModelPort implementation
ArtifactReader
ArtifactWriter
MiddlewareBus
guards
SpecificationWorkflow
```

Use the actual merged repository components.

Do not add an IoC/DI library.

Dependency construction should be easy to inspect in one place.

---

# 9. Model Configuration

The runtime needs enough configuration to instantiate the existing `ModelPort`.

Keep this deliberately small.

The runtime may read documented environment/configuration required by the existing LiteLLM adapter.

Do NOT add:

- provider routing;
- automatic model selection;
- pricing;
- FinOps;
- provider fallback;
- credential management system;
- secrets vault;
- configuration framework.

Fail clearly when required model configuration is absent.

Do not silently choose undocumented providers or credentials.

---

# 10. Session Persistence

A workflow that requires multiple human answers must survive separate runtime invocations.

Implement the minimum persistence required for:

```text
start
 ↓
needs-input
 ↓
process exits
 ↓
answer
 ↓
workflow continues
```

Prefer a small project-local state store.

For example:

```text
<project-local-runtime-dir>/
    sessions/
        <session-id>.json
```

The exact location must be chosen deliberately and documented.

Requirements:

- project-local;
- deterministic;
- no database;
- no Redis;
- no server;
- no event sourcing;
- no cloud persistence;
- no global user state;
- atomic enough to avoid obvious truncated-state corruption;
- state schema explicitly versioned if persistence format may outlive a process;
- session IDs must be safe for filesystem use;
- session lookup must not allow path traversal;
- do not store API secrets;
- persist structured state, not raw unrestricted model conversation history.

Reuse existing serializable workflow/interview state where possible.

Do not invent a parallel state model.

---

# 11. Resume Semantics

A user must be able to continue an interrupted specification session.

At minimum:

```text
start
→ needs-input
→ process terminates
→ answer
→ workflow resumes correctly
```

If `status` is useful, it should expose the current persisted state without advancing the workflow.

Do not implement session discovery/search/history UI unless required for the real flow.

Do not build session management as a product.

---

# 12. OpenSpec Authority

All existing OpenSpec authority rules remain unchanged.

The runtime must not:

- hardcode standard artifact IDs;
- hardcode proposal/design/tasks;
- infer custom schema dependencies itself;
- replace OpenSpec validation;
- duplicate OpenSpec lifecycle rules.

Continue using `OpenSpecGateway`.

OpenSpec remains authoritative for its schema, artifacts, dependencies, instructions, paths, status, and validation.

---

# 13. Independent Review Remains Mandatory

The runtime must preserve the Spec 03 invariant:

```text
READY
=
interview ready
AND
OpenSpec validation passes
AND
latest independent AI review passes
```

No runtime/skill path may bypass independent review.

No `--force-ready`.

No hidden shortcut for tests or CLI.

Test doubles may replace model execution in automated tests, but the production workflow invariant must remain intact.

---

# 14. needs_input Round Trip

True E2E behavior must support the important loop:

```text
workflow
 ↓
review detects missing product information
 ↓
needs_input
 ↓
runtime persists state
 ↓
skill asks user
 ↓
answer submitted
 ↓
same workflow/session resumes
 ↓
affected artifacts revised
 ↓
validation reruns
 ↓
fresh review reruns
```

Do not create a second interview engine for review findings.

Continue using the existing InterviewSession / external-gap mechanism.

---

# 15. Failure Semantics

Expected failures must remain structured.

At minimum distinguish where useful:

- invalid runtime request;
- session not found;
- corrupted/incompatible persisted state;
- OpenSpec unavailable/failure;
- model configuration unavailable;
- model execution failure;
- artifact I/O failure;
- validation failure that cannot be automatically progressed;
- iteration guard exceeded.

Do not create a giant universal error taxonomy.

Errors shown to the skill should be actionable.

Raw stack traces should remain diagnostic/development behavior, not normal user output.

---

# 16. Security

Treat all of the following as untrusted:

- session ID;
- project path;
- change name;
- rough idea;
- human answers;
- persisted state;
- model output.

Requirements:

- no shell interpolation;
- no `eval`;
- no generated shell scripts;
- runtime subprocess calls continue through safe process boundaries;
- prevent session path traversal;
- prevent writes outside the intended project/session/OpenSpec locations;
- validate persisted-state shape before use;
- do not persist secrets;
- do not trust model-generated paths.

Add focused regression tests.

---

# 17. True End-to-End Test

Add a genuine product-level automated E2E that exercises the complete repository architecture without requiring paid APIs.

The test should use:

- a temporary real project;
- a real runtime executable/process boundary;
- real persisted session state;
- real Core workflow;
- real artifact reader/writer;
- real OpenSpec CLI where appropriate;
- deterministic fake/test `ModelPort`;
- no network LLM calls.

It must exercise approximately:

```text
rough idea
 ↓
runtime start
 ↓
needs-input
 ↓
persist
 ↓
runtime answer
 ↓
generation
 ↓
artifacts written
 ↓
OpenSpec validation
 ↓
independent review
 ↓
READY
```

Where practical, include at least one additional loop such as:

```text
review
 ↓
needs_revision
 ↓
artifact revision
 ↓
validation
 ↓
fresh review
 ↓
pass
```

or:

```text
review
 ↓
needs_input
 ↓
human answer
 ↓
resume
 ↓
pass
```

Prefer whichever best exercises the real existing workflow without creating a brittle mega-test.

This test should prove that the system is a working product, not merely a collection of individually tested classes.

---

# 18. CLI-to-Agent E2E Boundary

Preserve the Spec 04 fake-agent E2E.

Add only the minimum integration needed to demonstrate that the generated Specifier instruction points to the now-real runtime mechanism.

Do NOT attempt to automate a live Codex or Claude session in CI.

Do NOT require agent authentication in CI.

The real Core runtime E2E and fake host-agent E2E should together cover the complete architecture without external AI services.

---

# 19. Mutation Testing — Targeted Only

Introduce mutation testing only if a maintained Node/TypeScript mutation tool integrates cleanly with the current repository.

Prefer a mature tool such as Stryker if compatible with the current Node 22 + TypeScript setup.

Do not build custom mutation infrastructure.

Mutation testing must initially target only critical invariant-heavy Core code.

Good candidates include:

- final readiness condition;
- mandatory OpenSpec validation;
- mandatory independent review;
- `needs_input` / `needs_revision` branching;
- iteration guards;
- persisted-session safety checks;
- launcher interruption classification if inexpensive.

Do NOT mutation-test the entire repository.

Exclude where appropriate:

- generated skill copies;
- CLI help text;
- simple DTO/type-only files;
- adapters dominated by external process behavior;
- OpenSpec compatibility plumbing where mutation testing adds little value.

The goal is to answer:

> Would our tests fail if someone accidentally removed a critical product invariant?

Not:

> Can we maximize a mutation score?

---

# 20. Mutation CI Policy

Do not immediately make an arbitrary high mutation percentage a hard global merge gate.

Recommended first implementation:

```text
CI
 ├── quality
 ├── tests + coverage
 ├── openspec-integration
 ├── runtime-e2e
 └── mutation-core
```

`mutation-core` may become a required check if it is deterministic and reasonably fast.

If runtime is excessive, run it only against the explicitly selected critical modules.

Set a modest threshold based on the actual first baseline rather than inventing a number before measuring it.

Document:

- targeted files;
- baseline mutation score;
- surviving meaningful mutants;
- any deliberate exclusions.

Do not weaken normal tests to satisfy mutation tooling.

Do not add dozens of artificial tests merely to kill semantically irrelevant mutants.

---

# 21. Existing CI Hardening

Preserve existing:

- formatting;
- skill consistency;
- lint;
- typecheck;
- dependency audit;
- unit/core tests;
- coverage thresholds;
- pinned real OpenSpec integration smoke.

Add the runtime E2E as an explicit visible CI concern.

Avoid one giant sequential job where an early failure hides unrelated diagnostics.

Do not substantially increase CI complexity beyond what is needed to make failures understandable.

---

# 22. Coverage

Do not lower existing thresholds.

New runtime/application code must receive meaningful behavioral coverage.

Prioritize branch coverage around:

- session lifecycle;
- runtime result transitions;
- corrupted/missing state;
- path validation;
- review/validation gates.

Do not chase 100% coverage.

---

# 23. Persisted-State Compatibility Tests

Add focused tests for:

1. valid session round trip;
2. missing session;
3. malformed/corrupted session;
4. unsupported state version if versioning is introduced;
5. traversal-like session identifier;
6. state survives separate runtime instances/process invocations.

Do not create a migration framework unless more than one real schema version exists.

A clear incompatible-version error is sufficient for v0.1.

---

# 24. Concurrency

Do not build distributed locking.

At minimum, avoid obviously unsafe partial writes.

Prefer write-temp + atomic rename or an equivalent simple local strategy for session persistence.

If concurrent writes to the same session are unsupported, document that clearly.

Do not solve hypothetical multi-process collaboration.

---

# 25. Public API

Keep public exports intentional.

Expose only boundaries genuinely useful to callers/tests, such as:

- runtime interface;
- runtime input/result types;
- default runtime/composition factory if useful.

Do not export every concrete dependency.

Do not turn `src/index.ts` into an internal barrel dump.

---

# 26. Documentation

Update README and focused architecture documentation.

Document:

## Quick start

Conceptually:

```text
install prerequisites
configure model backend
initialize/use OpenSpec project
run ai-spec "rough feature idea"
answer questions
receive READY OpenSpec change
```

## Architecture

Clearly show:

```text
ai-spec
 ↓
host agent
 ↓
Specifier skill
 ↓
Core runtime
 ↓
SpecificationWorkflow
 ↓
OpenSpec
```

## Runtime boundary

Explain:

- why it exists;
- what it owns;
- what it explicitly does not own.

## Session persistence

Document location and lifecycle.

## Testing

Explain:

- unit/core tests;
- fake-agent E2E;
- true runtime E2E;
- real OpenSpec smoke;
- targeted mutation testing.

---

# 27. AGENTS.md / Architecture Rules

Update project agent guidance if necessary.

Include explicit rules:

> The runtime is a composition/transport layer. It must not acquire specification-domain decisions owned by SpecificationWorkflow.

> Do not create a second interview, artifact lifecycle, validation, or review implementation in CLI, skills, or runtime code.

> OpenSpec remains authoritative for OpenSpec-defined structure and lifecycle.

> New infrastructure must be justified by a concrete current product requirement, not hypothetical future reuse.

---

# 28. Non-Goals

Explicitly DO NOT implement:

- model routing;
- provider routing;
- FinOps;
- cost dashboards;
- generic agent orchestration;
- multi-agent debate;
- agent fallback;
- remote execution;
- HTTP API;
- daemon;
- sockets;
- web UI;
- desktop UI;
- VS Code extension;
- Telegram/Slack integration;
- database;
- Redis;
- queues;
- cloud session storage;
- generic persistence framework;
- event sourcing;
- generic DI container;
- plugin framework;
- telemetry platform;
- tracing platform;
- authentication system;
- user accounts;
- team collaboration;
- automatic feature implementation after READY;
- Git commits;
- PR creation;
- deployment;
- generic mutation-testing framework.

Do not begin a hypothetical Spec 06.

---

# 29. Definition of Done

Spec 05 is complete when all of the following are true:

1. a concrete runtime bridge exists between Specifier skill and existing Core;
2. runtime composition constructs real production dependencies explicitly;
3. no specification business logic is duplicated in runtime/skill/CLI;
4. runtime supports the minimum operations required for multi-turn specification;
5. workflow state survives separate process invocations;
6. persisted state is project-local and safe against obvious path traversal/corruption;
7. Specifier skill invokes the concrete runtime mechanism;
8. canonical skill synchronization remains intact;
9. existing `ai-spec` launcher behavior remains intact;
10. OpenSpec remains authoritative;
11. mandatory validation remains impossible to bypass through the production runtime;
12. mandatory independent review remains impossible to bypass through the production runtime;
13. review-driven `needs_input` can return to the same session;
14. structured failures are actionable;
15. no secrets are persisted;
16. true runtime E2E exists;
17. runtime E2E crosses a real process/persistence boundary;
18. runtime E2E uses deterministic fake model behavior and requires no paid API;
19. fake-agent launcher E2E still passes;
20. real pinned OpenSpec integration smoke still passes;
21. targeted mutation testing covers selected critical invariants if cleanly supportable;
22. mutation scope and baseline are documented;
23. existing coverage thresholds are not lowered;
24. formatting passes;
25. lint passes;
26. typecheck passes;
27. skill consistency passes;
28. dependency audit passes;
29. unit/core tests pass;
30. runtime E2E passes;
31. OpenSpec integration passes;
32. final diff contains no unrelated architecture expansion;
33. README documents a real usable v0.1 flow.

---

# 30. Final Product Acceptance Scenario

Before considering the implementation complete, verify that the repository now has a credible path for this user experience:

```text
$ ai-spec "Add Redis caching to REST responses"

Specifier:
What should happen when Redis is unavailable?

User:
Fall back to the current uncached database path.

Specifier:
Should cached responses vary by authenticated user?

User:
Yes, for authenticated endpoints.

...

Specifier:
Specification ready.

Change: redis-rest-cache
Validation: passed
Independent review: passed
Artifacts:
- ...
- ...
```

The implementation does not need to automate a real Codex/Claude session in CI.

But every component behind that experience must now exist and be connected.

---

# 31. Stop Condition

Once this specification is implemented and the true product E2E passes:

**stop adding product architecture.**

Treat the project as v0.1 feature-complete.

Further work should be driven by actual usage feedback, defects, release packaging, or demonstrated operational pain rather than speculative architecture.
