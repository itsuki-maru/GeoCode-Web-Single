# Third Party Notices

GeoCode-Web-Single includes or depends on third-party software and assets.
The application code in this repository is licensed under the MIT License, but third-party components remain under their respective licenses.

This file is a practical notice list for OSS publication and binary distribution. It is not a complete legal opinion. Before each release, review bundled files and generated artifacts again.

## Bundled Frontend Libraries

The following files are bundled under `src_frontend/*/public` and/or copied into release assets.

| Component | Files / usage | License notes |
| --- | --- | --- |
| Leaflet | `leaflet.js`, `leaflet.css`, marker images | BSD-2-Clause |
| Leaflet.markercluster | `leaflet.markercluster.js`, `MarkerCluster*.css` | MIT |
| Leaflet.AwesomeMarkers | `leaflet.awesome-markers.js`, `leaflet.awesome-markers.css` | MIT |
| Bootstrap | `bootstrap.bundle.min.js`, `bootstrap.min.css`, `bootstrap3.0.0.min.css` | MIT |
| jQuery | `jquery-1.12.4.min.js` | MIT |
| marked | `marked.min.js` and npm dependency | MIT |
| xss / js-xss | `xss.min.js` and npm dependency | MIT |
| qrcode.js | `qrcode.min.js` | MIT-style license. Keep source attribution and license text available because the minified file does not include a full notice header. |
| Panzoom | `panzoom.min.js` | MIT |
| Font Awesome Free | `all.min.css` and referenced icon/font assets if distributed | Icons: CC BY 4.0; Fonts: SIL OFL 1.1; Code: MIT |
| GitHub Markdown CSS or derived GitHub-style CSS | `github.css` | Verify the exact source and license before release. |

## Frontend npm Dependencies

The Vue frontends depend on packages such as Vue, Vue Router, Pinia, Axios, Vite, TypeScript, ESLint, Prettier, marked, xss, and related build tooling.

The dependency tree is mostly permissive licenses such as MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, and Python-2.0. `caniuse-lite` is listed as CC-BY-4.0 in the local dependency metadata. Development dependencies are not normally bundled into the application, but notices should be regenerated or reviewed if build outputs start embedding additional code.

## Rust Dependencies

The Rust application depends on crates such as Axum, Tokio, Serde, SQLx, Tauri, Tera, image, reqwest, tracing, and related transitive dependencies.

The dependency tree is mostly permissive licenses such as MIT, Apache-2.0, BSD, ISC, Zlib, Unlicense, and 0BSD. The local dependency metadata also includes some MPL-2.0 crates and crates with explicit license files, including `ring`. These licenses do not change the license of the application code, but their notices and license texts must be respected when distributing binaries.

### Local OSM Tile Generation

The integrated tile generator uses the following additional direct dependencies. Versions and license expressions below were checked against the resolved `Cargo.lock` and local crate manifests on 2026-11-12.

| Component | Resolved version | License expression |
| --- | --- | --- |
| rusqlite | 0.32.1 | MIT |
| tiny-skia | 0.12.0 | BSD-3-Clause |
| libm | 0.2.16 | MIT |
| osmpbfreader | 0.19.1 | WTFPL |
| protobuf | 3.7.2 | MIT |
| flate2 | 1.1.9 | MIT OR Apache-2.0 |
| fs2 | 0.4.3 | MIT/Apache-2.0 |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |

`rusqlite` and SQLx share `libsqlite3-sys` 0.30.1 (crate license: MIT). The bundled SQLite engine uses the [SQLite public-domain dedication](https://www.sqlite.org/copyright.html); preserve the accompanying upstream files when preparing notices. Transitive dependencies retain their own licenses.

Map data is separate from the renderer's software licenses. OpenStreetMap data uses the [Open Data Commons Open Database License (ODbL)](https://www.openstreetmap.org/copyright). Display the dataset attribution, including “© OpenStreetMap contributors” where applicable, and observe the applicable data-license requirements when redistributing databases or rendered maps. The application carries the dataset attribution into local backgrounds; importing a local file does not grant additional rights to its contents.

## Images, Icons, Screenshots, and Sample Data

This repository contains application icons, public UI icons, screenshots, user guide images, and sample data under directories such as:

- `icons/`
- `res/`
- `hosting-assets/`
- `userguide/`
- `src_frontend/*/public/`

Before publishing or cutting a release, confirm that each non-code asset is either original, generated for this project, or available under a license compatible with redistribution. If an asset comes from an external source, add its name, source URL, copyright holder, and license to this file.

Many `*_24.png` UI icons appear to be externally sourced or derived icon assets. Their exact source should be verified before public release. If they are Google Material Icons or Material Symbols, include the Apache-2.0 notice for those assets.

## Release Checklist

Before publishing source or binaries:

- Confirm that `.env`, SQLite databases, local configuration, test credentials, and personal data are not included.
- Confirm that screenshots and user guide images do not disclose private data.
- Confirm that bundled minified files retain required notices, or that this file includes equivalent attribution.
- Include this file and the root `LICENSE` in source archives and binary distributions when practical.
- Re-run dependency license review after adding or upgrading dependencies.
