import { existsSync } from "node:fs";
import path from "node:path";
import { MiddlewareBus } from "../bus.ts";
import type { MiddlewareContext, MiddlewareExecution } from "../middleware/types.ts";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../process-runner.ts";
import type {
  OpenSpecArtifact,
  OpenSpecArtifactInput,
  OpenSpecArtifactState,
  OpenSpecChangeInput,
  OpenSpecCommandResult,
  OpenSpecCreateChangeInput,
  OpenSpecGateway,
  OpenSpecGatewayError,
  OpenSpecGatewayResult,
  OpenSpecGatewayStatus,
  OpenSpecInstructions,
  OpenSpecStatus,
  OpenSpecValidationFinding,
  SpecContext,
} from "./types.ts";

export interface CliOpenSpecGatewayOptions {
  bus?: MiddlewareBus;
  processRunner?: ProcessRunner;
  openspecCommand?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CliOpenSpecGateway implements OpenSpecGateway {
  private readonly bus: MiddlewareBus;
  private readonly processRunner: ProcessRunner;
  private readonly openspecCommand: string;
  private readonly timeoutMs: number;

  constructor(options: CliOpenSpecGatewayOptions = {}) {
    this.bus = options.bus ?? new MiddlewareBus();
    this.processRunner = options.processRunner ?? new NodeProcessRunner();
    this.openspecCommand = options.openspecCommand ?? "openspec";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createChange(input: OpenSpecCreateChangeInput): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: false });
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute("openspec.change.create.before", middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const args = ["new", "change", resolved.changeName, "--json"];
    if (input.description) args.push("--description", input.description);
    if (input.goal) args.push("--goal", input.goal);
    if (input.schema) args.push("--schema", input.schema);

    const cli = await this.runCli(args, resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const raw = parseJsonOutput(cli.stdout);
    const context = baseContext(resolved.projectRoot, resolved.changeName, {
      create: commandResult(cli, normalizeMetadata(raw), raw),
    });
    const after = await this.bus.execute("openspec.change.create.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return { ok: cli.exitCode === 0, status: cli.exitCode === 0 ? "created" : "command-failed", context, middleware: { before, after } };
  }

  async getStatus(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: true });
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute("openspec.status.before", middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const cli = await this.runCli(["status", "--change", resolved.changeName, "--json"], resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const raw = parseJsonOutput(cli.stdout);
    const context = baseContext(resolved.projectRoot, resolved.changeName, {
      status: commandResult(cli, normalizeStatus(raw), raw),
    });
    const after = await this.bus.execute("openspec.status.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return { ok: cli.exitCode === 0, status: cli.exitCode === 0 ? "status-read" : "command-failed", context, middleware: { before, after } };
  }

  async getInstructions(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: true });
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute("openspec.instructions.before", middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const cli = await this.runCli(["instructions", "--change", resolved.changeName, "--json"], resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const raw = parseJsonOutput(cli.stdout);
    const context = baseContext(resolved.projectRoot, resolved.changeName, {
      instructions: commandResult(cli, normalizeInstructions(raw), raw),
    });
    const after = await this.bus.execute("openspec.instructions.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return {
      ok: cli.exitCode === 0,
      status: cli.exitCode === 0 ? "instructions-read" : "command-failed",
      context,
      middleware: { before, after },
    };
  }

  async getArtifactInstructions(input: OpenSpecArtifactInput): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: true });
    if (!resolved.ok) return failure(resolved.status, resolved.message);
    if (!input.artifactId.trim()) return failure("path-rejected", "artifactId is required");

    const before = await this.bus.execute("openspec.instructions.before", middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const cli = await this.runCli(["instructions", input.artifactId, "--change", resolved.changeName, "--json"], resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const raw = parseJsonOutput(cli.stdout);
    const context = baseContext(resolved.projectRoot, resolved.changeName, {
      instructions: commandResult(cli, normalizeInstructions(raw), raw),
    });
    const after = await this.bus.execute("openspec.instructions.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return {
      ok: cli.exitCode === 0,
      status: cli.exitCode === 0 ? "instructions-read" : "command-failed",
      context,
      middleware: { before, after },
    };
  }

  async validate(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: true });
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute("openspec.validate.before", middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const cli = await this.runCli(["validate", resolved.changeName, "--json", "--no-interactive"], resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const raw = parseJsonOutput(cli.stdout);
    const context = baseContext(resolved.projectRoot, resolved.changeName, {
      validation: {
        valid: cli.exitCode === 0,
        exitCode: cli.exitCode,
        findings: normalizeValidationFindings(raw, cli.stderr),
        raw,
        stdout: cli.stdout,
        stderr: cli.stderr,
      },
    });
    const after = await this.bus.execute("openspec.validate.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return { ok: cli.exitCode === 0, status: cli.exitCode === 0 ? "valid" : "invalid", context, middleware: { before, after } };
  }

  private runCli(args: string[], cwd: string): Promise<ProcessResult> {
    return this.processRunner.run(this.openspecCommand, args, { cwd, timeoutMs: this.timeoutMs });
  }
}

type ResolvedChange =
  | { ok: true; projectRoot: string; changeName: string; changeDir: string }
  | { ok: false; status: "path-rejected" | "project-not-initialized" | "missing-change"; message: string };

function resolveChange(input: OpenSpecChangeInput, options: { requireExistingChange: boolean }): ResolvedChange {
  if (!input.projectRoot || !input.changeName) return { ok: false, status: "path-rejected", message: "projectRoot and changeName are required" };
  if (input.changeName.includes("/") || input.changeName.includes("\\") || input.changeName === "." || input.changeName === "..") {
    return { ok: false, status: "path-rejected", message: `Invalid OpenSpec change name: ${input.changeName}` };
  }

  const projectRoot = path.resolve(input.projectRoot);
  const openspecRoot = path.join(projectRoot, "openspec");
  if (!existsSync(openspecRoot)) {
    return { ok: false, status: "project-not-initialized", message: `OpenSpec project directory not found: ${openspecRoot}` };
  }

  const changeDir = path.resolve(projectRoot, "openspec", "changes", input.changeName);
  const changesRoot = path.resolve(projectRoot, "openspec", "changes");
  if (!isWithin(changesRoot, changeDir)) {
    return { ok: false, status: "path-rejected", message: `OpenSpec change escapes project root: ${input.changeName}` };
  }
  if (options.requireExistingChange && !existsSync(changeDir)) {
    return { ok: false, status: "missing-change", message: `OpenSpec change not found: ${input.changeName}` };
  }

  return { ok: true, projectRoot, changeName: input.changeName, changeDir };
}

function baseContext(projectRoot: string, changeName: string, openspec: Partial<SpecContext["openspec"]>): SpecContext {
  const artifacts = mergeArtifacts(openspec.artifacts ?? [], openspec.status?.normalized.artifacts ?? [], openspec.instructions?.normalized.artifacts ?? []);
  const metadata = {
    ...(openspec.metadata ?? {}),
    ...(openspec.status?.normalized.metadata ?? {}),
    ...(openspec.instructions?.normalized.metadata ?? {}),
  };

  return {
    system: "openspec",
    changeName,
    projectRoot,
    openspec: {
      artifacts,
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...openspec,
    },
  };
}

function normalizeStatus(raw: unknown): OpenSpecStatus {
  return { artifacts: collectArtifacts(raw), metadata: normalizeMetadata(raw) };
}

function normalizeInstructions(raw: unknown): OpenSpecInstructions {
  return { artifacts: collectArtifacts(raw), metadata: normalizeMetadata(raw) };
}

function collectArtifacts(raw: unknown): OpenSpecArtifact[] {
  const artifacts = new Map<string, OpenSpecArtifact>();
  collectDocumentedArtifacts(raw, artifacts);
  collectArtifactsFromValue(raw, artifacts);
  return [...artifacts.values()];
}

function collectDocumentedArtifacts(raw: unknown, artifacts: Map<string, OpenSpecArtifact>): void {
  if (!isObject(raw)) return;

  if (Array.isArray(raw.artifacts)) {
    for (const item of raw.artifacts) {
      const artifact = normalizeArtifactObject(item, "documented");
      if (artifact) upsertArtifact(artifacts, artifact);
    }
  }

  const artifact = normalizeArtifactObject(raw.artifact, "documented");
  if (artifact) upsertArtifact(artifacts, artifact);
}

function collectArtifactsFromValue(value: unknown, artifacts: Map<string, OpenSpecArtifact>, parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactsFromValue(item, artifacts, parentKey);
    return;
  }
  if (!isObject(value)) {
    if (typeof value === "string" && parentKey && looksLikeArtifactCollection(parentKey)) {
      upsertArtifact(artifacts, {
        id: value,
        path: value,
        state: "unknown",
        authority: "compatibility",
        raw: value,
      });
    }
    return;
  }

  const id = stringField(value, "id") ?? stringField(value, "artifactId") ?? stringField(value, "artifact") ?? stringField(value, "name") ?? stringField(value, "key");
  const pathValue =
    stringField(value, "resolvedOutputPath") ?? stringField(value, "outputPath") ?? stringField(value, "path") ?? stringField(value, "file") ?? stringField(value, "targetPath");
  if (id || pathValue) {
    upsertArtifact(artifacts, {
      id: id ?? pathValue ?? "artifact",
      path: pathValue ?? id ?? "artifact",
      status: stringField(value, "status") ?? stringField(value, "state"),
      state: normalizeArtifactState(stringField(value, "status") ?? stringField(value, "state")),
      authority: "compatibility",
      dependencies: stringArray(value.dependencies) ?? stringArray(value.dependsOn) ?? stringArray(value.requires),
      instructions: value.instructions ?? value.instruction,
      template: stringField(value, "template"),
      metadata: normalizeMetadata(value),
      raw: value,
    });
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isObject(nested) && looksLikeArtifactId(key)) {
      const nestedId = stringField(nested, "id") ?? stringField(nested, "artifactId") ?? key;
      upsertArtifact(artifacts, {
        id: nestedId,
      path: stringField(nested, "resolvedOutputPath") ?? stringField(nested, "outputPath") ?? stringField(nested, "path") ?? nestedId,
        status: stringField(nested, "status") ?? stringField(nested, "state"),
        state: normalizeArtifactState(stringField(nested, "status") ?? stringField(nested, "state")),
        authority: "compatibility",
        dependencies: stringArray(nested.dependencies) ?? stringArray(nested.dependsOn) ?? stringArray(nested.requires),
        instructions: nested.instructions ?? nested.instruction,
        template: stringField(nested, "template"),
        metadata: normalizeMetadata(nested),
        raw: nested,
      });
    }
    collectArtifactsFromValue(nested, artifacts, key);
  }
}

function normalizeArtifactObject(value: unknown, normalization: "documented" | "compatibility"): OpenSpecArtifact | undefined {
  if (!isObject(value)) return undefined;
  const id = stringField(value, "id") ?? stringField(value, "artifactId") ?? stringField(value, "artifact") ?? stringField(value, "name") ?? stringField(value, "key");
  const pathValue =
    stringField(value, "resolvedOutputPath") ?? stringField(value, "outputPath") ?? stringField(value, "path") ?? stringField(value, "file") ?? stringField(value, "targetPath");
  if (!id && !pathValue) return undefined;
  const status = stringField(value, "status") ?? stringField(value, "state");

  return {
    id: id ?? pathValue ?? "artifact",
    path: pathValue ?? id ?? "artifact",
    status,
    state: normalizeArtifactState(status),
    authority: normalization === "documented" ? "workflow" : "compatibility",
    dependencies: stringArray(value.dependencies) ?? stringArray(value.dependsOn) ?? stringArray(value.requires),
    instructions: value.instructions ?? value.instruction,
    template: stringField(value, "template"),
    metadata: normalizeMetadata(value),
    raw: value,
  };
}

function upsertArtifact(artifacts: Map<string, OpenSpecArtifact>, artifact: OpenSpecArtifact): void {
  const existing = artifacts.get(artifact.id);
  const nextAuthority = existing?.authority === "workflow" && artifact.authority === "compatibility" ? "workflow" : artifact.authority;
  artifacts.set(artifact.id, {
    ...(existing ?? {}),
    ...artifact,
    authority: nextAuthority,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(artifact.metadata ?? {}),
    },
  });
}

