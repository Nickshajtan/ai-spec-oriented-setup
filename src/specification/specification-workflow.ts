import { MiddlewareBus } from "../bus.ts";
import type { MiddlewareExecution } from "../middleware/types.ts";
import type { OpenSpecArtifact, OpenSpecValidation, OpenSpecValidationFinding } from "../openspec/types.ts";
import type {
  AnswerSpecificationWorkflowInput,
  ArtifactGenerator,
  GeneratedArtifactContext,
  GenerationMode,
  ReviewFinding,
  SpecReview,
  SpecificationWorkflowDependencies,
  SpecificationWorkflowOptions,
  SpecificationWorkflowResult,
  SpecificationWorkflowState,
  StartSpecificationWorkflowInput,
} from "./types.ts";

const DEFAULT_MAX_GENERATION_ITERATIONS = 20;
const DEFAULT_MAX_VALIDATION_REPAIR_ITERATIONS = 3;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

export class SpecificationWorkflow {
  private readonly dependencies: SpecificationWorkflowDependencies;
  private readonly bus: MiddlewareBus;
  private readonly maxGenerationIterations: number;
  private readonly maxValidationRepairIterations: number;
  private readonly maxReviewIterations: number;
  private readonly clock: () => Date;

  constructor(dependencies: SpecificationWorkflowDependencies, options: SpecificationWorkflowOptions & { bus?: MiddlewareBus; clock?: () => Date } = {}) {
    this.dependencies = dependencies;
    this.bus = options.bus ?? new MiddlewareBus();
    this.maxGenerationIterations = options.maxGenerationIterations ?? DEFAULT_MAX_GENERATION_ITERATIONS;
    this.maxValidationRepairIterations = options.maxValidationRepairIterations ?? DEFAULT_MAX_VALIDATION_REPAIR_ITERATIONS;
    this.maxReviewIterations = options.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;
    this.clock = options.clock ?? (() => new Date());
  }

  async start(input: StartSpecificationWorkflowInput): Promise<SpecificationWorkflowResult> {
    const interview = await this.dependencies.interviewEngine.start(input);
    const state: SpecificationWorkflowState = {
      projectRoot: input.projectRoot,
      changeName: input.changeName,
      interview: interview.session,
      generation: { artifacts: [], attempts: 0 },
      validation: { repairAttempts: 0 },
      review: { attempts: [] },
      status: interview.ready ? "generating" : "needs-input",
    };
    if (!interview.ready) return result(state, interview.middleware, false);
    return this.runUntilBlockedOrReady(state, interview.middleware);
  }

  async answer(input: AnswerSpecificationWorkflowInput): Promise<SpecificationWorkflowResult> {
    const answered = await this.dependencies.interviewEngine.answer({
      session: input.state.interview,
      answer: input.answer,
      acceptedAssumptionIds: input.acceptedAssumptionIds,
      rejectedAssumptionIds: input.rejectedAssumptionIds,
    });
    const state = cloneState(input.state);
    state.interview = answered.session;
    state.status = answered.ready ? "generating" : "needs-input";
    if (!answered.ready) return result(state, answered.middleware, false);
    return this.runUntilBlockedOrReady(state, answered.middleware, affectedArtifactsFromLatestReview(state.review.latest));
  }

