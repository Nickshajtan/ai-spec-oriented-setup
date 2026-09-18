# Implementation Specification — OpenSpec Artifact Generation, Validation & Independent Review

## Context

Specs 01, 02, and 02.5 are implemented on `main`.

The repository currently provides the main architectural primitives required for the first complete specification workflow:

- `InterviewEngine`
- structured `InterviewSession`
- `QuestionPlanner`
- `OpenSpecGateway`
- generic `OpenSpecArtifact`
- `ModelPort`
- `LiteLLMModelAdapter`
- `ArtifactWriter`
- `NodeArtifactWriter`
- `MiddlewareBus`
- bundled logging/limits middleware
- shared structured model-output parsing
- OpenSpec validation boundary

The next step is to connect these primitives into the first complete Core workflow.

The product remains:

> An OpenSpec-based interactive specification assistant that gathers enough material information from a human, generates native OpenSpec artifacts, validates them through OpenSpec, independently reviews their quality, and asks the human for more information only when necessary.

OpenSpec remains the authority for artifact structure and validation.

Specifier owns elicitation, generation orchestration, quality review, and the decision about whether additional human information is required.

---

# Goal

Implement the first end-to-end specification generation workflow:

```text
rough idea
    ↓
InterviewEngine
    ↓
READY
    ↓
OpenSpec-driven artifact generation
    ↓
ArtifactWriter
    ↓
OpenSpec status/instructions
    ↓
repeat until required artifacts complete
    ↓
OpenSpec validate
    ↓
mandatory independent AI review
    ↓
┌──────────────────────────────────┐
│ PASS                             │
│ NEEDS_REVISION                   │
│ NEEDS_INPUT                      │
└──────────────────────────────────┘
        │         │          │
        │         │          └──→ reopen same interview
        │         │                ↓
        │         │             user answer
        │         │                ↓
        │         └────────────→ regenerate affected artifacts
        │                          ↓
        └──────────────────────→ validate + review again
```

A specification is finalized only when:

```text
Interview has no blocking gaps
AND
OpenSpec validation passes
AND
mandatory independent AI review passes
```

---

# 1. Inspect Before Modifying

Before implementation, inspect the current `main` implementation and tests.

Especially inspect:

- `src/interview/*`
- `src/openspec/*`
- `src/artifact-writer/*`
- `src/model/*`
- `src/middleware/*`
- `src/events.ts`
- `src/index.ts`
- `AGENTS.md`
- OpenSpec integration docs
- current OpenSpec CLI version/contract
- existing OpenSpec fixtures
- existing tests

Do not assume old OpenSpec CLI behavior.

Verify the actual machine-readable OpenSpec CLI contract before implementing generation orchestration.

---

# 2. Core Workflow Ownership

Introduce one Core-level workflow/orchestrator responsible for coordinating the existing components.

A reasonable name is:

```ts
SpecificationWorkflow
```

or:

```ts
SpecificationSession
```

Prefer the name that best fits the current architecture.

Its responsibility is orchestration only.

Conceptually:

```ts
class SpecificationWorkflow {
  constructor(
    interviewEngine: InterviewEngine,
    openSpecGateway: OpenSpecGateway,
    artifactGenerator: ArtifactGenerator,
    artifactWriter: ArtifactWriter,
    reviewer: SpecReviewer,
  ) {}
}
```

Exact constructor/API is flexible.

Do not make this class responsible for:

- direct LLM HTTP calls;
- filesystem implementation;
- OpenSpec CLI invocation;
- model routing;
- provider selection;
- middleware implementation;
- prompt parsing internals.

It coordinates existing ports/components.

---

# 3. Do Not Create a Generic Workflow Engine

This workflow is specifically the Specifier product lifecycle.

Good:

```text
SpecificationWorkflow
```

Bad:

```text
WorkflowEngine
PipelineEngine
GraphExecutor
AgentRuntime
TaskScheduler
StateMachineFramework
```

A simple explicit state transition implementation is preferred.

Do not introduce a workflow DSL.

---

# 4. Workflow State

Introduce structured workflow state representing the lifecycle beyond the interview.

Conceptually:

