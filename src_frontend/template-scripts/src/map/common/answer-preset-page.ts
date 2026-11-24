import type { AiDefinition } from "../../ai/types";
import { answerMapPresetInputs } from "./answer-map-preset-inputs";
import type { SavedMapPreset } from "./answer-map-presets";
import { presetReferences } from "./local-preset";

export interface AnswerPresetPage<T> {
  job: AbortController;
  optionsJob: AbortController;
  items: SavedMapPreset[];
  options: Map<string, Promise<T>>;
  data: Promise<void>;
}

export function prepareAnswerPresetPage<T>(
  items: SavedMapPreset[],
  context: {
    requiredForm: unknown;
    retained: AiDefinition[];
    readOptions(id: string | null, signal: AbortSignal): Promise<T>;
    prepare(definitions: AiDefinition[], signal: AbortSignal): Promise<void>;
    ready(definitions: AiDefinition[]): boolean;
    onFailure(items: SavedMapPreset[]): void;
  },
): AnswerPresetPage<T> {
  const job = new AbortController();
  const optionsJob = new AbortController();
  const forms = new Map<string, SavedMapPreset[]>();
  const eligible: SavedMapPreset[] = [];
  for (const preset of items) {
    try {
      const draft = answerMapPresetInputs(preset);
      let formIds: Iterable<string>;
      if (draft.kind === "expression") formIds = presetReferences([preset.definition]).keys();
      else {
        const id = draft.definition.common_form_id;
        if (id && context.requiredForm && id !== context.requiredForm) continue;
        formIds = [id ?? ""];
      }
      eligible.push(preset);
      for (const id of formIds) {
        const previous = forms.get(id);
        if (previous) previous.push(preset);
        else forms.set(id, [preset]);
      }
    } catch {
      context.onFailure([preset]);
    }
  }

  // フォーム情報は同時に4件までとし、各行は自分が参照するフォームの完了だけを待つ。
  const lanes = Array.from({ length: 4 }, () => Promise.resolve());
  const options = new Map<string, Promise<T>>();
  let next = 0;
  for (const [id, dependents] of forms) {
    const lane = next++ % lanes.length;
    const read = lanes[lane]!.then(() => {
      optionsJob.signal.throwIfAborted();
      return context.readOptions(id || null, optionsJob.signal);
    });
    options.set(id, read);
    lanes[lane] = read.then(
      () => {},
      () => {
        if (!optionsJob.signal.aborted) context.onFailure(dependents);
      },
    );
  }
  const data = eligible.length
    ? context.prepare(
        [...eligible.map((preset) => preset.definition), ...context.retained],
        job.signal,
      )
    : Promise.resolve();
  void data.catch(() => {
    if (!job.signal.aborted)
      context.onFailure(
        eligible.filter((preset) => !context.ready([preset.definition, ...context.retained])),
      );
  });
  return { job, optionsJob, items, options, data };
}