  private async runUntilBlockedOrReady(
    inputState: SpecificationWorkflowState,
    priorMiddleware: MiddlewareExecution[] = [],
    revisionArtifactIds: string[] = [],
  ): Promise<SpecificationWorkflowResult> {
    const state = cloneState(inputState);
    const middleware = [...priorMiddleware];

    if (!state.interview.readiness.ready) {
      state.status = "needs-input";
      return result(state, middleware, false);
    }

    let forceRevisionIds = [...revisionArtifactIds];
    while (true) {
      const generated = await this.generateRequiredArtifacts(state, forceRevisionIds, middleware);
      if (!generated.ok) return result(state, middleware, false);
      forceRevisionIds = [];

      const validation = await this.validate(state, middleware);
      if (!validation.ok) return result(state, middleware, false);
      if (!state.validation.latest?.valid) {
        const validationResponse = await this.handleValidationFailure(state, middleware);
        if (!validationResponse.ok) return result(state, middleware, false);
        if (validationResponse.needsInput) return result(state, middleware, false);
        forceRevisionIds = validationResponse.revisionArtifactIds;
        state.status = "needs-revision";
        continue;
      }

      const reviewed = await this.review(state, middleware);
      if (!reviewed.ok) return result(state, middleware, false);

      const latest = state.review.latest;
      if (!latest) return this.fail(state, middleware, "review-missing", "Review did not produce a result.");
      if (latest.verdict === "pass") {
        if (readyInvariantHolds(state)) {
          state.status = "ready";
          middleware.push(await this.emit("specification.ready", state));
          return result(state, middleware, true);
        }
        return this.fail(state, middleware, "ready-invariant", "Final readiness invariant did not hold.");
      }

      if (state.review.attempts.length >= this.maxReviewIterations) {
        return this.fail(state, middleware, "review-iteration-limit", "Maximum review iterations reached.");
      }

      if (latest.verdict === "needs_input") {
        await this.reopenInterview(state, latest.findings.filter((finding) => finding.severity === "error"), "review", middleware);
        middleware.push(await this.emit("interview.reopened", state, { review: latest }));
        state.status = "needs-input";
        return result(state, middleware, false);
      }

      state.status = "needs-revision";
      forceRevisionIds = affectedArtifactsFromFindings(latest.findings, state.generation.artifacts);
      if (forceRevisionIds.length === 0) {
        return this.fail(state, middleware, "revision-target-missing", "Review requested revision but did not identify an artifact.");
      }
    }
  }

  private async generateRequiredArtifacts(
    state: SpecificationWorkflowState,
    revisionArtifactIds: string[],
    middleware: MiddlewareExecution[],
  ): Promise<{ ok: boolean }> {
    middleware.push(await this.emit("generation.started", state));
    const revisionIds = new Set(revisionArtifactIds);
    const seen = new Set<string>();

    while (true) {
      if (state.generation.attempts >= this.maxGenerationIterations) {
        await this.fail(state, middleware, "generation-iteration-limit", "Maximum artifact generation iterations reached.");
        return { ok: false };
      }

      const status = await this.dependencies.openSpecGateway.getStatus(state);
      if (!status.ok || !status.context) {
        await this.fail(state, middleware, "openspec-status", status.error?.message ?? "OpenSpec status failed.", status.error);
        return { ok: false };
      }

      const nextArtifact = nextArtifactForGeneration(status.context.openspec.artifacts, state.generation.artifacts, revisionIds);
      if (!nextArtifact) return { ok: true };

      const loopKey = `${nextArtifact.id}:${nextArtifact.status ?? "unknown"}:${revisionIds.has(nextArtifact.id) ? "revise" : "create"}`;
      if (seen.has(loopKey)) {
        await this.fail(state, middleware, "generation-no-progress", `OpenSpec generation made no progress for ${nextArtifact.id}.`);
        return { ok: false };
      }
      seen.add(loopKey);

      const mode: GenerationMode = revisionIds.has(nextArtifact.id) ? "revise" : "create";
      const artifactResult = await this.generateOneArtifact(state, nextArtifact, mode, middleware);
      if (!artifactResult.ok) return { ok: false };
      revisionIds.delete(nextArtifact.id);
      if (mode === "revise") {
        for (const dependentArtifactId of downstreamGeneratedArtifactIds(nextArtifact.id, status.context.openspec.artifacts, state.generation.artifacts)) {
          revisionIds.add(dependentArtifactId);
        }
      }
    }
  }