```ts
interface SpecificationWorkflowState {
  interview: InterviewSession;

  generation: GenerationState;

  validation?: OpenSpecValidation;

  review: ReviewState;

  status:
    | "interview"
    | "generating"
    | "validating"
    | "reviewing"
    | "needs-input"
    | "needs-revision"
    | "ready"
    | "failed";
}
```

Exact representation is flexible.

State must be explicit enough that future CLI/agent facades can inspect it without parsing logs.

Do not use raw chat history as workflow state.

---

# 5. Generation Starts Only After Interview Readiness

Artifact generation must not begin while the interview contains blocking gaps or unresolved contradictions.

The Core invariant is:

```text
InterviewReadiness.ready === true
```

before generation begins.

Do not allow middleware, skill instructions, CLI behavior, or the model to bypass this invariant.

If later review discovers missing human information, the workflow explicitly transitions back to `needs-input`.

---

# 6. OpenSpec Drives Artifact Generation

The workflow must NOT contain:

```ts
generateProposal();
generateSpecs();
generateDesign();
generateTasks();
```

It must not hardcode artifact names or order.

Instead:

```text
OpenSpec status
    ↓
determine artifact currently available/required
    ↓
OpenSpec instructions for that artifact
    ↓
generate
    ↓
write
    ↓
refresh OpenSpec status
```

Repeat according to OpenSpec's actual artifact dependency graph/status.

This must work with custom OpenSpec schemas.

---

# 7. Fix the Remaining Heuristic OpenSpec Normalization Risk

The current OpenSpec normalization recursively infers possible artifacts from arbitrary JSON structures.

That behavior must NOT become authoritative for generation.

Before relying on artifact information for generation:

1. verify the actual current OpenSpec CLI JSON contract;
2. explicitly normalize documented artifact/status/instruction fields;
3. use only verified normalized fields for generation decisions.

Preserve `raw` CLI output for lossless context and forward compatibility.

But:

> `raw` or heuristic discovery may provide context; it must not decide what artifact to generate or where to write it.

If compatibility heuristics remain useful, isolate them clearly as non-authoritative compatibility behavior.

Do not delete raw OpenSpec information.

---

# 8. Artifact Instructions Must Be Artifact-Specific

Generation must use OpenSpec instructions for the specific artifact being generated.

If current `OpenSpecGateway.getInstructions()` only represents change-level instructions, extend the gateway minimally to support the actual OpenSpec artifact-instructions command.

Conceptually:

```ts
getArtifactInstructions({
  projectRoot,
  changeName,
  artifactId,
})
```

Use the actual verified OpenSpec CLI contract.

The result should expose at minimum, where OpenSpec provides them:

- artifact ID;
- resolved output path;
- artifact instructions;
- template;
- dependencies;
- relevant schema/context;
- raw CLI result.

Do not reconstruct these independently.

---

# 9. OpenSpec Resolved Output Path Is Authoritative

`ArtifactWriter` must receive the output path supplied/resolved by OpenSpec.

Do not construct paths such as:

```ts
`openspec/changes/${change}/proposal.md`
```

inside generation code.

Flow:

```text
OpenSpec
    ↓
resolved output path
    ↓
ArtifactGenerator
    ↓ content
ArtifactWriter
    ↓
resolved output path + content
```

`ArtifactWriter` still performs its own path-safety enforcement.

---

# 10. ArtifactGenerator Port

Introduce a focused generation boundary.

Conceptually:

```ts
interface ArtifactGenerator {
  generate(input: GenerateArtifactInput): Promise<GeneratedArtifact>;
}
```

Example conceptual input:

```ts
interface GenerateArtifactInput {
  artifact: OpenSpecArtifact;
  instructions: unknown;
  interview: InterviewSession;
  dependencies: GeneratedArtifactContext[];
}
```

Exact types should follow the verified OpenSpec contract.

Output should be small:

```ts
interface GeneratedArtifact {
  artifactId: string;
  content: string;
}
```

Do not let the generator write files.

Do not let it call OpenSpec CLI.

Do not let it decide which artifact comes next.

---

# 11. ModelArtifactGenerator

Provide a default AI-backed implementation using `ModelPort`.

Conceptually:

```text
ArtifactGenerator
      ↑
ModelArtifactGenerator
      ↓
ModelPort
```

The generator should receive only relevant structured context.

It should not receive the entire historical conversation.

Useful context may include:

