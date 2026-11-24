import type { AnswerColoring } from "../map/answer-coloring";

export interface ManualConditionReplacement {
  coloring: AnswerColoring | null;
  apply(): void;
  restore(): void;
  finish(): void;
}

export function intersectTargetMasks(
  first: ReadonlySet<string> | null,
  second: ReadonlySet<string> | null,
): Set<string> | null {
  if (!first) return second ? new Set(second) : null;
  return new Set([...first].filter((key) => !second || second.has(key)));
}
