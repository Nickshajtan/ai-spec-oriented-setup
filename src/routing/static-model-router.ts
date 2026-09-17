import { MiddlewareBus } from "../bus.ts";
import type { MiddlewareContext } from "../types.ts";
import type { SpecContext } from "../spec/types.ts";
import {
  MODEL_TIERS,
  type ModelRouter,
  type ModelTier,
  type MiddlewareRoutingResult,
  type RoutingAudit,
  type RoutingConfig,
  type RoutingDecision,
  type RoutingInput,
  type RoutingRule,
} from "./types.ts";

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  defaultTier: "coding-strong",
  rules: [
    { id: "task.documentation", taskType: "documentation", tier: "cheap" },
    { id: "task.small-fix", taskType: "small-fix", tier: "coding-fast" },
    { id: "task.bugfix", taskType: "bugfix", tier: "coding-fast" },
    { id: "task.feature", taskType: "feature", tier: "coding-strong" },
    { id: "task.refactor", taskType: "refactor", tier: "coding-strong" },
    { id: "task.architecture", taskType: "architecture", tier: "reasoning-strong" },
    { id: "task.design", taskType: "design", tier: "reasoning-strong" },
    { id: "task.review", taskType: "review", tier: "reviewer" },
  ],
};

export class RoutingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingValidationError";
  }
}

export class StaticModelRouter implements ModelRouter {
  private readonly config: RoutingConfig;
  private readonly rulesByTaskType: Map<string, RoutingRule>;

  constructor(config: RoutingConfig = DEFAULT_ROUTING_CONFIG) {
    validateConfig(config);
    this.config = cloneConfig(config);
    this.rulesByTaskType = new Map(this.config.rules.map((rule) => [rule.taskType, rule]));
  }

  route(input: RoutingInput): RoutingDecision {
    validateInput(input);

    const overrideTier = input.override?.modelTier;
    if (overrideTier !== undefined) {
      return {
        tier: overrideTier,
        source: "override",
        reason: `Explicit model tier override selected ${overrideTier}.`,
        signals: inputSignals(input),
      };
    }

    const taskType = input.task.type;
    const matchedRule = taskType ? this.rulesByTaskType.get(taskType) : undefined;
    const source = matchedRule ? "rule" : "default";
    const baseTier = matchedRule?.tier ?? this.config.defaultTier;
    const promotedTier = promoteForRisk(baseTier, input.task.risk);
    const signals = inputSignals(input);

    if (matchedRule) {
      return {
        tier: promotedTier,
        source,
        matchedRule: matchedRule.id,
        reason:
          promotedTier === baseTier
            ? `Task type '${taskType}' matched rule '${matchedRule.id}' and selected ${baseTier}.`
            : `Task type '${taskType}' matched rule '${matchedRule.id}'; high risk promoted ${baseTier} to ${promotedTier}.`,
        signals,
      };
    }

    return {
      tier: promotedTier,
      source,
      reason:
        promotedTier === baseTier
          ? `No task-type rule matched; using default tier ${baseTier}.`
          : `No task-type rule matched; high risk promoted default tier ${baseTier} to ${promotedTier}.`,
      signals,
    };
  }

  async routeWithMiddleware(input: RoutingInput, options: { bus?: MiddlewareBus } = {}): Promise<MiddlewareRoutingResult> {
    const bus = options.bus ?? new MiddlewareBus();
    const before = await bus.execute("model.route.before", routingMiddlewareContext(input));

    if (before.result.action === "deny") {
      return halted("middleware-denied", before.result.reason, before);
    }
    if (before.result.action === "require-human") {
      return halted("requires-human", before.result.reason, before);
    }

    const routedInput = routingInputFromMiddlewareContext(input, before.context);
    const decision = this.route(routedInput);
    const audit = routingAudit(routedInput, decision);

    const after = await bus.execute("model.route.after", {
      ...routingMiddlewareContext(routedInput),
      routing: { modelTier: decision.tier },
      metadata: {
        ...(routedInput.metadata ?? {}),
        routingDecision: decision,
        routingAudit: audit,
      },
    });

    if (after.result.action === "deny") {
      return {
        ok: false,
        status: "middleware-denied",
        decision,
        audit,
        error: { code: "middleware-denied", message: after.result.reason },
        middleware: { before, after },
      };
    }
    if (after.result.action === "require-human") {
      return {
        ok: false,
        status: "requires-human",
        decision,
        audit,
        error: { code: "requires-human", message: after.result.reason },
        middleware: { before, after },
      };
    }

    return {
      ok: true,
      status: "routed",
      decision,
      audit,
      middleware: { before, after },
    };
  }
}