- rough idea;
- active non-superseded facts;
- accepted assumptions;
- explicit choices;
- relevant resolved contradictions;
- OpenSpec artifact instructions;
- artifact template;
- required dependency artifacts;
- relevant OpenSpec metadata/schema information.

Avoid sending irrelevant workflow logs or middleware history.

---

# 12. Artifact Generation Prompt Principle

The generation prompt must make OpenSpec authoritative.

The model should be instructed to:

- satisfy the provided OpenSpec artifact instructions;
- use collected user facts as authoritative requirements;
- distinguish accepted assumptions from user facts;
- not invent missing product decisions;
- respect decisions already made during the interview;
- use dependency artifacts as context;
- output artifact content only.

Do not ask the model to decide whether the artifact should exist.

OpenSpec already decides that.

---

# 13. Artifact Dependency Context

When OpenSpec says artifact B depends on artifact A, generation of B should receive A's final current content where materially relevant.

Do not automatically send every generated artifact to every subsequent generation call.

Prefer:

```text
OpenSpec dependency graph
        ↓
relevant dependency content
```

This keeps context bounded and preserves OpenSpec semantics.

---

# 14. Generation Loop

The Core generation loop should conceptually behave as:

```text
refresh status
    ↓
find next OpenSpec-authorized artifact
    ↓
fetch artifact-specific instructions
    ↓
generate artifact
    ↓
write artifact
    ↓
refresh status
    ↓
repeat
```

Termination must be based on OpenSpec status, not a hardcoded number of artifacts.

Protect against accidental infinite/no-progress loops.

The existing `LimitsGuard` may enforce a configurable maximum generation/review iteration count if appropriate.

Core itself should also detect obvious no-progress situations.

Example:

```text
same status
+ same available artifact
+ artifact already generated
+ no state transition
= fail/require human rather than loop forever
```

---

# 15. Artifact Write Conflicts

Initial generation should not silently overwrite an existing artifact.

Respect `ArtifactWriter`'s default conflict behavior.

The workflow must distinguish:

```text
new generation
```

from:

```text
intentional revision/regeneration
```

Only intentional revision should use:

```ts
overwrite: true
```

Do not globally enable overwrite.

---

# 16. OpenSpec Validation Is Mandatory

After OpenSpec reports required artifacts complete, run:

```ts
OpenSpecGateway.validate(...)
```

Validation is a Core invariant.

The workflow must not transition directly:

```text
generated → review
```

without validation.

Required sequence:

```text
generated
→ validate
→ review
```

---

# 17. Validation Failure Handling

OpenSpec validation failure must not be treated as final failure immediately if it is plausibly repairable.

Normalize validation findings sufficiently for the workflow/reviewer to reason about them.

Conceptually:

```ts
interface ValidationResult {
  valid: boolean;
  raw: unknown;
}
```

Preserve raw validation output.

If validation fails:

```text
validation failure
    ↓
revision analysis
    ↓
regenerate/revise affected artifact
    ↓
validate again
```

Do not ask the human to repair structural OpenSpec errors that can be resolved without a product decision.

If validation failure reveals genuinely missing product information, it may eventually become `needs-input`.

---

# 18. Mandatory Independent AI Review

A successful OpenSpec validation is necessary but not sufficient.

Every generated specification must receive at least one AI quality review.

This is a Core invariant.

Review cannot be disabled by:

- CLI;
- skill;
- middleware;
- configuration;
- caller facade.

A future explicit development/testing seam may mock the reviewer, but production workflow semantics always include review.

---

# 19. Review Must Use a Fresh Model Context

The reviewer must be logically independent from artifact generation.

Do not implement:

```text
generator conversation
→ "now check your own work"
```

Instead perform a separate `ModelPort.complete()` call with a newly constructed request.

It may use the same physical model configuration.

Independence means:

```text
fresh request/context
```

not necessarily:

```text
different provider/model
```

---

# 20. SpecReviewer Port

Introduce:

```ts
interface SpecReviewer {
  review(input: SpecReviewInput): Promise<SpecReview>;
}
```

Provide a default:

```text
SpecReviewer
     ↑
ModelSpecReviewer
     ↓
ModelPort
```

The reviewer does not mutate files.

It returns findings only.

---

# 21. Reviewer Input

The review should receive the final current specification state required to judge implementation readiness.

