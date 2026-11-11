declare global {
  interface Window {
    __GEOCODE_TILE_PROXY_REVISION__?: string | null;
  }
}

const tilePath = "/tile/{z}/{x}/{y}.png";
const revisionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function isOwnTilePath(path: string): boolean {
  if (path === tilePath) return true;
  if (!path.endsWith(tilePath)) return false;
  const authority = path.slice(0, -tilePath.length);
  if (!/^https?:\/\/[^/?#\\]+$/i.test(authority)) return false;
  try {
    const url = new URL(authority);
    return url.origin === window.location.origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Leafletが実際に要求するURLにだけ、現在のプロキシ設定の版を付ける。 */
export function tileProxyRenderUrl(template: string): string {
  const revision = window.__GEOCODE_TILE_PROXY_REVISION__;
  if (typeof revision !== "string" || !revisionPattern.test(revision)) return template;

  const hashIndex = template.indexOf("#");
  const fragment = hashIndex < 0 ? "" : template.slice(hashIndex);
  const resource = hashIndex < 0 ? template : template.slice(0, hashIndex);
  const queryIndex = resource.indexOf("?");
  const path = queryIndex < 0 ? resource : resource.slice(0, queryIndex);
  if (!isOwnTilePath(path)) return template;

  // 他のクエリパラメーターの表記とLeafletのプレースホルダーをそのまま保持する。
  const query = queryIndex < 0 ? [] : resource.slice(queryIndex + 1).split("&");
  const params = query.filter((part) => part !== "" && !new URLSearchParams(part).has("v"));
  params.push(`v=${revision}`);
  return `${path}?${params.join("&")}${fragment}`;
}
