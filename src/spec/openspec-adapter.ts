import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MiddlewareBus } from "../bus.ts";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../process-runner.ts";
import type { MiddlewareContext, MiddlewareExecution } from "../types.ts";
import type {
  ArtifactRef,
  SpecAdapter,
  SpecContext,
  SpecInspectInput,
  SpecInspectionError,
  SpecInspectionResult,
  SpecInspectionStatus,
} from "./types.ts";

export interface OpenSpecAdapterOptions {
  bus?: MiddlewareBus;
  processRunner?: ProcessRunner;
  openspecCommand?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class OpenSpecAdapter implements SpecAdapter {
  private readonly bus: MiddlewareBus;
  private readonly processRunner: ProcessRunner;
  private readonly openspecCommand: string;
  private readonly timeoutMs: number;

  constructor(options: OpenSpecAdapterOptions = {}) {
    this.bus = options.bus ?? new MiddlewareBus();
    this.processRunner = options.processRunner ?? new NodeProcessRunner();
    this.openspecCommand = options.openspecCommand ?? "openspec";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async inspect(input: SpecInspectInput): Promise<SpecInspectionResult> {
    const resolved = resolveChange(input);
    if (!resolved.ok) {
      return failure(resolved.status, resolved.message);
    }

    const { projectRoot, changeName, changeDir } = resolved;
    if (!existsSync(path.join(projectRoot, "openspec"))) {
      return failure("project-not-initialized", `OpenSpec project directory not found: ${path.join(projectRoot, "openspec")}`);
    }

    if (!existsSync(changeDir)) {
      return failure("missing-change", `OpenSpec change not found: ${changeName}`);
    }

    const before = await this.bus.execute("spec.validate.before", middlewareContext(projectRoot, changeName));
    if (before.result.action === "deny") {
      return halted("middleware-denied", before.result.reason, before);
    }
    if (before.result.action === "require-human") {
      return halted("requires-human", before.result.reason, before);
    }

    const cli = await this.processRunner.run(
      this.openspecCommand,
      ["validate", changeName, "--json", "--no-interactive"],
      { cwd: projectRoot, timeoutMs: this.timeoutMs },
    );

    if (cli.error?.code === "ENOENT") {
      return failure("cli-unavailable", `OpenSpec CLI is unavailable: ${this.openspecCommand}`, cli.error, before);
    }

    if (cli.error || cli.timedOut) {
      return failure("command-failed", "OpenSpec validation command failed to execute", cli.error, before);
    }

    const artifacts = await discoverArtifacts(projectRoot, changeName, changeDir);
    const metadata = artifacts.metadata ? await readMetadata(artifacts.metadata.absolutePath) : undefined;
    const taskProgress = artifacts.tasks ? await readTaskProgress(artifacts.tasks.absolutePath) : undefined;
    const parsedOutput = parseJsonOutput(cli.stdout);
    const context: SpecContext = {
      system: "openspec",
      changeName,
      projectRoot,
      ...(metadata ? { metadata } : {}),
      artifacts,
      validation: {
        valid: cli.exitCode === 0,
        exitCode: cli.exitCode,
        findings: parsedOutput === undefined ? undefined : [parsedOutput],
        stdout: cli.stdout,
        stderr: cli.stderr,
      },
      ...(taskProgress ? { taskProgress } : {}),
    };

    const after = await this.bus.execute("spec.validate.after", {
      ...middlewareContext(projectRoot, changeName),
      metadata: { spec: context },
    });

    if (after.result.action === "deny") {
      return {
        ok: false,
        status: "middleware-denied",
        context,
        error: { code: "middleware-denied", message: after.result.reason },
        middleware: { before, after },
      };
    }
    if (after.result.action === "require-human") {
      return {
        ok: false,
        status: "requires-human",
        context,
        error: { code: "requires-human", message: after.result.reason },
        middleware: { before, after },
      };
    }

    return {
      ok: cli.exitCode === 0,
      status: cli.exitCode === 0 ? "valid" : "invalid",
      context,
      middleware: { before, after },
    };
  }
}

type ResolvedChange =
  | { ok: true; projectRoot: string; changeName: string; changeDir: string }
  | { ok: false; status: "path-rejected"; message: string };

function resolveChange(input: SpecInspectInput): ResolvedChange {
  if (!input.projectRoot || !input.changeName) {
    return { ok: false, status: "path-rejected", message: "projectRoot and changeName are required" };
  }

  if (input.changeName.includes("/") || input.changeName.includes("\\") || input.changeName === "." || input.changeName === "..") {
    return { ok: false, status: "path-rejected", message: `Invalid OpenSpec change name: ${input.changeName}` };
  }

  const projectRoot = path.resolve(input.projectRoot);
  const changeDir = path.resolve(projectRoot, "openspec", "changes", input.changeName);
  const changesRoot = path.resolve(projectRoot, "openspec", "changes");

  if (!isWithin(changesRoot, changeDir)) {
    return { ok: false, status: "path-rejected", message: `OpenSpec change escapes project root: ${input.changeName}` };
  }

  return { ok: true, projectRoot, changeName: input.changeName, changeDir };
}

function middlewareContext(projectRoot: string, changeName: string): Omit<MiddlewareContext, "event"> {
  return {
    runId: `openspec:${changeName}`,
    taskId: changeName,
    metadata: {
      system: "openspec",
      projectRoot,
      changeName,
    },
  };
}

async function discoverArtifacts(projectRoot: string, changeName: string, changeDir: string): Promise<SpecContext["artifacts"]> {
  const artifact = (kind: ArtifactRef["kind"], relativePath: string): ArtifactRef => {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (!isWithin(changeDir, absolutePath)) {
      throw new Error(`Artifact escapes OpenSpec change directory: ${relativePath}`);
    }
    return { kind, path: normalizePath(relativePath), absolutePath };
  };

  const maybeFile = async (kind: ArtifactRef["kind"], fileName: string): Promise<ArtifactRef | undefined> => {
    const relativePath = path.join("openspec", "changes", changeName, fileName);
    const absolutePath = path.resolve(projectRoot, relativePath);
    return (await isFile(absolutePath)) ? artifact(kind, relativePath) : undefined;
  };

  const specsDir = path.join(changeDir, "specs");
  return {
    proposal: await maybeFile("proposal", "proposal.md"),
    design: await maybeFile("design", "design.md"),
    tasks: await maybeFile("tasks", "tasks.md"),
    metadata: await maybeFile("metadata", ".openspec.yaml"),
    specs: (await collectSpecArtifacts(projectRoot, changeDir, specsDir)).map((relativePath) => artifact("spec", relativePath)),
  };
}

async function collectSpecArtifacts(projectRoot: string, changeDir: string, specsDir: string): Promise<string[]> {
  if (!(await isDirectory(specsDir))) return [];

  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (!isWithin(changeDir, dir)) {
      throw new Error(`Spec directory escapes OpenSpec change directory: ${dir}`);
    }

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

  await visit(specsDir);
  return found.sort((left, right) => left.localeCompare(right));
}

async function readMetadata(filePath: string): Promise<SpecContext["metadata"]> {
  const text = await readFile(filePath, "utf8");
  const metadata: NonNullable<SpecContext["metadata"]> = {};
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = parseScalar(rawValue);
    if (key === "schema" && typeof value === "string") metadata.schema = value;
    if (key === "created" && typeof value === "string") metadata.created = value;
    if (key === "goal" && typeof value === "string") metadata.goal = value;
    if (key === "skip_specs" && typeof value === "boolean") metadata.skipSpecs = value;
    if (key === "affected_areas") metadata.affectedAreas = parseStringArray(rawValue) ?? parseBlockStringArray(lines, index + 1);
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
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

async function readTaskProgress(filePath: string): Promise<SpecContext["taskProgress"]> {
  const text = await readFile(filePath, "utf8");
  const matches = [...text.matchAll(/^\s*[-*]\s+\[( |x|X)\]/gm)];
  if (matches.length === 0) return undefined;

  return {
    completed: matches.filter((match) => match[1].toLowerCase() === "x").length,
    total: matches.length,
  };
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

function failure(
  status: Exclude<SpecInspectionStatus, "valid" | "invalid" | "middleware-denied" | "requires-human">,
  message: string,
  cause?: unknown,
  before?: MiddlewareExecution,
): SpecInspectionResult {
  const error: SpecInspectionError = { code: status, message, ...(cause ? { cause } : {}) };
  return { ok: false, status, error, middleware: { ...(before ? { before } : {}) } };
}

function halted(status: "middleware-denied" | "requires-human", message: string, before: MiddlewareExecution): SpecInspectionResult {
  return {
    ok: false,
    status,
    error: { code: status, message },
    middleware: { before },
  };
}
