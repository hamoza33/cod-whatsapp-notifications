/**
 * Pure condition evaluator. Given a {@link ConditionNodeData} and a live
 * {@link FlowExecutionContext}, returns `true` / `false` so the engine
 * knows which output edge to follow.
 *
 * Semantics:
 *   - String operators are case-insensitive by default. Toggle with
 *     `caseSensitive: true`.
 *   - Numeric operators (`gt`, `gte`, `lt`, `lte`) coerce both sides via
 *     `parseFloat`. Returns false when either side isn't a finite number.
 *   - `in` / `not_in` split the operand on commas.
 *   - `exists` / `not_exists` ignore the operand.
 *   - `is_empty` / `is_not_empty` treat null, undefined, and empty
 *     strings as empty.
 */

import type { ConditionNodeData, FlowExecutionContext } from "./types";
import { resolveDataPoint } from "./data-points";

export function evaluateCondition(
  cond: ConditionNodeData,
  context: FlowExecutionContext
): boolean {
  const raw = resolveDataPoint(context, cond.field);
  const operand = cond.value ?? "";

  switch (cond.operator) {
    case "exists":
      return raw !== null && raw !== undefined;
    case "not_exists":
      return raw === null || raw === undefined;
    case "is_empty":
      return raw === null || raw === undefined || String(raw).trim() === "";
    case "is_not_empty":
      return raw !== null && raw !== undefined && String(raw).trim() !== "";
  }

  // For everything below we need a stringified value
  const valueStr = raw === null || raw === undefined ? "" : String(raw);
  const a = cond.caseSensitive ? valueStr : valueStr.toLowerCase();
  const b = cond.caseSensitive ? operand : operand.toLowerCase();

  switch (cond.operator) {
    case "equals":
      return a === b;
    case "not_equals":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    case "regex":
      try {
        const re = new RegExp(operand, cond.caseSensitive ? "" : "i");
        return re.test(valueStr);
      } catch {
        return false;
      }
    case "in": {
      const list = operand
        .split(",")
        .map((s) => (cond.caseSensitive ? s.trim() : s.trim().toLowerCase()))
        .filter(Boolean);
      return list.includes(a);
    }
    case "not_in": {
      const list = operand
        .split(",")
        .map((s) => (cond.caseSensitive ? s.trim() : s.trim().toLowerCase()))
        .filter(Boolean);
      return !list.includes(a);
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = parseFloat(valueStr);
      const right = parseFloat(operand);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      switch (cond.operator) {
        case "gt":
          return left > right;
        case "gte":
          return left >= right;
        case "lt":
          return left < right;
        case "lte":
          return left <= right;
      }
      return false;
    }
    default:
      return false;
  }
}