Relevant input includes:

- OpenSpec schema/instructions;
- current artifact graph/status;
- generated artifact contents;
- interview facts;
- accepted assumptions;
- explicit choices;
- unresolved contradictions if any;
- OpenSpec validation result;
- relevant dependency relationships.

Do not provide the generation model's hidden reasoning or previous model conversation.

The reviewer judges the artifacts themselves against requirements and collected human intent.

---

# 22. Review Output

Use structured output.

Required top-level verdict:

```ts
type ReviewVerdict =
  | "pass"
  | "needs_revision"
  | "needs_input";
```

Conceptual result:

```ts
interface SpecReview {
  verdict: ReviewVerdict;

  findings: ReviewFinding[];

  summary?: string;
}
```

Conceptual finding:

```ts
interface ReviewFinding {
  id: string;

  severity:
    | "error"
    | "warning";

  artifactId?: string;

  issue: string;

  reason: string;

  category?:
    | "missing-requirement"
    | "contradiction"
    | "ambiguity"
    | "openspec-compliance"
    | "implementation-readiness"
    | "consistency";

  suggestedQuestion?: string;
}
```

Exact type names may differ.

Do not introduce numeric confidence scores.

---

# 23. Meaning of Review Verdicts

## `pass`

Use when:

- OpenSpec validation passes;
- no material specification gap remains;
- no unresolved contradiction blocks implementation;
- artifacts are sufficiently explicit for an implementation agent.

Warnings may exist only if they are non-blocking.

## `needs_revision`

Use when:

> The specification is insufficient, but existing information is enough to fix it without asking the human another product/requirement question.

Examples:

- artifact omitted an already-known requirement;
- terminology is inconsistent;
- one artifact contradicts another even though interview state resolves the correct answer;
- OpenSpec structure/content can be repaired from existing information;
- implementation detail needs clarification that follows directly from known requirements.

## `needs_input`

Use when:

> A material decision cannot be safely derived from collected information.

Examples:

- deployment target materially affects implementation and was never decided;
- compatibility requirements are unknown;
- behavior for a material edge case requires product intent;
- two requirements conflict and existing facts do not establish which wins;
- review discovers a genuinely new specification gap.

Do not use `needs_input` merely because the reviewer would prefer more detail.

Ask the human only for material information.

---

# 24. Reviewer Must Not Invent Requirements

The reviewer must distinguish:

```text
missing implementation detail that can be derived
```

from:

```text
missing human/product decision
```

This distinction drives:

```text
needs_revision
```

versus:

```text
needs_input
```

The reviewer should not manufacture speculative requirements and then fail the specification for not satisfying them.

---

# 25. `needs_revision` Workflow

When review returns:

```text
needs_revision
```

the workflow should:

1. preserve review findings;
2. determine affected artifacts;
3. regenerate/revise only affected artifacts where possible;
4. explicitly overwrite those artifacts;
5. refresh OpenSpec status;
6. run OpenSpec validation again;
7. perform another fresh-context review.

Do not regenerate the entire change by default.

Prefer minimal affected-artifact revision.

If dependency relationships imply downstream artifacts are stale, regenerate those according to OpenSpec dependencies/status.

Do not implement an independent dependency graph.

Use OpenSpec's graph.

---

# 26. Artifact Revision

Artifact revision should reuse the ArtifactGenerator boundary.

Do not create an entirely separate AI subsystem.

Generation input may support:

```ts
mode: "create" | "revise"
```

or an equivalent representation.

Revision context may include:

- current artifact content;
- relevant review findings;
- existing interview facts;
- OpenSpec instructions;
- dependency artifacts.

The model should return the complete replacement artifact content.

Avoid patch/diff application in this step.

Full artifact replacement is simpler and safer for Markdown-sized specification artifacts.

---

# 27. `needs_input` Must Reopen the Existing Interview

This is a critical product requirement.

Do NOT create:

```text
ReviewInterviewEngine
ClarificationEngine
SecondQuestionnaire
```

Review findings become new structured gaps in the existing interview state.

Conceptually:

```text
review finding
    ↓
InterviewSession
    ↓
new unresolved material gap
    ↓
QuestionPlanner
    ↓
user question
```

The same interview lifecycle continues.

---

# 28. Extend Interview State for External Gaps