function normalizeArtifactState(status: string | undefined): OpenSpecArtifactState {
  const value = status?.trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "missing" || value === "pending" || value === "incomplete" || value === "required") return "pending";
  if (value === "available" || value === "ready") return "ready";
  if (value === "blocked" || value === "waiting") return "blocked";
  if (value === "complete" || value === "completed" || value === "valid" || value === "done" || value === "written") return "complete";
  return "unknown";
}

function normalizeValidationFindings(raw: unknown, stderr: string): OpenSpecValidationFinding[] {
  const findings: OpenSpecValidationFinding[] = [];
  collectValidationFindings(raw, findings);
  if (findings.length === 0 && stderr.trim()) {
    findings.push({ message: stderr.trim(), raw: stderr });
  }
  return findings;
}

function collectValidationFindings(value: unknown, findings: OpenSpecValidationFinding[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectValidationFindings(item, findings);
    return;
  }
  if (!isObject(value)) return;

  const message =
    stringField(value, "message") ??
    stringField(value, "error") ??
    stringField(value, "detail") ??
    stringField(value, "reason") ??
    stringField(value, "summary");
  const artifactId =
    stringField(value, "artifactId") ??
    stringField(value, "artifact") ??
    (isObject(value.artifact) ? stringField(value.artifact, "id") : undefined);
  const pathValue = stringField(value, "path") ?? stringField(value, "file") ?? stringField(value, "targetPath");
  const code = stringField(value, "code");
  if (message) {
    findings.push({
      ...(artifactId ? { artifactId } : {}),
      ...(pathValue ? { path: pathValue } : {}),
      message,
      ...(code ? { code } : {}),
      raw: value,
    });
  }

  for (const key of ["findings", "errors", "issues", "diagnostics", "items", "results"]) {
    collectValidationFindings(value[key], findings);
  }
}

