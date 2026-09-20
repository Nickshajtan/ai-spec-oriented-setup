# AGENTS.md

## Product Purpose

This repository is the foundation for an OpenSpec-based interactive feature specification assistant. The assistant should guide a human through specification discovery, preserve OpenSpec as the canonical specification system, generate native OpenSpec changes through OpenSpec workflows, and require a final AI review.

## Architectural Contract

- OpenSpec is authoritative for schemas, artifact graph, dependencies, instructions, templates, resolved paths, and validation.
- Do not reimplement OpenSpec artifact lifecycle or dependency rules locally.
- Do not hardcode standard OpenSpec artifact names such as proposal, design, tasks, or specs in Core generation logic.
- Internal state may enrich OpenSpec context with interview and review information, but must not narrow or replace OpenSpec-defined information.
- Core owns required product behavior.
- ArtifactWriter is generic safe persistence only; do not put OpenSpec artifact semantics in it.
- ArtifactReader is generic safe persisted-content access only; review should judge current persisted artifacts.
- OpenSpec validation is mandatory before final review.
- Independent fresh-context AI review is mandatory before readiness.
- Final readiness requires interview readiness, valid OpenSpec validation, and a passing review.
- Review findings requiring human decisions must return to the existing Interview Core as structured gaps.
- `needs_revision` should repair affected artifacts without unnecessarily involving the human.
- The runtime is a composition and transport layer. It must not acquire specification-domain decisions owned by `SpecificationWorkflow`.
- Do not create a second interview, artifact lifecycle, validation, or review implementation in CLI, skills, or runtime code.
- Skills and CLI facades must not contain specification business logic; keep Core caller-agnostic.
- New infrastructure must be justified by a concrete current product requirement, not hypothetical future reuse.
- Middleware owns optional cross-cutting behavior over Specifier lifecycle events.
- Domain events should use Specifier semantics such as `interview.*`, `openspec.*`, and `review.*`.
- Model routing is outside this product.
- LiteLLM is the v1 provider abstraction behind `ModelPort`.
- Heavy FinOps, provider selection, model scoring, and dynamic pricing belong outside this product.
- Avoid speculative abstractions and generic workflow engines.

## Engineering Guidance

- Prefer existing patterns and small cohesive modules.
- Keep process execution shell-free: pass executable and arguments separately.
- Mock infrastructure boundaries in tests.
- CI must not require real LLM credentials, a running LiteLLM instance, paid API calls, or the OpenSpec CLI.
- Preserve TOML configuration if it appears in the repo.

## Agent-Specific Notes

Codex should focus on implementation, validation, and delivery. Claude/Gemini handoffs may be used for architecture or visual critique, but do not add agent-specific runtime systems unless explicitly requested.