Add the smallest mechanism necessary for the existing Interview Engine to accept newly discovered material gaps.

Conceptually:

```ts
interface InterviewGap {
  id: string;
  source: "planner" | "review" | "validation";
  reason: string;
  artifactId?: string;
  suggestedQuestion?: string;
}
```

Do not force this exact type if the current state can represent the concept cleanly another way.

Important invariant:

> Review/validation findings requiring human input become structured interview state, not an ad-hoc prompt outside InterviewEngine.

---

# 29. Review-Discovered Gap Provenance

Preserve provenance.

The system must be able to distinguish:

```text
user supplied fact
model proposed assumption
OpenSpec requirement
review-discovered gap
validation-discovered gap
```

A review finding must never silently become a user fact.

After the user answers a review-discovered question, the answer becomes a normal user fact with provenance.

---

# 30. Resume After Human Input

After the user resolves review-discovered gaps:

```text
InterviewEngine
    ↓
ready again
    ↓
determine affected artifacts
    ↓
revise/regenerate
    ↓
OpenSpec validate
    ↓
fresh review
```

Do not restart the entire change.

Do not discard previous valid interview facts.

Do not discard review history.

---

# 31. Review History

Add structured review history to workflow state.

Conceptually:

```ts
interface ReviewState {
  attempts: SpecReview[];
  latest?: SpecReview;
}
```

Preserve each review result.

This is domain state, not an audit subsystem.

Do not create a generic audit log.

---

# 32. Final Readiness

The workflow may transition to:

```text
ready
```

only when all three conditions are true:

```text
1. interview ready
2. OpenSpec validation valid
3. latest mandatory review verdict == pass
```

Encode this invariant centrally.

Do not duplicate it across CLI/skill/middleware.

---

# 33. Review Iteration Guard

Prevent runaway loops.

Use the existing limits architecture where appropriate.

Add a configurable review iteration limit if not already available.

Example:

```ts
maxReviewIterations
```

When reached:

```text
require-human
```

or a clear non-ready workflow result.

Do not silently mark the specification ready.

Do not retry indefinitely.

---

# 34. Generation Iteration Guard

Likewise protect the OpenSpec generation loop from no-progress/infinite states.

Possible conditions:

- maximum artifact-generation transitions;
- repeated identical OpenSpec status;
- repeated same artifact without state progress.

Keep this deterministic and simple.

Do not create a scheduler.

---

# 35. Middleware Events

Add only semantic events required by the real workflow.

Candidate events:

```text
generation.started
artifact.generation.started
artifact.generated

openspec.validation.completed

review.started
review.finding.detected
review.completed

interview.reopened

specification.ready
specification.failed
```

Reuse existing events where semantically equivalent.

Clean up speculative event names if the implemented lifecycle establishes better names.

Do not emit low-level events for:

- prompt construction;
- JSON parsing;
- array iteration;
- dependency lookup;
- file reads.

Model invocation observability remains infrastructure-level rather than a domain lifecycle.

---

# 36. Existing `review.*` Events

The current event registry already contains preliminary review event names.

Review them during implementation.

Keep them if they match the actual lifecycle.

Rename/remove them if they were speculative and the resulting implementation has clearer semantic boundaries.

Do not preserve event names merely because they already exist if no code depends on them.

---

# 37. Reading Generated Artifacts

The reviewer and revision flow need current artifact content.

Introduce the smallest mechanism necessary.

Options include:

- a small `ArtifactReader` port;
- a read method adjacent to artifact infrastructure;
- using explicitly tracked generated content where sufficient.

Prefer a thin `ArtifactReader` if persisted files are the authoritative current artifact state.

Conceptually:

```ts
interface ArtifactReader {
  read(input: ReadArtifactInput): Promise<ReadArtifactResult>;
}
```

It must have the same path-safety principle as `ArtifactWriter`.

Do not turn `ArtifactWriter` into a filesystem service with many unrelated methods merely for convenience.

---

# 38. Persisted Artifacts Are the Review Target

Review the actual current artifact contents that exist after generation/revision.

Do not review only the model's pre-write response if persisted content can differ or future middleware can affect persistence.

The persisted OpenSpec change is the specification being judged.

---

# 39. Failure Semantics

Differentiate at least:

