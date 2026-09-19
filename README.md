# AI Spec Oriented Setup

This repository is being realigned into an OpenSpec-based interactive feature specification assistant.

The product goal is to guide a human through an adaptive specification dialogue, preserve OpenSpec as the canonical source of specification truth, identify material gaps, generate native OpenSpec changes through OpenSpec workflows, and require a final AI review before implementation proceeds.

## Development Status

This is an engineering foundation, not a complete assistant yet. The repository currently provides:

- a safe process runner for CLI integration;
- a Specifier domain middleware bus for optional lifecycle observers, policies, and transformers;
- a thin OpenSpec CLI gateway;
- a generic safe `ArtifactWriter` filesystem boundary;
- a matching safe `ArtifactReader` for persisted artifacts;
- a minimal provider-neutral `ModelPort`;
- a thin LiteLLM adapter for model completion;
- a first vertical slice of the OpenSpec-aware interview core;
- a Core `SpecificationWorkflow` that coordinates interview readiness, artifact generation, persistence, OpenSpec validation, independent review, revision, and reopen-for-input behavior.

It does not yet implement a polished CLI, Codex skill, web UI, queues, database persistence, or automatic feature implementation.

## Architecture Boundary

OpenSpec owns specification lifecycle, schema, artifact graph, dependencies, instructions, templates, resolved paths, and validation. Internal Specifier state may enrich OpenSpec context with interview and review information, but it must not reduce OpenSpec into a narrower replacement model.

Core behavior belongs in the Specifier core. Middleware is optional cross-cutting behavior that observes or influences lifecycle events such as `interview.*`, `openspec.*`, and `review.*`.

LiteLLM is the v1 provider abstraction for model calls. Model routing, provider selection, pricing, dynamic FinOps, retry orchestration, and model scoring are outside this product.

Artifact persistence is deliberately generic. OpenSpec/Core decide what artifact path should be written; `ArtifactWriter` only performs safe UTF-8 persistence to a project-relative path. Review and revision read the current persisted artifact content through `ArtifactReader`.

## Main Modules

- `src/openspec/openspec-gateway.ts` wraps the official OpenSpec CLI through `ProcessRunner`.
- `src/artifact-writer/node-artifact-writer.ts` safely writes generated artifact content to the filesystem.
- `src/artifact-writer/node-artifact-reader.ts` safely reads persisted artifact content.
- `src/interview/interview-engine.ts` manages interview session state and answer integration.
- `src/interview/model-question-planner.ts` uses `ModelPort` to plan one material next question at a time.
- `src/specification/specification-workflow.ts` coordinates the end-to-end Core lifecycle.
- `src/specification/model-artifact-generator.ts` generates one OpenSpec-authorized artifact through `ModelPort`.
- `src/specification/model-spec-reviewer.ts` performs a fresh-context AI review through `ModelPort`.
- `src/model/litellm-model-adapter.ts` maps `ModelRequest` to LiteLLM `/v1/chat/completions`.
- `src/bus.ts` runs domain middleware deterministically.
- `src/middleware/` contains the small bundled middleware set.
- `src/process-runner.ts` keeps process execution shell-free and reusable.

## Development Commands

```powershell
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run openspec:smoke
npm run check
```

`npm run check` is the local quality gate: format check, lint, typecheck, unit/core tests, and coverage thresholds. Tests mock model infrastructure and do not require real LLM credentials, a running LiteLLM instance, or paid external API calls.

Coverage thresholds are enforced by `npm run test:coverage`:

- lines: 80%
- functions: 80%
- branches: 73%

The real OpenSpec smoke test uses pinned OpenSpec CLI `1.12.0` and does not silently skip in CI.

## CI And Branch Protection

GitHub Actions exposes three intended required checks:

- `quality`
- `tests`
- `openspec-integration`

Recommended branch protection for `main`:

- require pull requests before merge;
- require the three status checks above;
- require branches to be up to date before merge;
- require at least one human approval;
- dismiss stale approvals after new commits.

## Core Workflow

1. The assistant gathers missing implementation details through an interview.
2. Generation starts only after the interview is ready.
3. OpenSpec status determines the next artifact; artifact-specific OpenSpec instructions determine what to generate.
4. `ArtifactGenerator` returns content only; `ArtifactWriter` persists the OpenSpec-resolved path.
5. OpenSpec validation runs after required artifacts are complete.
6. A fresh-context independent review runs after validation passes.
7. `needs_revision` revises affected artifacts without unnecessarily involving the human.
8. `needs_input` creates a structured gap in the same `InterviewSession`; after the user answers, the workflow resumes rather than restarting.
9. Final readiness requires interview readiness, valid OpenSpec validation, and a passing review.

OpenSpec defines artifact structure, order, dependencies, paths, instructions, and validation. Specifier owns elicitation, generation orchestration, independent quality review, and deciding whether more human input is materially required.

## Programmatic Interview API

```ts
import { InterviewEngine, ModelQuestionPlanner } from "./src/index.ts";

const planner = new ModelQuestionPlanner(modelPort, { model: "specifier-interviewer" });
const engine = new InterviewEngine(openSpecGateway, planner);

const first = await engine.start({
  projectRoot: "/path/to/project",
  changeName: "add-redis-cache",
  roughIdea: "Add Redis caching to WordPress REST responses.",
});

const next = await engine.answer({
  session: first.session,
  answer: "Existing WordPress multisite.",
});
```

The session stores explicit user facts, choices, assumptions, unresolved questions, contradictions, provenance, OpenSpec context, and explainable readiness.

## Programmatic Workflow API

```ts
import { SpecificationWorkflow } from "./src/index.ts";

const workflow = new SpecificationWorkflow({
  interviewEngine,
  openSpecGateway,
  artifactGenerator,
  artifactWriter,
  artifactReader,
  reviewer,
});

let result = await workflow.start({
  projectRoot: "/path/to/project",
  changeName: "add-redis-cache",
  roughIdea: "Add Redis caching to WordPress REST responses.",
});

while (result.status === "needs-input") {
  result = await workflow.answer({
    state: result.state,
    answer: "Existing WordPress multisite.",
  });
}
```

The caller supplies human answers only. It does not choose artifact order, run validation, or invoke review manually.
