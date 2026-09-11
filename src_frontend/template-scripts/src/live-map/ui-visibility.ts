import { createMapUiVisibilityRuntime } from "../map/common/map-ui-visibility";

type Options = Parameters<typeof createMapUiVisibilityRuntime>[0];
type HideableControl = { getContainer?: () => HTMLElement | null };

export function createLiveMapUiVisibilityControl(
  leaflet: Options["leaflet"],
  controls: {
    tileServer?: HideableControl | null;
    members: HideableControl;
    tileOverlays?: HideableControl | null;
  },
) {
  const runtime = createMapUiVisibilityRuntime({ leaflet, initialHidden: false });
  for (const control of [controls.tileServer, controls.members, controls.tileOverlays]) {
    if (control) runtime.registerHideableMapControl(control);
  }
  return new runtime.MapUiVisibilityToggleControl();
}