  private async generateOneArtifact(
    state: SpecificationWorkflowState,
    statusArtifact: OpenSpecArtifact,
    mode: GenerationMode,
    middleware: MiddlewareExecution[],
  ): Promise<{ ok: boolean }> {
    state.status = "generating";
    middleware.push(await this.emit("artifact.generation.started", state, { artifactId: statusArtifact.id, mode }));

    const instructionsResult = await this.dependencies.openSpecGateway.getArtifactInstructions({
      projectRoot: state.projectRoot,
      changeName: state.changeName,
      artifactId: statusArtifact.id,
    });
    if (!instructionsResult.ok || !instructionsResult.context) {
      await this.fail(state, middleware, "openspec-instructions", instructionsResult.error?.message ?? "OpenSpec artifact instructions failed.", instructionsResult.error);
      return { ok: false };
    }

    const instructionArtifact = matchingArtifact(instructionsResult.context.openspec.artifacts, statusArtifact.id);
    const artifact = { ...statusArtifact, ...(instructionArtifact ?? {}) };
    const currentContent = mode === "revise" ? await this.readOptional(state, artifact.path, middleware) : undefined;
    if (state.status === "failed") return { ok: false };
    const dependencies = await this.readDependencies(state, artifact, middleware);
    if (state.status === "failed") return { ok: false };
    let generated;
    try {
      generated = await this.dependencies.artifactGenerator.generate({
        mode,
        artifact,
        instructions: artifact.instructions ?? instructionsResult.context.openspec.instructions?.raw,
        interview: state.interview,
        dependencies,
        currentContent,
        findings: state.review.latest?.findings.filter((finding) => !finding.artifactId || finding.artifactId === artifact.id),
      });
    } catch (error) {
      await this.fail(state, middleware, "artifact-generation", error instanceof Error ? error.message : "Artifact generation failed.", error);
      return { ok: false };
    }

    const write = await this.dependencies.artifactWriter.write({
      projectRoot: state.projectRoot,
      path: artifact.path,
      content: generated.content,
      overwrite: mode === "revise",
    });
    if (!write.ok) {
      await this.fail(state, middleware, `artifact-write-${write.status}`, write.error?.message ?? "Artifact write failed.", write.error);
      return { ok: false };
    }

    const read = await this.dependencies.artifactReader.read({ projectRoot: state.projectRoot, path: artifact.path });
    if (!read.ok || read.content === undefined) {
      await this.fail(state, middleware, `artifact-read-${read.status}`, read.error?.message ?? "Artifact read failed.", read.error);
      return { ok: false };
    }

    upsertGeneratedArtifact(state.generation.artifacts, { artifactId: artifact.id, path: artifact.path, content: read.content });
    state.generation.attempts += 1;
    state.generation.lastArtifactId = artifact.id;
    middleware.push(await this.emit("artifact.generated", state, { artifactId: artifact.id, mode, path: artifact.path }));
    return { ok: true };
  }

  private async validate(state: SpecificationWorkflowState, middleware: MiddlewareExecution[]): Promise<{ ok: boolean }> {
    state.status = "validating";
    const validation = await this.dependencies.openSpecGateway.validate(state);
    if (!validation.context?.openspec.validation) {
      await this.fail(state, middleware, "openspec-validation", validation.error?.message ?? "OpenSpec validation did not return validation context.", validation.error);
      return { ok: false };
    }
    state.validation.latest = validation.context.openspec.validation;
    middleware.push(await this.emit("openspec.validation.completed", state, { validation: state.validation.latest }));
    return { ok: true };
  }

  private async handleValidationFailure(
    state: SpecificationWorkflowState,
    middleware: MiddlewareExecution[],
  ): Promise<{ ok: true; needsInput: boolean; revisionArtifactIds: string[] } | { ok: false }> {
    const findings = validationFindings(state.validation.latest);
    const inputFindings = findings.filter((finding) => finding.category === "missing-requirement" || finding.suggestedQuestion);
    if (inputFindings.length > 0) {
      await this.reopenInterview(state, inputFindings, "validation", middleware);
      middleware.push(await this.emit("interview.reopened", state, { source: "validation" }));
      state.status = "needs-input";
      return { ok: true, needsInput: true, revisionArtifactIds: [] };
    }

    if (state.validation.repairAttempts >= this.maxValidationRepairIterations) {
      await this.fail(state, middleware, "validation-repair-limit", "Maximum validation repair attempts reached.");
      return { ok: false };
    }

    const status = await this.dependencies.openSpecGateway.getStatus(state);
    if (!status.ok || !status.context) {
      await this.fail(state, middleware, "openspec-status-validation-repair", status.error?.message ?? "OpenSpec status failed during validation repair.", status.error);
      return { ok: false };
    }

    const revisionArtifactIds = targetArtifactsFromValidation(
      state.validation.latest,
      state.generation.artifacts,
      status.context.openspec.artifacts.filter((artifact) => artifact.authority === "workflow"),
    );
    if (revisionArtifactIds.length === 0) {
      await this.fail(state, middleware, "validation-target-unknown", "OpenSpec validation failed without a deterministic artifact target.");
      return { ok: false };
    }

    state.validation.repairAttempts += 1;
    return { ok: true, needsInput: false, revisionArtifactIds };
  }

