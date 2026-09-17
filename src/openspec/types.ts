import type { MiddlewareExecution } from "../middleware/types.ts";

export interface OpenSpecChangeInput {
  projectRoot: string;
  changeName: string;
}

export interface OpenSpecCreateChangeInput {
  projectRoot: string;
  changeName: string;
  title?: string;
}

export interface OpenSpecArtifactRef {
  kind: string;
  path: string;
  absolutePath: string;
}

export interface OpenSpecMetadata {
  raw?: string;
  known?: {
    schema?: string;
    created?: string;
    goal?: string;
    affectedAreas?: string[];
    skipSpecs?: boolean;
  };
}

export interface SpecContext {
  system: "openspec";
  changeName: string;
  projectRoot: string;
  openspec: {
    metadata?: OpenSpecMetadata;
    artifacts: {
      proposal?: OpenSpecArtifactRef;
      design?: OpenSpecArtifactRef;
      tasks?: OpenSpecArtifactRef;
      metadata?: OpenSpecArtifactRef;
      specs: OpenSpecArtifactRef[];
      other: OpenSpecArtifactRef[];
    };
    validation?: OpenSpecValidation;
    status?: unknown;
    instructions?: unknown;
  };
  interview?: Record<string, unknown>;
  review?: Record<string, unknown>;
}

export interface OpenSpecValidation {
  valid: boolean;
  exitCode: number;
  output?: unknown;
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