```text
needs human input
repairable revision
OpenSpec validation failure
model invocation failure
OpenSpec CLI failure
artifact I/O failure
workflow invariant/no-progress failure
```

Do not collapse everything into:

```text
Error("generation failed")
```

Reuse existing typed result/error patterns where practical.

Do not build a giant error taxonomy.

---

# 40. No Automatic Implementation

The workflow ends when the OpenSpec change is ready.

It must NOT:

- execute `tasks.md`;
- invoke coding agents to implement the feature;
- modify application source code;
- create commits;
- create PRs;
- archive the OpenSpec change automatically.

Those belong outside this product boundary.

Final output is a reviewed, validated, implementation-ready OpenSpec change.

---

# 41. Public Programmatic API

Expose a clean programmatic API sufficient for the future skill/CLI facade.

The API should support the lifecycle conceptually like:

```ts
const workflow = new SpecificationWorkflow(...);

let result = await workflow.start({
  projectRoot,
  changeName,
  roughIdea,
});

while (result.status === "needs-input") {
  result = await workflow.answer({
    state: result.state,
    answer: userAnswer,
  });
}

if (result.status === "ready") {
  // OpenSpec change is validated and independently reviewed.
}
```

Exact API may differ.

Important properties:

- caller does not orchestrate artifact order;
- caller does not invoke validation manually;
- caller does not invoke review manually;
- caller only provides human answers when Core requests them.

This preserves one execution path for future CLI and agent skill facades.

---

# 42. Testability

All external boundaries must be mockable:

```text
OpenSpecGateway
ModelPort / ArtifactGenerator / SpecReviewer
ArtifactWriter
ArtifactReader
```

Tests must not require:

- paid model APIs;
- LiteLLM server;
- Anthropic/OpenAI credentials;
- network access.

OpenSpec CLI integration tests may use controlled fixtures/mocked `ProcessRunner` unless a lightweight local integration test is already established.

---

# 43. Tests — Happy Path

Add an end-to-end Core test covering:

```text
rough idea
→ interview question(s)
→ answers
→ interview ready
→ artifact A generated
→ artifact B generated according to OpenSpec status
→ persisted
→ validation passes
→ independent review passes
→ workflow ready
```

Use custom/non-standard artifact names in at least one test.

For example:

```text
intent
architecture-note
implementation-plan
```

This verifies there is no hidden dependency on:

```text
proposal/design/tasks/specs
```

---

# 44. Tests — Review Revision

Test:

```text
generation
→ validation pass
→ review needs_revision
→ affected artifact revised
→ overwrite explicitly allowed
→ validation reruns
→ second fresh review passes
→ ready
```

Assert that unaffected artifacts are not unnecessarily regenerated.

---

# 45. Tests — Review Needs Human Input

Test:

```text
generation
→ validation pass
→ review needs_input
→ finding inserted into existing InterviewSession
→ workflow status needs-input
→ user answers
→ interview becomes ready
→ affected artifact revised
→ validation
→ fresh review
→ pass
```

Assert provenance of the new user fact.

---

# 46. Tests — Validation Failure

Test:

```text
generation
→ OpenSpec validation fails
→ repairable revision
→ validation reruns
→ review still mandatory
```

Also test a validation-derived missing product decision that becomes human input if the architecture supports this distinction cleanly.

---

# 47. Tests — Guards

Test:

- repeated OpenSpec status with no progress;
- review iteration limit;
- generation iteration limit;
- ArtifactWriter conflict on initial generation;
- intentional overwrite during revision;
- middleware deny/require-human;
- model malformed structured review output;
- OpenSpec CLI failure;
- artifact read/write failure.

No infinite test loops.

---

# 48. Tests — Independent Review

Explicitly verify that review is a separate model invocation from generation.

The reviewer must receive a newly constructed request rather than continuation of generation messages.

The test does not need different model names.

It should prove context separation.

---

# 49. Documentation

Update architecture docs with the complete Core lifecycle:

```text
Interview
→ Generate
→ Persist
→ Validate
→ Review
→ Revise/Reopen
→ Ready
```

Document the three Core readiness invariants.

Document the difference between:

```text
needs_revision
```

and:

```text
needs_input
```

Document that OpenSpec defines artifact structure/order while Specifier owns elicitation and quality review.

---

# 50. AGENTS.md