  private async review(state: SpecificationWorkflowState, middleware: MiddlewareExecution[]): Promise<{ ok: boolean }> {
    if (!state.validation.latest?.valid) {
      await this.fail(state, middleware, "review-before-validation", "Review cannot run before valid OpenSpec validation.");
      return { ok: false };
    }
    state.status = "reviewing";
    middleware.push(await this.emit("review.started", state, undefined, { reviewIteration: state.review.attempts.length + 1 }));
    const status = await this.dependencies.openSpecGateway.getStatus(state);
    const instructions = await this.dependencies.openSpecGateway.getInstructions(state);
    if (!status.ok || !status.context) {
      await this.fail(state, middleware, "openspec-status-before-review", status.error?.message ?? "OpenSpec status failed before review.", status.error);
      return { ok: false };
    }
    if (!instructions.ok || !instructions.context) {
      await this.fail(
        state,
        middleware,
        "openspec-instructions-before-review",
        instructions.error?.message ?? "OpenSpec instructions failed before review.",
        instructions.error,
      );
      return { ok: false };
    }
    let review;
    try {
      review = await this.dependencies.reviewer.review({
        projectRoot: state.projectRoot,
        changeName: state.changeName,
        interview: state.interview,
        artifacts: state.generation.artifacts,
        status: status.context?.openspec.status?.raw,
        instructions: instructions.context?.openspec.instructions?.raw,
        validation: state.validation.latest,
      });
    } catch (error) {
      await this.fail(state, middleware, "spec-review", error instanceof Error ? error.message : "Spec review failed.", error);
      return { ok: false };
    }
    state.review.attempts.push(review);
    state.review.latest = review;
    for (const finding of review.findings) {
      middleware.push(await this.emit("review.finding.detected", state, { finding }));
    }
    middleware.push(await this.emit("review.completed", state, { review }, { reviewIteration: state.review.attempts.length }));
    return { ok: true };
  }

  private async readDependencies(
    state: SpecificationWorkflowState,
    artifact: OpenSpecArtifact,
    middleware: MiddlewareExecution[],
  ): Promise<GeneratedArtifactContext[]> {
    const dependencyIds = new Set(artifact.dependencies ?? []);
    const dependencies = state.generation.artifacts.filter((generated) => dependencyIds.has(generated.artifactId));
    const readDependencies: GeneratedArtifactContext[] = [];
    for (const dependency of dependencies) {
      const read = await this.dependencies.artifactReader.read({ projectRoot: state.projectRoot, path: dependency.path });
      if (!read.ok || read.content === undefined) {
        await this.fail(state, middleware, `artifact-read-${read.status}`, read.error?.message ?? "Dependency artifact read failed.", read.error);
        return [];
      }
      readDependencies.push({ ...dependency, content: read.content });
    }
    return readDependencies;
  }

  private async readOptional(
    state: SpecificationWorkflowState,
    artifactPath: string,
    middleware: MiddlewareExecution[],
  ): Promise<string | undefined> {
    const read = await this.dependencies.artifactReader.read({ projectRoot: state.projectRoot, path: artifactPath });
    if (read.status === "not-found") return undefined;
    if (!read.ok) {
      await this.fail(state, middleware, `artifact-read-${read.status}`, read.error?.message ?? "Artifact read failed.", read.error);
      return undefined;
    }
    return read.content;
  }

  private async reopenInterview(
    state: SpecificationWorkflowState,
    findings: ReviewFinding[],
    source: "review" | "validation",
    middleware: MiddlewareExecution[],
  ): Promise<void> {
    const materialFindings = findings.length ? findings : [fallbackFinding(`${source}-input`, `${source} requires human input.`)];
    const reopened = await this.dependencies.interviewEngine.addExternalGaps({
      session: state.interview,
      gaps: materialFindings.map((finding) => ({
        id: finding.id,
        source,
        reason: finding.reason,
        artifactId: finding.artifactId,
        suggestedQuestion: finding.suggestedQuestion,
        issue: finding.issue,
      })),
    });
    state.interview = reopened.session;
    middleware.push(...reopened.middleware);
  }

  private async fail(
    state: SpecificationWorkflowState,
    middleware: MiddlewareExecution[],
    code: string,
    message: string,
    cause?: unknown,
  ): Promise<SpecificationWorkflowResult> {
    state.status = "failed";
    state.failure = { code, message, ...(cause ? { cause } : {}) };
    middleware.push(await this.emit("specification.failed", state, { failure: state.failure }));
    return result(state, middleware, false);
  }

