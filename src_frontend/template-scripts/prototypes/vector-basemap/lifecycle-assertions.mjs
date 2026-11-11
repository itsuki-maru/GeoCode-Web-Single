import assert from "node:assert/strict";

/** 過去に作成した資源の数にかかわらず、処理完了時点の資源の所有状態を検証する。 */
export function assertStableLifecycle(state, { id, layers, workers }) {
  const vector = id === "2";
  assert.equal(state.selectedId, id, "The committed background must match the last selection");
  assert.deepEqual(state.checkedIds, [id], "Selection UI must match the committed background");
  assert.equal(state.pending, false, "A settled background must not retain a pending candidate");
  assert.equal(state.layerCount, layers, "Leaflet layer count must return to its settled baseline");
  assert.equal(state.bridgeCount, vector ? 1 : 0, "A removed background must not retain a bridge layer");
  assert.equal(state.canvasCount, vector ? 1 : 0, "A removed background must not retain a canvas");
  assert.equal(state.liveGLMaps, vector ? 1 : 0, "Every superseded MapLibre instance must be removed");
  assert.equal(state.connectedRemovedCanvases, 0, "Removed MapLibre canvases must leave the DOM");
  assert.equal(state.unreleasedRemovedContexts, 0, "Removed WebGL contexts must be released when supported");
  assert.equal(state.glMapsCreated, state.liveGLMaps + state.removedMaps, "Every created GL map must have one owner or a removal event");
  assert.equal(state.removalEvents, state.removedMaps, "Each removed GL map must emit removal exactly once");
  assert.equal(state.workers.live, workers, "Live Worker count must match the settled ownership");
  assert.equal(state.workers.created - state.workers.closed, state.workers.live, "Closed Workers must not count as live resources");
}
