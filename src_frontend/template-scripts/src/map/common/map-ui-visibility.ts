type LeafletControl = {
  getContainer?: () => HTMLElement | null;
};

interface LeafletNamespace {
  Control: {
    extend(definition: {
      options: { position: string };
      onAdd(): HTMLElement;
    }): new () => LeafletControl;
  };
  DomEvent: {
    disableClickPropagation(element: HTMLElement): void;
    disableScrollPropagation?: (element: HTMLElement) => void;
    on(element: HTMLElement, eventName: string, handler: (event: Event) => void): void;
    stop(event: Event): void;
  };
  DomUtil: {
    create(tagName: string, className: string, container?: HTMLElement): HTMLElement;
  };
}

interface MapUiVisibilityRuntimeOptions {
  initialHidden: boolean;
  leaflet: LeafletNamespace;
  hideButtonLabel?: string;
  togglePosition?: "topleft" | "bottomleft";
}

export function createMapUiVisibilityRuntime({
  initialHidden,
  leaflet,
  hideButtonLabel = "地図だけを表示",
  togglePosition = "bottomleft",
}: MapUiVisibilityRuntimeOptions) {
  const hideableContainers = new Set<HTMLElement>();
  let isHidden = initialHidden;
  let toggleButton: HTMLButtonElement | null = null;

  const updateToggleButton = (): void => {
    if (!toggleButton) return;

    const buttonText = isHidden ? "機能を表示" : hideButtonLabel;
    toggleButton.textContent = buttonText;
    toggleButton.setAttribute("aria-label", buttonText);
    toggleButton.setAttribute("aria-pressed", String(isHidden));
  };

  const setHidden = (hidden: boolean): void => {
    isHidden = hidden;
    hideableContainers.forEach((container) => {
      container.classList.toggle("is-hidden", isHidden);
    });
    updateToggleButton();
  };

  const registerHideableContainer = (container: HTMLElement | null | undefined): void => {
    if (!container) return;

    container.classList.add("temporary-map-hideable-ui");
    container.classList.toggle("is-hidden", isHidden);
    hideableContainers.add(container);
  };

  const registerHideableMapControl = <TControl extends LeafletControl>(
    control: TControl,
  ): TControl => {
    if (typeof control.getContainer === "function") {
      registerHideableContainer(control.getContainer());
    }
    return control;
  };

  const MapUiVisibilityToggleControl = leaflet.Control.extend({
    options: { position: togglePosition },
    onAdd() {
      const container = leaflet.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control map-ui-visibility-toggle-control",
      );
      const button = leaflet.DomUtil.create(
        "button",
        "custom-control-button",
        container,
      ) as HTMLButtonElement;
      button.type = "button";
      toggleButton = button;

      leaflet.DomEvent.on(button, "click", (event) => {
        leaflet.DomEvent.stop(event);
        setHidden(!isHidden);
      });
      leaflet.DomEvent.disableClickPropagation(container);
      leaflet.DomEvent.disableScrollPropagation?.(container);
      updateToggleButton();
      return container;
    },
  });

  return { MapUiVisibilityToggleControl, registerHideableMapControl };
}
