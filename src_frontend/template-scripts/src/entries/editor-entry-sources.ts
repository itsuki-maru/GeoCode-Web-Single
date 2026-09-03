export const editorCommonSources = [
  "src/map/editor/map-editor-mode.ts",
] as const;

export const editorEntrySources = {
  map: [
    ...editorCommonSources,
    "src/map/editor/map-editor-base.ts",
    "src/map/editor/map-editor-shape-filter.ts",
    "src/map/editor/map-editor-shape-state.ts",
    "src/map/editor/map-editor-shape-measurement.ts",
    "src/map/editor/map-editor-shape-metadata.ts",
    "src/map/editor/map-editor-shape-delete.ts",
    "src/map/editor/map-editor-shape-geometry.ts",
    "src/map/editor/map-editor-shape-drawing.ts",
    "src/map/editor/map-editor-controls.ts",
    "src/map/editor/map-editor-final.ts",
  ],
  "map-mobile": [
    ...editorCommonSources,
    "src/map/editor/map-editor-mobile-base.ts",
    "src/map/editor/map-editor-shape-state.ts",
    "src/map/editor/map-editor-shape-measurement.ts",
    "src/map/editor/map-editor-shape-metadata.ts",
    "src/map/editor/map-editor-shape-delete.ts",
    "src/map/editor/map-editor-shape-geometry.ts",
    "src/map/editor/map-editor-shape-drawing.ts",
    "src/map/editor/map-editor-controls.ts",
    "src/map/editor/map-editor-final.ts",
  ],
} as const;

export type EditorEntryName = keyof typeof editorEntrySources;
