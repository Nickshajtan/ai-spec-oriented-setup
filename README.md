# AI Spec Oriented Setup

This repository is being realigned into an OpenSpec-based interactive feature specification assistant.

The product goal is to guide a human through an adaptive specification dialogue, preserve OpenSpec as the canonical source of specification truth, identify material gaps, generate native OpenSpec changes through OpenSpec workflows, and require a final AI review before implementation proceeds.

## Development Status

This is an engineering foundation, not a complete assistant yet. The repository currently provides:

- a safe process runner for CLI integration;
- a Specifier domain middleware bus for optional lifecycle observers, policies, and transformers;
- a thin OpenSpec CLI gateway;
- a minimal provider-neutral `ModelPort`;
- a thin LiteLLM adapter for model completion;
- a first vertical slice of the OpenSpec-aware interview core.

It does not yet implement the full interview engine, question planning, contradiction analysis, autonomous artifact generation loop, web UI, queues, or persistence.

## Architecture Boundary

OpenSpec owns specification lifecycle, schema, artifact graph, dependencies, instructions, templates, resolved paths, and validation. Internal Specifier state may enrich OpenSpec context with interview and review information, but it must not reduce OpenSpec into a narrower replacement model.

Core behavior belongs in the Specifier core. Middleware is optional cross-cutting behavior that observes or influences lifecycle events such as `interview.*`, `openspec.*`, and `review.*`.

LiteLLM is the v1 provider abstraction for model calls. Model routing, provider selection, pricing, dynamic FinOps, retry orchestration, and model scoring are outside this product.

## Main Modules

- `src/openspec/openspec-gateway.ts` wraps the official OpenSpec CLI through `ProcessRunner`.
- `src/interview/interview-engine.ts` manages interview session state and answer integration.
- `src/interview/model-question-planner.ts` uses `ModelPort` to plan one material next question at a time.
- `src/model/litellm-model-adapter.ts` maps `ModelRequest` to LiteLLM `/v1/chat/completions`.
- `src/bus.ts` runs domain middleware deterministically.
- `src/middleware/` contains the small bundled middleware set.
- `src/process-runner.ts` keeps process execution shell-free and reusable.

## Development Commands

```powershell
npm install
npm run typecheck
npm test
npm run check
```

`npm run check` is the local quality gate. Tests mock infrastructure boundaries and do not require real LLM credentials, a running LiteLLM instance, or paid external API calls. The OpenSpec CLI smoke test skips automatically when the CLI is not installed.

## Intended Workflow

1. The assistant gathers missing implementation details through an interview.
2. It enriches, but does not replace, OpenSpec context.
3. It asks OpenSpec to create and validate native changes.
4. It runs a mandatory model-backed review through `ModelPort`.
5. Optional middleware can log lifecycle activity or enforce deterministic local limits.

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
