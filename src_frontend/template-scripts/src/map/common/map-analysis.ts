import {
  createColorRuleRequest,
  type AnswerMapFilter,
  type AnswerColorSpecification,
  type AnswerColoring,
  type AnswerField,
} from "./answer-coloring";

export type AnalysisTransport = (
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
) => Promise<any>;
export const mapFilterPath = "/form-answers/map-filter";
export const mapOperationMessages = {
  filter: "絞り込みが完了しました。",
  coloring: "色分けが完了しました。",
} as const;
interface MapFilterResult {
  as_of: string;
  targets: string[];
  target_count: number;
  answer_count: number;
  forms: { id: string; label: string }[];
  fields: AnswerField[];
}

/** 共通の分類処理では先に一致した分類を優先し、全分類の処理が成功してから結果を確定する。 */
export async function classifyMapTargets(
  specification: AnswerColorSpecification,
  allowed: ReadonlySet<string> | null,
  evaluate: (rule: AnswerColorSpecification["rules"][number]) => Promise<string[]>,
): Promise<AnswerColoring> {
  const coloring: AnswerColoring = {
    version: 1,
    rules: specification.rules.map(({ id, label, color }) => ({ id, label, color })),
    targets: {},
  };
  for (const rule of specification.rules) {
    const keys = await evaluate(rule);
    if (
      !Array.isArray(keys) ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => typeof key !== "string" || !/^(marker|shape):[^:]+$/.test(key))
    )
      throw Error("色分けの対象情報が不正です。");
    for (const key of keys)
      if ((!allowed || allowed.has(key)) && coloring.targets[key] === undefined)
        coloring.targets[key] = rule.id;
  }
  return coloring;
}

export async function evaluateMapAnalysis(
  transport: AnalysisTransport,
  filter: AnswerMapFilter | null,
  specification: AnswerColorSpecification | null,
  layerIds: string[] | null,
  signal: AbortSignal,
  targets?: string[],
): Promise<MapFilterResult & { coloring: AnswerColoring | null }> {
  const scope = { kind: "layers", layer_ids: layerIds };
  const query: Record<string, unknown> = { mode: "latest" };
  const evaluate = async (body: Record<string, unknown>) => {
    const data = (await transport(
      mapFilterPath,
      { scope, targets, ...body },
      signal,
    )) as MapFilterResult;
    if (
      !data ||
      typeof data.as_of !== "string" ||
      !Array.isArray(data.targets) ||
      data.target_count !== data.targets.length ||
      new Set(data.targets).size !== data.targets.length ||
      data.targets.some(
        (key: unknown) => typeof key !== "string" || !/^(marker|shape):[^:]+$/.test(key),
      )
    )
      throw Error("検索結果を確認できませんでした。");
    query.as_of ??= data.as_of;
    if (query.as_of !== data.as_of) throw Error("検索基準日時が一致しません。");
    return data;
  };
  const result = await evaluate({
    query,
    common_form_id: filter?.common_form_id || specification?.common_form_id || null,
    conditions: filter?.conditions || [],
    options_only: !filter,
  });
  const coloring = specification
    ? await classifyMapTargets(
        specification,
        filter ? new Set<string>(result.targets) : null,
        async (rule) => {
          const body = createColorRuleRequest(
            query,
            filter || { common_form_id: null, conditions: [] },
            specification.common_form_id,
            rule,
          );
          const classified = await evaluate(body);
          return classified.targets;
        },
      )
    : null;
  return { ...result, coloring };
}
