import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpecificationWorkflowState } from "../specification/types.ts";

const STORE_VERSION = 1;

export interface PersistedRuntimeSession {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  state: SpecificationWorkflowState;
}

export class RuntimeSessionStore {
  private readonly clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  async save(projectRoot: string, state: SpecificationWorkflowState): Promise<PersistedRuntimeSession> {
    const root = resolveProjectRoot(projectRoot);
    const sessionId = safeSessionId(state.interview.id);
    const sessionsRoot = path.join(root, ".ai-spec-core", "sessions");
    await mkdir(sessionsRoot, { recursive: true });

    const existing = await this.read(root, sessionId).catch(() => undefined);
    const now = this.clock().toISOString();
    const persisted: PersistedRuntimeSession = {
      version: STORE_VERSION,
      sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      state,
    };
    const destination = sessionPath(root, sessionId);
    const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temp, destination);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return persisted;
  }

  async load(projectRoot: string, sessionId: string): Promise<PersistedRuntimeSession> {
    const root = resolveProjectRoot(projectRoot);
    return this.read(root, safeSessionId(sessionId));
  }

  private async read(projectRoot: string, sessionId: string): Promise<PersistedRuntimeSession> {
    const filePath = sessionPath(projectRoot, sessionId);
    try {
      await access(filePath, constants.F_OK);
    } catch {
      throw runtimeStoreError("session-not-found", `Runtime session not found: ${sessionId}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw runtimeStoreError("session-corrupt", "Runtime session state is not valid JSON.", error);
    }

    const session = normalizePersistedSession(parsed);
    if (session.version !== STORE_VERSION) {
      throw runtimeStoreError("session-version-unsupported", `Unsupported runtime session version: ${String(session.version)}`);
    }
    if (session.sessionId !== sessionId) {
      throw runtimeStoreError("session-corrupt", "Runtime session id does not match the requested session.");
    }
    return session as PersistedRuntimeSession;
  }
}

export class RuntimeSessionStoreError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RuntimeSessionStoreError";
    this.code = code;
    this.details = details;
  }
}

function normalizePersistedSession(value: unknown): PersistedRuntimeSession | { version: unknown; sessionId: string } {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session state must be an object.");
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    throw runtimeStoreError("session-corrupt", "Runtime session state is missing sessionId.");
  }
  if (!isObject(value.state)) throw runtimeStoreError("session-corrupt", "Runtime session state is missing workflow state.");
  if (!isObject(value.state.interview) || value.state.interview.id !== value.sessionId) {
    throw runtimeStoreError("session-corrupt", "Runtime session workflow state is missing matching interview state.");
  }
  return value as PersistedRuntimeSession;
}

function sessionPath(projectRoot: string, sessionId: string): string {
  const sessionsRoot = path.join(projectRoot, ".ai-spec-core", "sessions");
  const filePath = path.resolve(sessionsRoot, `${sessionId}.json`);
  if (!isWithin(sessionsRoot, filePath)) {
    throw runtimeStoreError("session-path-rejected", `Runtime session path escapes store: ${sessionId}`);
  }
  return filePath;
}

function safeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) {
    throw runtimeStoreError("session-path-rejected", `Invalid runtime session id: ${sessionId}`);
  }
  return sessionId;
}

function resolveProjectRoot(projectRoot: string): string {
  if (!projectRoot || projectRoot.includes("\0")) {
    throw runtimeStoreError("project-path-rejected", "projectRoot is required and must be a safe path.");
  }
  return path.resolve(projectRoot);
}

function runtimeStoreError(code: string, message: string, details?: unknown): RuntimeSessionStoreError {
  return new RuntimeSessionStoreError(code, message, details);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
