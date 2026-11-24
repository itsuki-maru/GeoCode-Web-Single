import type { AttributeTransport } from "./advanced-map-search";
import { LocalPresetData, type PresetTarget } from "./local-preset";

/** 絞り込み後の表示リストとは独立して、読み込み済みの地物を保持する。 */
export function createOrdinaryPresetData(
  transport: AttributeTransport,
  getKey: () => string,
  getLayers: () => string[] | null,
  getTargets: () => PresetTarget[],
) {
  let key: string;
  let data: LocalPresetData | undefined;
  return () => {
    const next = getKey();
    if (!data || next !== key) {
      data = new LocalPresetData(transport, { layer_ids: getLayers() }, getTargets());
      key = next;
    }
    return data;
  };
}
