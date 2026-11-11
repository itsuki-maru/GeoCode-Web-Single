import { build } from "vite";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const project = resolve(directory, "../..");
export const outputDirectory = resolve(project, "../../target/vector-basemap-poc/site");

export async function buildPrototype() {
  await build({
    configFile: false,
    root: directory,
    publicDir: false,
    resolve: { alias: [{ find: /^leaflet$/, replacement: resolve(directory, "global-leaflet.ts") }] },
    build: { outDir: outputDirectory, emptyOutDir: true, target: "es2022" },
  });
  const vendor = resolve(outputDirectory, "vendor");
  await mkdir(vendor, { recursive: true });
  const files = [
    ["leaflet/dist/leaflet.js", "leaflet.js"],
    ["leaflet/dist/leaflet.css", "leaflet.css"],
    ["leaflet/dist/images", "images"],
    ["leaflet.markercluster/dist/leaflet.markercluster.js", "leaflet.markercluster.js"],
    ["leaflet.markercluster/dist/MarkerCluster.css", "MarkerCluster.css"],
    ["leaflet.markercluster/dist/MarkerCluster.Default.css", "MarkerCluster.Default.css"],
    ["marked/lib/marked.umd.js", "marked.js"],
    ["xss/dist/xss.js", "xss.js"],
  ];
  for (const [source, destination] of files)
    await cp(resolve(project, "node_modules", source), resolve(vendor, destination), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildPrototype();
