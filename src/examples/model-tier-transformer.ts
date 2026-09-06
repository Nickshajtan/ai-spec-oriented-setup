import type { TransformerMiddleware } from "../types.ts";

export function createModelTierTransformer(): TransformerMiddleware {
  return {
    id: "model-tier-transformer",
    type: "transformer",
    priority: 100,
    failureMode: "fail-closed",
    handler(context) {
      if (context.task?.type === "documentation") {
        return {
          action: "modify",
          patch: {
            routing: {
              modelTier: "cheap",
            },
          },
        };
      }

      return { action: "continue" };
    },
  };
}