export function routingInputFromSpecContext(spec: SpecContext, taskType?: string): RoutingInput {
  return {
    task: {
      type: taskType ?? taskTypeFromSpecMetadata(spec),
    },
    spec: {
      changeName: spec.changeName,
      metadata: {
        goal: spec.metadata?.goal,
        affectedAreas: spec.metadata?.affectedAreas,
        skipSpecs: spec.metadata?.skipSpecs,
      },
    },
    metadata: {
      system: spec.system,
    },
  };
}

function taskTypeFromSpecMetadata(spec: SpecContext): string | undefined {
  if (spec.metadata?.skipSpecs === true && spec.metadata.affectedAreas?.includes("docs")) {
    return "documentation";
  }

  return undefined;
}

function validateConfig(config: RoutingConfig): void {
  assertModelTier(config.defaultTier, "defaultTier");

  const ids = new Set<string>();
  const taskTypes = new Set<string>();
  for (const rule of config.rules) {
    if (!rule.id) throw new RoutingValidationError("Routing rule id is required.");
    if (!rule.taskType) throw new RoutingValidationError(`Routing rule '${rule.id}' taskType is required.`);
    assertModelTier(rule.tier, `rule '${rule.id}' tier`);

    if (ids.has(rule.id)) throw new RoutingValidationError(`Duplicate routing rule id: ${rule.id}`);
    if (taskTypes.has(rule.taskType)) throw new RoutingValidationError(`Duplicate routing task type: ${rule.taskType}`);

    ids.add(rule.id);
    taskTypes.add(rule.taskType);
  }
}

function validateInput(input: RoutingInput): void {
  const overrideTier = input.override?.modelTier;
  if (overrideTier !== undefined) {
    assertModelTier(overrideTier, "override.modelTier");
  }
}

function assertModelTier(value: unknown, label: string): asserts value is ModelTier {
  if (typeof value !== "string" || !MODEL_TIERS.includes(value as ModelTier)) {
    throw new RoutingValidationError(`Invalid ${label}: ${String(value)}`);
  }
}

function promoteForRisk(tier: ModelTier, risk?: string): ModelTier {
  if (risk !== "high") return tier;
  if (tier === "cheap" || tier === "coding-fast") return "coding-strong";
  if (tier === "coding-strong") return "reasoning-strong";
  return tier;
}

function routingMiddlewareContext(input: RoutingInput): Omit<MiddlewareContext, "event"> {
  return {
    runId: String(input.metadata?.runId ?? `route:${input.spec?.changeName ?? input.task.type ?? "unknown"}`),
    taskId: input.spec?.changeName ?? String(input.metadata?.taskId ?? input.task.type ?? "routing"),
    task: input.task,
    routing: input.override?.modelTier ? { modelTier: input.override.modelTier } : undefined,
    metadata: input.metadata ?? {},
  };
}

function routingInputFromMiddlewareContext(original: RoutingInput, context: MiddlewareContext): RoutingInput {
  return {
    ...original,
    task: {
      ...original.task,
      ...context.task,
    },
    override: context.routing?.modelTier ? { modelTier: context.routing.modelTier as ModelTier } : original.override,
    metadata: context.metadata,
  };
}

function routingAudit(input: RoutingInput, decision: RoutingDecision): RoutingAudit {
  return {
    inputSummary: {
      taskType: input.task.type,
      risk: input.task.risk,
      changeName: input.spec?.changeName,
      overrideTier: input.override?.modelTier,
    },
    selectedTier: decision.tier,
    matchedRule: decision.matchedRule,
    decisionSource: decision.source,
    reason: decision.reason,
  };
}

function inputSignals(input: RoutingInput): string[] {
  const signals: string[] = [];
  if (input.task.type) signals.push(`task.type=${input.task.type}`);
  if (input.task.risk) signals.push(`task.risk=${input.task.risk}`);
  if (input.spec?.changeName) signals.push(`spec.changeName=${input.spec.changeName}`);
  if (input.spec?.metadata?.skipSpecs !== undefined) signals.push(`spec.metadata.skipSpecs=${input.spec.metadata.skipSpecs}`);
  if (input.spec?.metadata?.affectedAreas?.length) {
    signals.push(`spec.metadata.affectedAreas=${input.spec.metadata.affectedAreas.join(",")}`);
  }
  return signals;
}

function cloneConfig(config: RoutingConfig): RoutingConfig {
  return structuredClone(config);
}

function halted(
  status: "middleware-denied" | "requires-human",
  message: string,
  before: MiddlewareRoutingResult["middleware"]["before"],
): MiddlewareRoutingResult {
  return {
    ok: false,
    status,
    error: { code: status, message },
    middleware: { before },
  };
}
