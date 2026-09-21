import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpecReview, SpecificationWorkflowState, SpecificationWorkflowStatus } from "../specification/types.ts";

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
    if (session.sessionId !== sessionId) {
      throw runtimeStoreError("session-corrupt", "Runtime session id does not match the requested session.");
    }
    return session;
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

const WORKFLOW_STATUSES = new Set<SpecificationWorkflowStatus>([
  "interview",
  "generating",
  "validating",
  "reviewing",
  "needs-input",
  "needs-revision",
  "ready",
  "failed",
]);

function normalizePersistedSession(value: unknown): PersistedRuntimeSession {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session state must be an object.");
  if (value.version !== STORE_VERSION) {
    throw runtimeStoreError("session-version-unsupported", `Unsupported runtime session version: ${String(value.version)}`);
  }
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    throw runtimeStoreError("session-corrupt", "Runtime session state is missing sessionId.");
  }
  if (typeof value.createdAt !== "string" || !value.createdAt) {
    throw runtimeStoreError("session-corrupt", "Runtime session state is missing createdAt.");
  }
  if (typeof value.updatedAt !== "string" || !value.updatedAt) {
    throw runtimeStoreError("session-corrupt", "Runtime session state is missing updatedAt.");
  }
  validateWorkflowState(value.state, value.sessionId);
  return value as PersistedRuntimeSession;
}

function validateWorkflowState(value: unknown, sessionId: string): asserts value is SpecificationWorkflowState {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session state is missing workflow state.");
  requireString(value.projectRoot, "workflow projectRoot");
  requireString(value.changeName, "workflow changeName");
  if (typeof value.status !== "string" || !WORKFLOW_STATUSES.has(value.status as SpecificationWorkflowStatus)) {
    throw runtimeStoreError("session-corrupt", "Runtime session workflow status is invalid.");
  }
  validateInterview(value.interview, sessionId, value.projectRoot, value.changeName);
  validateGeneration(value.generation);
  validateValidation(value.validation);
  validateReview(value.review);
  if (value.failure !== undefined) validateFailure(value.failure);
}

function validateInterview(value: unknown, sessionId: string, projectRoot: unknown, changeName: unknown): void {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session interview state is missing.");
  if (value.id !== sessionId) {
    throw runtimeStoreError("session-corrupt", "Runtime session workflow state is missing matching interview state.");
  }
  if (value.projectRoot !== projectRoot || value.changeName !== changeName) {
    throw runtimeStoreError("session-corrupt", "Runtime session interview state does not match workflow state.");
  }
  requireString(value.roughIdea, "interview roughIdea");
  requireNumber(value.turnCount, "interview turnCount");
  if (!isObject(value.openspec) || !isObject(value.openspec.gatewayResults)) {
    throw runtimeStoreError("session-corrupt", "Runtime session interview OpenSpec context is invalid.");
  }
  for (const field of ["facts", "assumptions", "choices", "questions", "unresolvedQuestions", "gaps", "contradictions"]) {
    if (!Array.isArray(value[field])) {
      throw runtimeStoreError("session-corrupt", `Runtime session interview ${field} must be an array.`);
    }
  }
  if (!isObject(value.readiness) || typeof value.readiness.ready !== "boolean") {
    throw runtimeStoreError("session-corrupt", "Runtime session interview readiness is invalid.");
  }
  requireString(value.readiness.reason, "interview readiness reason");
  if (!Array.isArray(value.readiness.blockingGaps) || !Array.isArray(value.readiness.unresolvedContradictions)) {
    throw runtimeStoreError("session-corrupt", "Runtime session interview readiness lists are invalid.");
  }
}

function validateGeneration(value: unknown): void {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session generation state is missing.");
  requireNumber(value.attempts, "generation attempts");
  if (!Array.isArray(value.artifacts)) {
    throw runtimeStoreError("session-corrupt", "Runtime session generation artifacts must be an array.");
  }
  for (const artifact of value.artifacts) {
    if (!isObject(artifact)) throw runtimeStoreError("session-corrupt", "Runtime session generated artifact is invalid.");
    requireString(artifact.artifactId, "generated artifact id");
    requireString(artifact.path, "generated artifact path");
    requireString(artifact.content, "generated artifact content");
  }
  if (value.lastArtifactId !== undefined) requireString(value.lastArtifactId, "generation lastArtifactId");
}

function validateValidation(value: unknown): void {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session validation state is missing.");
  requireNumber(value.repairAttempts, "validation repairAttempts");
  if (value.latest !== undefined) validateOpenSpecValidation(value.latest);
}

function validateOpenSpecValidation(value: unknown): void {
  if (!isObject(value) || typeof value.valid !== "boolean") {
    throw runtimeStoreError("session-corrupt", "Runtime session validation result is invalid.");
  }
  requireNumber(value.exitCode, "validation exitCode");
  if (!Array.isArray(value.findings)) throw runtimeStoreError("session-corrupt", "Runtime session validation findings are invalid.");
  requireText(value.stdout, "validation stdout");
  requireText(value.stderr, "validation stderr");
}

function validateReview(value: unknown): void {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session review state is missing.");
  if (!Array.isArray(value.attempts)) throw runtimeStoreError("session-corrupt", "Runtime session review attempts are invalid.");
  for (const attempt of value.attempts) validateSpecReview(attempt);
  if (value.latest !== undefined) validateSpecReview(value.latest);
}

function validateSpecReview(value: unknown): asserts value is SpecReview {
  if (!isObject(value) || !["pass", "needs_revision", "needs_input"].includes(String(value.verdict))) {
    throw runtimeStoreError("session-corrupt", "Runtime session review result is invalid.");
  }
  if (!Array.isArray(value.findings)) throw runtimeStoreError("session-corrupt", "Runtime session review findings are invalid.");
  for (const finding of value.findings) {
    if (!isObject(finding)) throw runtimeStoreError("session-corrupt", "Runtime session review finding is invalid.");
    requireString(finding.id, "review finding id");
    if (finding.severity !== "error" && finding.severity !== "warning") {
      throw runtimeStoreError("session-corrupt", "Runtime session review finding severity is invalid.");
    }
    requireString(finding.issue, "review finding issue");
    requireString(finding.reason, "review finding reason");
  }
}

function validateFailure(value: unknown): void {
  if (!isObject(value)) throw runtimeStoreError("session-corrupt", "Runtime session failure is invalid.");
  requireString(value.code, "failure code");
  requireString(value.message, "failure message");
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

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || !value) {
    throw runtimeStoreError("session-corrupt", `Runtime session ${label} is invalid.`);
  }
}

function requireText(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw runtimeStoreError("session-corrupt", `Runtime session ${label} is invalid.`);
  }
}

function requireNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw runtimeStoreError("session-corrupt", `Runtime session ${label} is invalid.`);
  }
}
