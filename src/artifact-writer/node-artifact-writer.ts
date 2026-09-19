import { constants } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MiddlewareBus } from "../bus.ts";
import type { MiddlewareContext, MiddlewareExecution } from "../middleware/types.ts";
import type { ArtifactWriter, WriteArtifactInput, WriteArtifactResult, WriteArtifactStatus } from "./types.ts";

export interface NodeArtifactWriterOptions {
  bus?: MiddlewareBus;
  fileSystem?: ArtifactWriterFileSystem;
}

export interface ArtifactWriterFileSystem {
  access(path: string, mode?: number): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
  writeFile(path: string, content: string, options: { encoding: "utf8"; flag: "wx" }): Promise<void>;
}

export class NodeArtifactWriter implements ArtifactWriter {
  private readonly bus: MiddlewareBus;
  private readonly fileSystem: ArtifactWriterFileSystem;

  constructor(options: NodeArtifactWriterOptions = {}) {
    this.bus = options.bus ?? new MiddlewareBus();
    this.fileSystem = options.fileSystem ?? { access, mkdir, rename, rm, writeFile };
  }

  async write(input: WriteArtifactInput): Promise<WriteArtifactResult> {
    const resolved = resolveArtifactPath(input);
    if (!resolved.ok) return failure(resolved.status, resolved.message);

    const before = await this.bus.execute("artifact.write.before", middlewareContext(input, resolved.absolutePath));
    if (before.result.action === "deny") return halted("middleware-denied", before.result.reason, before);
    if (before.result.action === "require-human") return halted("requires-human", before.result.reason, before);

    if (input.overwrite !== true && (await exists(this.fileSystem, resolved.absolutePath))) {
      return failure("conflict", `Artifact already exists: ${input.path}`, before);
    }

    await this.fileSystem.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    const tempPath = `${resolved.absolutePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await this.fileSystem.writeFile(tempPath, input.content, { encoding: "utf8", flag: "wx" });
      await this.fileSystem.rename(tempPath, resolved.absolutePath);
    } catch (error) {
      await this.fileSystem.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const after = await this.bus.execute("artifact.write.after", {
      ...middlewareContext(input, resolved.absolutePath),
      metadata: {
        projectRoot: path.resolve(input.projectRoot),
        path: normalizePath(input.path),
        absolutePath: resolved.absolutePath,
        bytesWritten: new TextEncoder().encode(input.content).length,
      },
    });

    return {
      ok: true,
      status: "written",
      path: normalizePath(input.path),
      absolutePath: resolved.absolutePath,
      bytesWritten: new TextEncoder().encode(input.content).length,
      middleware: { before, after },
    };
  }
}

type ResolvedPath =
  | { ok: true; absolutePath: string }
  | { ok: false; status: "path-rejected"; message: string };

function resolveArtifactPath(input: WriteArtifactInput): ResolvedPath {
  if (!input.projectRoot || !input.path) return { ok: false, status: "path-rejected", message: "projectRoot and path are required" };
  if (input.path.includes("\0")) {
    return { ok: false, status: "path-rejected", message: `Unsafe artifact path: ${input.path}` };
  }

  const projectRoot = path.resolve(input.projectRoot);
  const absolutePath = path.isAbsolute(input.path) ? path.resolve(input.path) : path.resolve(projectRoot, input.path);
  if (!isWithin(projectRoot, absolutePath)) {
    return { ok: false, status: "path-rejected", message: `Artifact path escapes project root: ${input.path}` };
  }

  return { ok: true, absolutePath };
}

function middlewareContext(input: WriteArtifactInput, absolutePath: string): Omit<MiddlewareContext, "event"> {
  return {
    runId: `artifact:${normalizePath(input.path)}`,
    subjectId: normalizePath(input.path),
    metadata: {
      projectRoot: path.resolve(input.projectRoot),
      path: normalizePath(input.path),
      absolutePath,
      overwrite: input.overwrite === true,
      artifactSizeBytes: new TextEncoder().encode(input.content).length,
    },
  };
}

function halted(status: "middleware-denied" | "requires-human", message: string, before: MiddlewareExecution): WriteArtifactResult {
  return { ok: false, status, error: { code: status, message }, middleware: { before } };
}

function failure(status: WriteArtifactStatus, message: string, before?: MiddlewareExecution): WriteArtifactResult {
  return { ok: false, status, error: { code: status, message }, middleware: { ...(before ? { before } : {}) } };
}

async function exists(fileSystem: ArtifactWriterFileSystem, filePath: string): Promise<boolean> {
  try {
    await fileSystem.access(filePath, constants.F_OK);
    return true;
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
