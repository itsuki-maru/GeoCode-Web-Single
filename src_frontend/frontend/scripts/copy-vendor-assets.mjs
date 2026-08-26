import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transformWithEsbuild } from "vite";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectDir, "dist");

const assets = [
  ["node_modules/leaflet/dist/leaflet.js", "leaflet.js"],
  ["node_modules/leaflet/dist/images/layers.png", "layers.png"],
  ["node_modules/leaflet/dist/images/layers-2x.png", "layers-2x.png"],
  ["node_modules/leaflet/dist/images/marker-icon.png", "marker-icon.png"],
  ["node_modules/leaflet/dist/images/marker-icon-2x.png", "marker-icon-2x.png"],
  ["node_modules/leaflet/dist/images/marker-shadow.png", "marker-shadow.png"],
  ["node_modules/leaflet.markercluster/dist/leaflet.markercluster.js", "leaflet.markercluster.js"],
  ["node_modules/leaflet.markercluster/dist/MarkerCluster.css", "MarkerCluster.css"],
  [
    "node_modules/leaflet.markercluster/dist/MarkerCluster.Default.css",
    "MarkerCluster.Default.css",
  ],
  ["node_modules/xss/dist/xss.min.js", "xss.min.js"],
  ["node_modules/@panzoom/panzoom/dist/panzoom.min.js", "panzoom.min.js"],
];

const stylesheets = [["node_modules/leaflet/dist/leaflet.css", "leaflet.css"]];

await mkdir(distDir, { recursive: true });

await Promise.all(
  assets.map(([source, destination]) =>
    copyFile(resolve(projectDir, source), resolve(distDir, destination)),
  ),
);

for (const [source, destination] of stylesheets) {
  const sourcePath = resolve(projectDir, source);
  const css = await readFile(sourcePath, "utf8");
  const rewrittenCss = css.replace(/url\((['"]?)images\/([^)'"\s]+)\1\)/g, "url(/assets/$2)");

  if (rewrittenCss === css) {
    throw new Error(`No image URLs were rewritten in ${sourcePath}`);
  }

  await writeFile(resolve(distDir, destination), rewrittenCss);
}

const markedSource = await readFile(
  resolve(projectDir, "node_modules/marked/lib/marked.umd.js"),
  "utf8",
);
const markedBundle = await transformWithEsbuild(markedSource, "marked.umd.js", {
  legalComments: "inline",
  minify: true,
  target: "es2020",
});
await writeFile(resolve(distDir, "marked.min.js"), markedBundle.code);

console.log("Copied npm-managed template vendor assets to dist.");
