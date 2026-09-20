# Agent Skill & CLI Launcher

The product exposes three local entry points and keeps one specification execution path:

```text
Codex / Claude Code -> Specifier skill -> ai-spec-core -> SpecificationWorkflow -> existing Core
ai-spec -> selected agent -> skill -----+
```

The CLI does not implement specification logic. The skill does not implement specification logic. `SpecificationWorkflow` remains the single Core authority for interview state, readiness, artifact generation/order, persistence, OpenSpec validation, independent review, revision, and reopen-for-input behavior.

## Installation

Install this package using the repository's normal Node workflow so npm exposes its `ai-spec` bin. Requirements:

- Node.js 22 or newer;
- OpenSpec CLI; the repository's verified integration and CI smoke pin `@fission-ai/openspec@1.12.0`;
- either Codex CLI or Claude Code CLI, installed and authenticated. Both are not required.

Run `openspec init` in the target project as required by OpenSpec. Specifier is an orchestration layer above OpenSpec and does not overwrite or fork OpenSpec's `opsx:*` skills. Refresh OpenSpec's own generated integration with `openspec update` when upgrading OpenSpec.

## Direct Agent Usage

The canonical skill is `skills/specifier/SKILL.md`. `npm run skills:sync` writes exact project-local representations:

- Codex: `.agents/skills/specifier/SKILL.md`, invoked as `$specifier`;
- Claude Code: `.claude/skills/specifier/SKILL.md`, invoked as `/specifier`.

Commit all three files. `npm run skills:check` fails if either representation diverges from the canonical source.

The skill tells the host to call the repository-local `ai-spec-core` executable and relay Core-generated questions and structured results. If the runtime cannot be configured, the skill reports that missing integration; it does not invent another interview or artifact runtime.

## Core Runtime

`ai-spec-core` is the stable process boundary used by agent skills:

```text
ai-spec-core start
ai-spec-core answer
ai-spec-core status
```

Each command reads one JSON object from stdin, writes one structured JSON result to stdout, and sends diagnostics to stderr. It never prompts interactively. `start` creates or loads the OpenSpec change through Core dependencies and persists workflow state under the target project. `answer` loads the same session and resumes `SpecificationWorkflow.answer`. `status` reads persisted state without advancing the workflow.

Production model configuration is intentionally small:

- `AI_SPEC_LITELLM_BASE_URL` is required;
- `AI_SPEC_MODEL` selects the model name and defaults to `specifier`;
- `AI_SPEC_LITELLM_API_KEY_ENV` optionally names the environment variable containing the LiteLLM API key;
- `OPENSPEC_COMMAND` optionally overrides the OpenSpec executable name.

Automated runtime E2E tests may set `AI_SPEC_RUNTIME_TEST_MODEL=1` to use a deterministic in-process `ModelPort`. That mode still goes through generation, OpenSpec validation, review, revision, and persisted session state; it does not bypass workflow invariants.

Runtime sessions are stored at:

```text
<project>/.ai-spec-core/sessions/<session-id>.json
```

The format is versioned, project-local, JSON-only, and written via temp-file plus rename. Session IDs are validated before file access. Concurrent writes to the same session are not a supported collaboration mode for v0.1.

## CLI Usage

```text
ai-spec "Add Redis caching to REST responses"
ai-spec --agent codex "Add Redis caching to REST responses"
ai-spec --agent claude "Add Redis caching to REST responses"
ai-spec --change redis-cache "Add Redis caching to REST responses"
ai-spec --project /path/to/project
```

`--project` defaults to the current working directory. The CLI resolves it to a real directory without changing global process state. `--change` is preserved verbatim for Core/OpenSpec; the launcher does not derive a change name.

Without `--agent`, the launcher runs capability checks using `codex --version` and `claude --version`. If one is available, it is selected. If both are available, Codex is the documented deterministic preference. If an explicitly selected agent is unavailable, launch fails and never substitutes the other agent.

For an interactive workflow, the adapters use the official initial-prompt contracts:

- `codex PROMPT`;
- `claude "query"`.

The prompt is one argument and the project is the child process working directory. `NodeProcessRunner` uses `spawn` with `shell: false`; idea, path, and change values are never interpolated into a shell command.

## Verified Conventions

Verified on 2026-09-19:

- [OpenAI Codex skills documentation](https://developers.openai.com/codex/skills): portable `SKILL.md` with required `name` and `description`; repository-local Codex discovery under `.agents/skills`; explicit invocation with `$skill-name`.
- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference): stable interactive `codex` accepts an optional positional `PROMPT`; the documentation displayed Codex `0.143.0` when inspected.
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills): repository-local skills use `.claude/skills/<name>/SKILL.md` and direct `/name` invocation; the portable Agent Skills frontmatter subset is accepted.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): `claude "query"` starts an interactive session with an initial prompt; current documentation included behavior through the `2.1.268` line.
- [OpenSpec 1.12.0](https://github.com/Fission-AI/OpenSpec): verified installed package maps Codex to `.agents/skills`, preserves tool-specific `opsx:*` command/skill forms, and uses `openspec update` to refresh them. Repository CI runs a real pinned `1.12.0` smoke test.

These are capability contracts, not upper version locks. A newer host is accepted when its executable responds successfully; exact-version rejection is intentionally avoided.

## Errors

Expected operational failures are concise: unavailable host CLI, invalid project path, non-zero agent exit, and interruption. Agent diagnostics remain available without raw stack traces. OpenSpec availability, project initialization, workflow human-intervention, validation, and review failures remain structured Core/OpenSpec concerns presented by the Specifier skill.