Update the engineering contract if necessary with these permanent rules:

1. OpenSpec is authoritative for artifact structure, dependencies, paths, instructions and validation.
2. Specifier must not hardcode standard OpenSpec artifact names.
3. Human questions are asked only for material decisions that cannot safely be derived.
4. OpenSpec validation is mandatory.
5. Independent fresh-context AI review is mandatory.
6. Review findings requiring human decisions return to the existing Interview Core.
7. `needs_revision` must not unnecessarily involve the human.
8. Final readiness requires interview readiness + OpenSpec validation + review pass.
9. Core remains caller-agnostic.
10. Skills and CLI facades contain no specification business logic.

---

# 51. Non-goals

Do NOT implement in this step:

- polished CLI;
- Codex skill;
- Claude skill;
- agent launcher;
- Web UI;
- HTTP API;
- persistent database;
- multi-user sessions;
- background jobs;
- queues;
- generic workflow engine;
- model routing;
- provider routing;
- FinOps;
- automatic feature implementation;
- Git commits;
- PR creation;
- OpenSpec archive workflow;
- semantic embeddings;
- vector database;
- generic agent runtime.

---

# Expected Architecture

```text
                       ┌────────────────────┐
                       │   Caller / Facade  │
                       │ future CLI / skill │
                       └─────────┬──────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ SpecificationWorkflow  │
                    └────────────┬───────────┘
                                 │
           ┌─────────────────────┼──────────────────────┐
           │                     │                      │
           ▼                     ▼                      ▼
  ┌─────────────────┐   ┌─────────────────┐   ┌────────────────┐
  │ InterviewEngine │   │ OpenSpecGateway │   │  SpecReviewer  │
  └────────┬────────┘   └────────┬────────┘   └───────┬────────┘
           │                     │                    │
           │                     ▼                    ▼
           │               OpenSpec CLI           ModelPort
           │
           ▼
     QuestionPlanner
           │
           ▼
       ModelPort


                 generation path

              OpenSpec instructions
                       │
                       ▼
              ArtifactGenerator
                       │
                       ▼
                   ModelPort
                       │
                       ▼
                ArtifactWriter
                       │
                       ▼
                    files
                       │
                       ▼
                ArtifactReader
                       │
                       ▼
                   Reviewer
```

Middleware surrounds semantic lifecycle boundaries but does not own the workflow.

---

# Definition of Done

Step 03 is complete when:

1. A Core-level specification workflow exists.
2. Generation begins only from a ready InterviewSession.
3. Artifact generation order is driven by verified OpenSpec status/instructions.
4. Standard OpenSpec artifact names are not hardcoded.
5. Heuristic OpenSpec normalization is not authoritative for generation.
6. Artifact-specific OpenSpec instructions are used.
7. OpenSpec-resolved artifact paths are used.
8. `ArtifactGenerator` is separate from persistence.
9. `ArtifactWriter` performs persistence.
10. Current persisted artifacts can be read for review/revision.
11. OpenSpec validation is mandatory.
12. Independent fresh-context AI review is mandatory.
13. Review returns `pass`, `needs_revision`, or `needs_input`.
14. `needs_revision` revises affected artifacts without unnecessary human interaction.
15. `needs_input` creates structured gaps in the existing InterviewSession.
16. Human answers retain provenance.
17. The workflow resumes after new human input rather than restarting.
18. Validation runs again after material revisions.
19. Review runs again after material revisions.
20. Review history is retained.
21. Runaway generation/review loops are guarded.
22. Final `ready` requires interview readiness + valid OpenSpec + review pass.
23. Custom OpenSpec artifact schemas are covered by tests.
24. No paid/network model access is required by tests.
25. Existing Specs 01/02/02.5 behavior remains green.
26. `npm run check` passes.
27. CI is green.

## Final implementation principle

The workflow should repeatedly answer three different questions:

```text
Interview:
"Do we know enough from the human?"

OpenSpec:
"Are the required artifacts structurally complete and valid?"

Reviewer:
"Are those artifacts actually good enough for an implementation agent?"
```

These responsibilities must remain separate.

When the answer is no:

```text
missing human decision
    → ask the human

known information represented badly
    → revise the artifacts

invalid OpenSpec structure
    → repair and validate again
```

Do not solve all three problems with another generic AI call.