  private emit(
    eventName: Parameters<MiddlewareBus["execute"]>[0],
    state: SpecificationWorkflowState,
    extraMetadata?: Record<string, unknown>,
    lifecycle?: { reviewIteration?: number },
  ): Promise<MiddlewareExecution> {
    return this.bus.execute(eventName, {
      runId: `specification:${state.changeName}`,
      subjectId: state.changeName,
      lifecycle,
      metadata: {
        state,
        ...(extraMetadata ?? {}),
      },
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function nextArtifactForGeneration(
  artifacts: OpenSpecArtifact[],
  generated: GeneratedArtifactContext[],
  revisionIds: Set<string>,
): OpenSpecArtifact | undefined {
  const authoritative = artifacts.filter((artifact) => artifact.authority === "workflow");
  const revision = authoritative.find((artifact) => revisionIds.has(artifact.id));
  if (revision) return revision;
  return authoritative.find((artifact) => artifact.state !== "complete");
}

function matchingArtifact(artifacts: OpenSpecArtifact[], artifactId: string): OpenSpecArtifact | undefined {
  return artifacts.find((artifact) => artifact.id === artifactId);
}

function downstreamGeneratedArtifactIds(
  artifactId: string,
  artifacts: OpenSpecArtifact[],
  generated: GeneratedArtifactContext[],
): string[] {
  const generatedIds = new Set(generated.map((artifact) => artifact.artifactId));
  const downstream = new Set<string>();
  const queue = [artifactId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const artifact of artifacts) {
      if (!artifact.dependencies?.includes(current) || downstream.has(artifact.id)) continue;
      if (generatedIds.has(artifact.id)) downstream.add(artifact.id);
      queue.push(artifact.id);
    }
  }
  return [...downstream];
}

function upsertGeneratedArtifact(artifacts: GeneratedArtifactContext[], artifact: GeneratedArtifactContext): void {
  const index = artifacts.findIndex((item) => item.artifactId === artifact.artifactId);
  if (index === -1) artifacts.push(artifact);
  else artifacts[index] = artifact;
}

function affectedArtifactsFromLatestReview(review: SpecReview | undefined): string[] {
  return review ? affectedArtifactsFromFindings(review.findings, []) : [];
}

function affectedArtifactsFromFindings(findings: ReviewFinding[], fallbackArtifacts: GeneratedArtifactContext[]): string[] {
  const fromFindings = [...new Set(findings.map((finding) => finding.artifactId).filter((id): id is string => Boolean(id)))];
  if (fromFindings.length > 0) return fromFindings;
  return fallbackArtifacts[0] ? [fallbackArtifacts[0].artifactId] : [];
}

function validationFindings(validation: OpenSpecValidation | undefined): ReviewFinding[] {
  const findings = validation?.findings ?? [];
  if (findings.length === 0) return [fallbackFinding("openspec-validation", validation?.stderr || validation?.stdout || "OpenSpec validation failed.")];
  return findings.map((finding, index) => ({
    id: finding.code ?? finding.artifactId ?? finding.path ?? `openspec-validation-${index + 1}`,
    severity: "error",
    artifactId: finding.artifactId,
    issue: "OpenSpec validation failed.",
    reason: finding.message,
    category: "openspec-compliance",
  }));
}

function targetArtifactsFromValidation(
  validation: OpenSpecValidation | undefined,
  artifacts: GeneratedArtifactContext[],
  openspecArtifacts: OpenSpecArtifact[],
): string[] {
  const targets = new Set<string>();
  for (const finding of validation?.findings ?? []) {
    if (finding.artifactId) targets.add(finding.artifactId);
    if (finding.path) {
      const generated = artifacts.find((candidate) => normalizePath(candidate.path) === normalizePath(finding.path ?? ""));
      if (generated) targets.add(generated.artifactId);
      const openspec = openspecArtifacts.find((candidate) => normalizePath(candidate.path) === normalizePath(finding.path ?? ""));
      if (openspec) targets.add(openspec.id);
    }
  }
  return [...targets];
}

function fallbackFinding(id: string, reason: string): ReviewFinding {
  return { id, severity: "error", issue: reason, reason };
}

function readyInvariantHolds(state: SpecificationWorkflowState): boolean {
  return state.interview.readiness.ready && state.validation.latest?.valid === true && state.review.latest?.verdict === "pass";
}

function result(
  state: SpecificationWorkflowState,
  middleware: MiddlewareExecution[],
  ready: boolean,
): SpecificationWorkflowResult {
  return {
    status: state.status,
    state,
    question: state.interview.unresolvedQuestions.at(-1),
    ready,
    middleware,
  };
}

function cloneState(state: SpecificationWorkflowState): SpecificationWorkflowState {
  return structuredClone(state);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
