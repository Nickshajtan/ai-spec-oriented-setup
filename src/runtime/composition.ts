import { MiddlewareBus } from "../bus.ts";
import { SPECIFIER_EVENT_NAMES } from "../events.ts";
import { NodeArtifactReader } from "../artifact-writer/node-artifact-reader.ts";
import { NodeArtifactWriter } from "../artifact-writer/node-artifact-writer.ts";
import { InterviewEngine } from "../interview/interview-engine.ts";
import { ModelQuestionPlanner } from "../interview/model-question-planner.ts";
import { createLimitWarnings, createLimitsGuard } from "../middleware/limits-guard.ts";
import { LiteLLMModelAdapter } from "../model/litellm-model-adapter.ts";
import type { ModelPort } from "../model/types.ts";
import { CliOpenSpecGateway } from "../openspec/openspec-gateway.ts";
import { ModelArtifactGenerator } from "../specification/model-artifact-generator.ts";
import { ModelSpecReviewer } from "../specification/model-spec-reviewer.ts";
import { SpecificationWorkflow } from "../specification/specification-workflow.ts";
import { CoreSpecifierRuntime } from "./specifier-runtime.ts";

export interface RuntimeCompositionConfig {
  model?: ModelPort;
  modelName?: string;
  liteLlmBaseUrl?: string;
  liteLlmApiKeyEnv?: string;
  liteLlmTimeoutMs?: number;
  openspecCommand?: string;
}

export function createSpecifierRuntime(config: RuntimeCompositionConfig = {}): CoreSpecifierRuntime {
  const bus = new MiddlewareBus();
  for (const eventName of SPECIFIER_EVENT_NAMES) {
    bus.use(eventName, createLimitsGuard({ maxInterviewTurns: 20, maxReviewIterations: 3 }));
    bus.use(eventName, createLimitWarnings({ contextSizeWarningBytes: 500_000, artifactSizeWarningBytes: 200_000 }));
  }

  const model = config.model ?? createModel(config);
  const modelName = config.modelName ?? process.env.AI_SPEC_MODEL ?? "specifier";
  const gateway = new CliOpenSpecGateway({ bus, openspecCommand: config.openspecCommand ?? process.env.OPENSPEC_COMMAND });
  const interviewEngine = new InterviewEngine(gateway, new ModelQuestionPlanner(model, { model: modelName }), { bus });

  const workflow = new SpecificationWorkflow(
    {
      interviewEngine,
      openSpecGateway: gateway,
      artifactGenerator: new ModelArtifactGenerator(model, { model: modelName }),
      artifactWriter: new NodeArtifactWriter({ bus }),
      artifactReader: new NodeArtifactReader(),
      reviewer: new ModelSpecReviewer(model, { model: modelName }),
    },
    { bus },
  );

  return new CoreSpecifierRuntime({ workflow });
}

function createModel(config: RuntimeCompositionConfig): ModelPort {
  const baseUrl = config.liteLlmBaseUrl ?? process.env.AI_SPEC_LITELLM_BASE_URL;
  if (!baseUrl) {
    throw new Error("AI_SPEC_LITELLM_BASE_URL is required for production runtime model configuration.");
  }

  return new LiteLLMModelAdapter({
    baseUrl,
    apiKeyEnv: config.liteLlmApiKeyEnv ?? process.env.AI_SPEC_LITELLM_API_KEY_ENV,
    timeoutMs: config.liteLlmTimeoutMs,
  });
}
