# AGENTS.md

## Product Purpose

This repository is the foundation for an OpenSpec-based interactive feature specification assistant. The assistant should guide a human through specification discovery, preserve OpenSpec as the canonical specification system, generate native OpenSpec changes through OpenSpec workflows, and require a final AI review.

## Architectural Contract

- OpenSpec is authoritative for schemas, artifact graph, dependencies, instructions, templates, resolved paths, and validation.
- Do not reimplement OpenSpec artifact lifecycle or dependency rules locally.
- Internal state may enrich OpenSpec context with interview and review information, but must not narrow or replace OpenSpec-defined information.
- Core owns required product behavior.
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
