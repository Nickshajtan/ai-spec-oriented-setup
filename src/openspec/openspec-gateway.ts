import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MiddlewareBus } from "../bus.ts";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../process-runner.ts";
import type { MiddlewareContext, MiddlewareExecution } from "../middleware/types.ts";
import type {
  OpenSpecArtifactRef,
  OpenSpecChangeInput,
  OpenSpecCreateChangeInput,
  OpenSpecGateway,
  OpenSpecGatewayError,
  OpenSpecGatewayResult,
  OpenSpecGatewayStatus,
  OpenSpecMetadata,
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

    const args = ["change", "create", resolved.changeName, "--no-interactive"];
    if (input.title) args.push("--title", input.title);
    const cli = await this.runCli(args, resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const context = await buildContext(resolved.projectRoot, resolved.changeName, resolved.changeDir);
    const after = await this.bus.execute("openspec.change.create.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return { ok: cli.exitCode === 0, status: cli.exitCode === 0 ? "created" : "command-failed", context, middleware: { before, after } };
  }

  async getStatus(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult> {
    return this.readCliBackedContext(input, "openspec.status.before", "openspec.status.after", ["change", "status", input.changeName, "--json", "--no-interactive"], "status-read", "status");
  }

  async getInstructions(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult> {
    return this.readCliBackedContext(
      input,
      "openspec.instructions.before",
      "openspec.instructions.after",
      ["change", "instructions", input.changeName, "--json", "--no-interactive"],
      "instructions-read",
      "instructions",
    );
  }

  async validate(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: true });
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute("openspec.validate.before", middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const cli = await this.runCli(["validate", resolved.changeName, "--json", "--no-interactive"], resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const context = await buildContext(resolved.projectRoot, resolved.changeName, resolved.changeDir);
    context.openspec.validation = {
      valid: cli.exitCode === 0,
      exitCode: cli.exitCode,
      output: parseJsonOutput(cli.stdout),
      stdout: cli.stdout,
      stderr: cli.stderr,
    };

    const after = await this.bus.execute("openspec.validate.after", afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return {
      ok: cli.exitCode === 0,
      status: cli.exitCode === 0 ? "valid" : "invalid",
      context,
      middleware: { before, after },
    };
  }

  private async readCliBackedContext(
    input: OpenSpecChangeInput,
    beforeEvent: "openspec.status.before" | "openspec.instructions.before",
    afterEvent: "openspec.status.after" | "openspec.instructions.after",
    args: string[],
    successStatus: "status-read" | "instructions-read",
    outputField: "status" | "instructions",
  ): Promise<OpenSpecGatewayResult> {
    const resolved = resolveChange(input, { requireExistingChange: true });
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute(beforeEvent, middlewareContext(resolved.projectRoot, resolved.changeName));
    const haltedBefore = haltIfNeeded(before);
    if (haltedBefore) return haltedBefore;

    const cli = await this.runCli(args, resolved.projectRoot);
    if (isCliExecutionFailure(cli)) return cliFailure(cli, before);

    const context = await buildContext(resolved.projectRoot, resolved.changeName, resolved.changeDir);
    context.openspec[outputField] = parseJsonOutput(cli.stdout) ?? { stdout: cli.stdout, stderr: cli.stderr, exitCode: cli.exitCode };

    const after = await this.bus.execute(afterEvent, afterContext(context));
    const haltedAfter = haltIfNeeded(after, context, before);
    if (haltedAfter) return haltedAfter;

    return {
      ok: cli.exitCode === 0,
      status: cli.exitCode === 0 ? successStatus : "command-failed",
      context,
      middleware: { before, after },
    };
  }

  private runCli(args: string[], cwd: string): Promise<ProcessResult> {
    return this.processRunner.run(this.openspecCommand, args, { cwd, timeoutMs: this.timeoutMs });
  }
}

type ResolvedChange =
  | { ok: true; projectRoot: string; changeName: string; changeDir: string }
  | { ok: false; status: "path-rejected" | "project-not-initialized" | "missing-change"; message: string };

function resolveChange(input: OpenSpecChangeInput, options: { requireExistingChange: boolean }): ResolvedChange {
  if (!input.projectRoot || !input.changeName) {
    return { ok: false, status: "path-rejected", message: "projectRoot and changeName are required" };
  }

  if (input.changeName.includes("/") || input.changeName.includes("\\") || input.changeName === "." || input.changeName === "..") {
    return { ok: false, status: "path-rejected", message: `Invalid OpenSpec change name: ${input.changeName}` };
  }

  const projectRoot = path.resolve(input.projectRoot);
  const openspecRoot = path.join(projectRoot, "openspec");
  if (!existsSync(openspecRoot)) {
    return { ok: false, status: "project-not-initialized", message: `OpenSpec project directory not found: ${openspecRoot}` };
  }

  const changeName = input.changeName;
  const changeDir = path.resolve(projectRoot, "openspec", "changes", changeName);
  const changesRoot = path.resolve(projectRoot, "openspec", "changes");
  if (!isWithin(changesRoot, changeDir)) {
    return { ok: false, status: "path-rejected", message: `OpenSpec change escapes project root: ${changeName}` };
  }

  if (options.requireExistingChange && !existsSync(changeDir)) {
    return { ok: false, status: "missing-change", message: `OpenSpec change not found: ${changeName}` };
  }

  return { ok: true, projectRoot, changeName, changeDir };
}

function middlewareContext(projectRoot: string, changeName: string): Omit<MiddlewareContext, "event"> {
  return {
    runId: `openspec:${changeName}`,
    subjectId: changeName,
    metadata: {
      system: "openspec",
      projectRoot,
      changeName,
    },
  };
}

function afterContext(context: SpecContext): Omit<MiddlewareContext, "event"> {
  return {
    runId: `openspec:${context.changeName}`,
    subjectId: context.changeName,
    metadata: {
      system: "openspec",
      specContext: context,
    },
  };
}

async function buildContext(projectRoot: string, changeName: string, changeDir: string): Promise<SpecContext> {
  const artifacts = await discoverArtifacts(projectRoot, changeName, changeDir);
  const metadata = artifacts.metadata ? await readMetadata(artifacts.metadata.absolutePath) : undefined;

  return {
    system: "openspec",
    changeName,
    projectRoot,
    openspec: {
      ...(metadata ? { metadata } : {}),
      artifacts,
    },
  };
}

async function discoverArtifacts(projectRoot: string, changeName: string, changeDir: string): Promise<SpecContext["openspec"]["artifacts"]> {
  const artifact = (kind: string, relativePath: string): OpenSpecArtifactRef => {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (!isWithin(changeDir, absolutePath)) {
      throw new Error(`Artifact escapes OpenSpec change directory: ${relativePath}`);
    }
    return { kind, path: normalizePath(relativePath), absolutePath };
  };

  const maybeFile = async (kind: string, fileName: string): Promise<OpenSpecArtifactRef | undefined> => {
    const relativePath = path.join("openspec", "changes", changeName, fileName);
    const absolutePath = path.resolve(projectRoot, relativePath);
    return (await isFile(absolutePath)) ? artifact(kind, relativePath) : undefined;
  };

  const proposal = await maybeFile("proposal", "proposal.md");
  const design = await maybeFile("design", "design.md");
  const tasks = await maybeFile("tasks", "tasks.md");
  const metadata = await maybeFile("metadata", ".openspec.yaml");
  const specsDir = path.join(changeDir, "specs");
  const specs = (await collectFiles(projectRoot, changeDir, specsDir)).map((relativePath) => artifact("spec", relativePath));
  const known = new Set([proposal?.path, design?.path, tasks?.path, metadata?.path, ...specs.map((item) => item.path)].filter(Boolean));
  const other = (await collectFiles(projectRoot, changeDir, changeDir))
    .map((relativePath) => normalizePath(relativePath))
    .filter((relativePath) => !known.has(relativePath))
    .map((relativePath) => artifact("openspec-artifact", relativePath));

  return { proposal, design, tasks, metadata, specs, other };
}

async function collectFiles(projectRoot: string, changeDir: string, startDir: string): Promise<string[]> {
  if (!(await isDirectory(startDir))) return [];

  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (!isWithin(changeDir, dir)) throw new Error(`OpenSpec artifact directory escapes change directory: ${dir}`);

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        found.push(path.relative(projectRoot, absolutePath));
      }
    }
  }

  await visit(startDir);
  return found.sort((left, right) => left.localeCompare(right));
}

async function readMetadata(filePath: string): Promise<OpenSpecMetadata> {
  const raw = await readFile(filePath, "utf8");
  return { raw, known: parseKnownMetadata(raw) };
}

function parseKnownMetadata(text: string): OpenSpecMetadata["known"] {
  const known: NonNullable<OpenSpecMetadata["known"]> = {};
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = parseScalar(rawValue);
    if (key === "schema" && typeof value === "string") known.schema = value;
    if (key === "created" && typeof value === "string") known.created = value;
    if (key === "goal" && typeof value === "string") known.goal = value;
    if (key === "skip_specs" && typeof value === "boolean") known.skipSpecs = value;
    if (key === "affected_areas") known.affectedAreas = parseStringArray(rawValue) ?? parseBlockStringArray(lines, index + 1);
  }

  return Object.keys(known).length > 0 ? known : undefined;
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
  if (result.error?.code === "ENOENT") {
    return failure("cli-unavailable", "OpenSpec CLI is unavailable.", result.error, before);
  }

  return failure("command-failed", result.timedOut ? "OpenSpec CLI command timed out." : "OpenSpec CLI command failed to execute.", result.error, before);
}

function failure(
  status: OpenSpecGatewayStatus,
  message: string,
  cause?: unknown,
  before?: MiddlewareExecution,
): OpenSpecGatewayResult {
  const error: OpenSpecGatewayError = { code: status, message, ...(cause ? { cause } : {}) };
  return { ok: false, status, error, middleware: { ...(before ? { before } : {}) } };
}

function parseScalar(rawValue: string): string | boolean {
  const trimmed = rawValue.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.replace(/^["']|["']$/g, "");
}

function parseStringArray(rawValue: string): string[] | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;

  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseBlockStringArray(lines: string[], startIndex: number): string[] | undefined {
  const values: string[] = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s+-\s+/.test(line)) break;
    values.push(line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
  }

  return values.length > 0 ? values : undefined;
}

function parseJsonOutput(stdout: string): unknown | undefined {
  if (!stdout.trim()) return undefined;

  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