function mergeArtifacts(...groups: OpenSpecArtifact[][]): OpenSpecArtifact[] {
  const artifacts = new Map<string, OpenSpecArtifact>();
  for (const group of groups) for (const artifact of group) upsertArtifact(artifacts, artifact);
  return [...artifacts.values()];
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  return isObject(value.metadata) ? { ...value.metadata } : {};
}

function commandResult<T>(cli: ProcessResult, normalized: T, raw = parseJsonOutput(cli.stdout)): OpenSpecCommandResult<T> {
  return { normalized, raw, stdout: cli.stdout, stderr: cli.stderr, exitCode: cli.exitCode };
}

function middlewareContext(projectRoot: string, changeName: string): Omit<MiddlewareContext, "event"> {
  return { runId: `openspec:${changeName}`, subjectId: changeName, metadata: { system: "openspec", projectRoot, changeName } };
}

function afterContext(context: SpecContext): Omit<MiddlewareContext, "event"> {
  return { runId: `openspec:${context.changeName}`, subjectId: context.changeName, metadata: { system: "openspec", specContext: context } };
}

function haltIfNeeded(beforeOrAfter: MiddlewareExecution, context?: SpecContext, before?: MiddlewareExecution): OpenSpecGatewayResult | undefined {
  if (beforeOrAfter.result.action !== "deny" && beforeOrAfter.result.action !== "require-human") return undefined;
  const status = beforeOrAfter.result.action === "deny" ? "middleware-denied" : "requires-human";
  return {
    ok: false,
    status,
    ...(context ? { context } : {}),
    error: { code: status, message: beforeOrAfter.result.reason },
    middleware: before ? { before, after: beforeOrAfter } : { before: beforeOrAfter },
  };
}

function isCliExecutionFailure(result: ProcessResult): boolean {
  return result.error !== undefined || result.timedOut === true;
}

function cliFailure(result: ProcessResult, before: MiddlewareExecution): OpenSpecGatewayResult {
  if (result.error?.code === "ENOENT") return failure("cli-unavailable", "OpenSpec CLI is unavailable.", result.error, before);
  return failure("command-failed", result.timedOut ? "OpenSpec CLI command timed out." : "OpenSpec CLI command failed to execute.", result.error, before);
}

function failure(status: OpenSpecGatewayStatus, message: string, cause?: unknown, before?: MiddlewareExecution): OpenSpecGatewayResult {
  const error: OpenSpecGatewayError = { code: status, message, ...(cause ? { cause } : {}) };
  return { ok: false, status, error, middleware: { ...(before ? { before } : {}) } };
}

function parseJsonOutput(stdout: string): unknown | undefined {
  if (!stdout.trim()) return undefined;
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function looksLikeArtifactCollection(key: string): boolean {
  return /artifacts?|graph|templates?|next/i.test(key);
}

function looksLikeArtifactId(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
