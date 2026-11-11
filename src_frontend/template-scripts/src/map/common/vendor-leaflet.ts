// 必要時に読み込むMapLibreブリッジは、HTMLが読み込んだLeafletインスタンスを共有する。
const leaflet = (window as unknown as { L?: unknown }).L;
if (!leaflet) throw new Error("Leaflet is not loaded");
export default leaflet;
