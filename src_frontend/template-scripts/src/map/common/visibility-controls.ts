export type MapControlPosition =
  | "bottomleft"
  | "bottomright"
  | "topleft"
  | "topright";

export interface LeafletActionControl {
  getContainer?: () => HTMLElement | null;
  onAdd(): HTMLElement;
}

interface LeafletNamespace {
  Control: {
    extend(definition: {
      options: { position: MapControlPosition };
      onAdd(): HTMLElement;
    }): new () => LeafletActionControl;
  };
  DomEvent: {
    disableClickPropagation(element: HTMLElement): void;
    on(
      element: HTMLElement,
      eventName: string,
      handler: (event: Event) => void,
    ): void;
    stop(event: Event): void;
  };
  DomUtil: {
    create(
      tagName: string,
      className: string,
      container?: HTMLElement,
    ): HTMLElement;
  };
}

interface TooltipVisibilityControlOptions {
  leaflet: LeafletNamespace;
  onToggle: () => void;
  position: MapControlPosition;
}

interface MeasurementVisibilityControlOptions {
  leaflet: LeafletNamespace;
  onMergeToggle: () => void;
  onToggle: () => void;
  onUpdateState: () => void;
  position: MapControlPosition;
}

export function createTooltipVisibilityControl({
  leaflet,
  onToggle,
  position,
}: TooltipVisibilityControlOptions): LeafletActionControl {
  const TooltipVisibilityControl = leaflet.Control.extend({
    options: { position },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control",
      );
      const button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      );
      button.innerHTML = "マーカー名表示";

      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        onToggle();
      });
      leaflet.DomEvent.disableClickPropagation(container);
      return container;
    },
  });

  return new TooltipVisibilityControl();
}

export function createMeasurementVisibilityControl({
  leaflet,
  onMergeToggle,
  onToggle,
  onUpdateState,
  position,
}: MeasurementVisibilityControlOptions): LeafletActionControl {
  const MeasurementVisibilityControl = leaflet.Control.extend({
    options: { position },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control measurement-control",
      );
      const button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      );
      button.innerHTML = "図形の計測";
      const mergeButton = leaflet.DomUtil.create(
        "button",
        "custom-control-button is-hidden",
        container,
      ) as HTMLButtonElement;
      mergeButton.id = "measurement-merge-toggle-btn";
      mergeButton.type = "button";
      mergeButton.innerHTML = "辺を結合";
      mergeButton.setAttribute("aria-pressed", "false");

      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        onToggle();
      });
      leaflet.DomEvent.on(mergeButton, "click", (event) => {
        leaflet.DomEvent.stop(event);
        onMergeToggle();
      });
      leaflet.DomEvent.disableClickPropagation(container);
      onUpdateState();
      return container;
    },
  });

  return new MeasurementVisibilityControl();
}
