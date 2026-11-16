import { isAnswerColoring, type AnswerColoring } from "../map/answer-coloring";

/** 手動分類を保持し、AIが分類した対象だけAIの色を優先する。 */
export function mergeAiColoring(
  manual: AnswerColoring | null,
  ai: AnswerColoring | null,
): AnswerColoring | null {
  if (!ai) return manual;
  if (!manual) return ai;
  const result: AnswerColoring = { version: 1, rules: [], targets: {} };
  for (const [prefix, state] of [
    ["manual", manual],
    ["ai", ai],
  ] as const) {
    const ids = new Map(state.rules.map((rule, index) => [rule.id, `${prefix}-${index}`]));
    result.rules.push(...state.rules.map((rule) => ({ ...rule, id: ids.get(rule.id)! })));
    for (const [key, id] of Object.entries(state.targets)) result.targets[key] = ids.get(id)!;
  }
  if (!isAnswerColoring(result))
    throw Error("手動とAIの色分けは、合計20分類以内で使用してください。");
  return result;
}

export function intersectTargetMasks(
  first: ReadonlySet<string> | null,
  second: ReadonlySet<string> | null,
): Set<string> | null {
  if (!first) return second ? new Set(second) : null;
  return new Set([...first].filter((key) => !second || second.has(key)));
}
