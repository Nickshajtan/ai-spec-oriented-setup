import type { MiddlewareExecution } from "../middleware/types.ts";

export interface OpenSpecChangeInput {
  projectRoot: string;
  changeName: string;
}

export interface OpenSpecCreateChangeInput {
  projectRoot: string;
  changeName: string;
  description?: string;
  goal?: string;
  schema?: string;
}

export interface OpenSpecArtifact {
  id: string;
  path: string;
  status?: string;
  dependencies?: string[];
  instructions?: unknown;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface OpenSpecCommandResult<TNormalized> {
  normalized: TNormalized;
  raw?: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface OpenSpecStatus {
  artifacts: OpenSpecArtifact[];
  metadata: Record<string, unknown>;
}

export interface OpenSpecInstructions {
  artifacts: OpenSpecArtifact[];
  metadata: Record<string, unknown>;
}

export interface SpecContext {
  system: "openspec";
  changeName: string;
  projectRoot: string;
  openspec: {
    artifacts: OpenSpecArtifact[];
    metadata?: Record<string, unknown>;
    create?: OpenSpecCommandResult<Record<string, unknown>>;
    validation?: OpenSpecValidation;
    status?: OpenSpecCommandResult<OpenSpecStatus>;
    instructions?: OpenSpecCommandResult<OpenSpecInstructions>;
  };
  interview?: Record<string, unknown>;
  review?: Record<string, unknown>;
}

export interface OpenSpecValidation {
  valid: boolean;
  exitCode: number;
  raw?: unknown;
  stdout: string;
  stderr: string;
}

export type OpenSpecGatewayStatus =
  | "created"
  | "valid"
  | "invalid"
  | "status-read"
  | "instructions-read"
  | "missing-change"
  | "project-not-initialized"
  | "cli-unavailable"
  | "command-failed"
  | "middleware-denied"
  | "requires-human"
  | "path-rejected";

export interface OpenSpecGatewayError {
  code: OpenSpecGatewayStatus;
  message: string;
  cause?: unknown;
}

export interface OpenSpecGatewayResult<TContext = SpecContext> {
  ok: boolean;
  status: OpenSpecGatewayStatus;
  context?: TContext;
  error?: OpenSpecGatewayError;
  middleware: {
    before?: MiddlewareExecution;
    after?: MiddlewareExecution;
  };
}

export interface OpenSpecGateway {
  createChange(input: OpenSpecCreateChangeInput): Promise<OpenSpecGatewayResult>;
  getStatus(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult>;
  getInstructions(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult>;
  validate(input: OpenSpecChangeInput): Promise<OpenSpecGatewayResult>;
}
