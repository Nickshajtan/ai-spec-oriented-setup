import type { PolicyMiddleware } from "../types.ts";

export function createBudgetPolicy(): PolicyMiddleware {
  return {
    id: "budget-policy",
    type: "policy",
    priority: 100,
    failureMode: "fail-closed",
    handler(context) {
      const maxCostUsd = context.budget?.maxCostUsd;
      const spentUsd = context.budget?.spentUsd;

      if (maxCostUsd !== undefined && spentUsd !== undefined && spentUsd >= maxCostUsd) {
        return { action: "deny", reason: "Budget exhausted" };
      }

      return { action: "continue" };
    },
  };
}
