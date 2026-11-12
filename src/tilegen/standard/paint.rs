//! 標準地図専用の面・交通・標高描画。道路形式1の描画処理とは独立させる。
//!
//! 画素内の固定16標本を世界座標で評価し、タイル境界や描画窓の大きさによって
//! 塗り・穴・線の被覆判定が変わらないようにする。

use anyhow::{Context, Result, ensure};
use tiny_skia::{Color, Pixmap};

use crate::tilegen::{
    geometry::{Point, Rect},
    identity::IdentityHasher,
    operation::OperationContext,
    render_spec::RenderSpec,
    store::{FeatureKey, Store},
    style::Style,
    tile::{TILE_SIZE, TileId},
};

use super::{
    carto_style,
    elevation::Sampler,
    model::{Feature, FeatureKind, Geometry},
};

pub const STYLE_VERSION: &str = "standard-terrain-v1";
const SAMPLES: usize = 4;
const COORDINATE_GRID: f64 = 4096.0;
const MAX_FEATURES: usize = 131_072;
const MAX_TOTAL_POINTS: usize = 2_000_000;
const MAX_CROSSINGS: usize = 4_000_000;
const MAX_WORK: usize = 80_000_000;
const LINE_CIRCLE_POINTS: usize = 32;
const QUERY_MARGIN: f64 = 12.0;
const EARTH_CIRCUMFERENCE: f64 = 40_075_016.685_578_49;
const SHADE_STRENGTH: f64 = 0.22;
const SHADE_MIN: f64 = 0.60;
const SHADE_MAX: f64 = 1.10;
const MAJOR_CONTOUR_WIDTH: f64 = 1.0;
const WATERWAY_WIDTH_GROWTH: f64 = 0.2;
const WATERWAY_GROWTH_START_ZOOM: u8 = 13;
const CONTOUR_DISPLAY: [(u8, i64); 3] = [(10, 500), (12, 100), (14, 20)];
const BACKGROUND: [u8; 4] = [242, 240, 232, 255];
const SEA: [u8; 4] = [181, 211, 226, 255];
const BUILDING_OUTLINE: [u8; 4] = [167, 153, 137, 255];
const TUNNEL: [u8; 4] = [211, 199, 184, 255];

#[derive(Clone, Copy)]
struct FeatureStyle {
    kind: FeatureKind,
    zoom: u8,
    color: [u8; 4],
    width: f32,
}

const FEATURE_STYLES: [FeatureStyle; 16] = [
    FeatureStyle {
        kind: FeatureKind::Land,
        zoom: 0,
        color: [245, 244, 237, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Forest,
        zoom: 6,
        color: [202, 222, 187, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Grass,
        zoom: 10,
        color: [218, 234, 197, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Park,
        zoom: 10,
        color: [207, 232, 199, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Farmland,
        zoom: 10,
        color: [232, 230, 201, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Residential,
        zoom: 10,
        color: [232, 225, 220, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Commercial,
        zoom: 10,
        color: [233, 216, 218, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Industrial,
        zoom: 10,
        color: [221, 218, 225, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Sand,
        zoom: 10,
        color: [241, 232, 198, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::BareRock,
        zoom: 10,
        color: [224, 222, 213, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Wetland,
        zoom: 10,
        color: [211, 229, 219, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Water,
        zoom: 6,
        color: [171, 211, 231, 255],
        width: 0.0,
    },
    FeatureStyle {
        kind: FeatureKind::Building,
        zoom: 14,
        color: [214, 203, 191, 255],
        width: 0.7,
    },
    FeatureStyle {
        kind: FeatureKind::Waterway,
        zoom: 11,
        color: [139, 192, 218, 255],
        width: 1.0,
    },
    FeatureStyle {
        kind: FeatureKind::Railway,
        zoom: 9,
        color: [123, 119, 115, 255],
        width: 1.0,
    },
    FeatureStyle {
        kind: FeatureKind::Contour,
        zoom: 10,
        color: [164, 136, 105, 255],
        width: 0.6,
    },
];

fn feature_style(kind: FeatureKind) -> FeatureStyle {
    *FEATURE_STYLES
        .iter()
        .find(|style| style.kind == kind)
        .expect("全地物に描画値を定義する")
}

/// 実描画と共通の設定値だけを識別する。演算規則は描画契約の版でも管理する。
pub fn style_hash() -> String {
    let mut hash = IdentityHasher::new("geocode-standard-style-v1");
    hash.text(STYLE_VERSION);
    hash.text(&Style::roads_v1().hash());
    for style in FEATURE_STYLES {
        hash.bytes(&(style.kind as i64).to_le_bytes());
        hash.u8(style.zoom);
        hash.bytes(&style.color);
        hash.f32(style.width);
    }
    for color in [BACKGROUND, SEA, BUILDING_OUTLINE, TUNNEL] {
        hash.bytes(&color);
    }
    hash.u32(SAMPLES as u32);
    hash.u32(LINE_CIRCLE_POINTS as u32);
    hash.u8(WATERWAY_GROWTH_START_ZOOM);
    for (zoom, interval) in CONTOUR_DISPLAY {
        hash.u8(zoom);
        hash.bytes(&interval.to_le_bytes());
    }
    for number in [
        COORDINATE_GRID,
        EARTH_CIRCUMFERENCE,
        SHADE_STRENGTH,
        SHADE_MIN,
        SHADE_MAX,
        MAJOR_CONTOUR_WIDTH,
        WATERWAY_WIDTH_GROWTH,
        QUERY_MARGIN,
    ] {
        hash.bytes(&number.to_le_bytes());
    }
    // 方位315度、高度45度の正規化した光源ベクトル。
    hash.bytes(&(-0.5_f64).to_le_bytes());
    hash.bytes(&(-0.5_f64).to_le_bytes());
    hash.bytes(&std::f64::consts::FRAC_1_SQRT_2.to_le_bytes());
    hash.finish()
}

pub fn render_tile(store: &Store, tile: TileId, context: &OperationContext) -> Result<Pixmap> {
    render_tile_with_metrics(store, tile, context).map(|(image, _, _)| image)
}

/// 新仕様が実際に使う共通描画値のみを識別する。
pub(crate) fn carto_parameters_hash(spec: &RenderSpec) -> String {
    let mut hash = IdentityHasher::new("geocode-osm-like-geometry-paint-v1");
    hash.u32(SAMPLES as u32);
    hash.u32(LINE_CIRCLE_POINTS as u32);
    hash.bytes(&COORDINATE_GRID.to_le_bytes());
    for style in FEATURE_STYLES {
        if (style.kind == FeatureKind::Building && !spec.buildings)
            || (style.kind == FeatureKind::Contour && !spec.contours)
        {
            continue;
        }
        hash.u8(style.zoom);
        hash.f32(style.width);
    }
    hash.u8(WATERWAY_GROWTH_START_ZOOM);
    hash.bytes(&WATERWAY_WIDTH_GROWTH.to_le_bytes());
    if spec.contours {
        for (zoom, interval) in CONTOUR_DISPLAY {
            hash.u8(zoom);
            hash.bytes(&interval.to_le_bytes());
        }
        hash.bytes(&MAJOR_CONTOUR_WIDTH.to_le_bytes());
    }
    if spec.hillshade {
        for number in [
            EARTH_CIRCUMFERENCE,
            SHADE_STRENGTH,
            SHADE_MIN,
            SHADE_MAX,
            -0.5,
            std::f64::consts::FRAC_1_SQRT_2,
        ] {
            hash.bytes(&number.to_le_bytes());
        }
    }
    hash.finish()
}

/// 候補数と、道路の各描画段階を含む実際の形状読込点数を同時に返す。
pub fn render_tile_with_metrics(
    store: &Store,
    tile: TileId,
    context: &OperationContext,
) -> Result<(Pixmap, u64, u64)> {
    render_window(store, tile, TILE_SIZE, TILE_SIZE, context, None)
}

/// 新しい描画仕様を使い、既存の標準地図の画素契約を変更せずに描画する。
pub fn render_tile_with_spec(
    store: &Store,
    tile: TileId,
    context: &OperationContext,
    spec: &RenderSpec,
) -> Result<(Pixmap, u64, u64)> {
    spec.validate()?;
    render_window(store, tile, TILE_SIZE, TILE_SIZE, context, Some(spec))
}

/// 4枚の出力を結合せず、同じ世界標本位置で512pxを直接描画する品質検証用。
pub fn render_quad(store: &Store, tile: TileId, context: &OperationContext) -> Result<Pixmap> {
    TileId::new(tile.z, tile.x + 1, tile.y + 1)?;
    render_window(store, tile, TILE_SIZE * 2, TILE_SIZE * 2, context, None)
        .map(|(image, _, _)| image)
}

/// タイル境界での地名と線の一致を検証するため、同じ仕様で大きな窓を描く。
pub fn render_quad_with_spec(
    store: &Store,
    tile: TileId,
    context: &OperationContext,
    spec: &RenderSpec,
) -> Result<Pixmap> {
    spec.validate()?;
    TileId::new(tile.z, tile.x + 1, tile.y + 1)?;
    render_window(
        store,
        tile,
        TILE_SIZE * 2,
        TILE_SIZE * 2,
        context,
        Some(spec),
    )
    .map(|(image, _, _)| image)
}

fn render_window(
    store: &Store,
    tile: TileId,
    width: u32,
    height: u32,
    context: &OperationContext,
    spec: Option<&RenderSpec>,
) -> Result<(Pixmap, u64, u64)> {
    context.check()?;
    TileId::new(tile.z, tile.x, tile.y)?;
    let window = Window::new(tile, width as usize, height as usize)?;
    let query = window.bounds().expand(QUERY_MARGIN / window.scale);
    let mut features = super::store::query_features(store.connection(), query, tile.z)?;
    if let Some(spec) = spec {
        features.retain(|feature| match feature.kind {
            FeatureKind::Building => spec.buildings,
            FeatureKind::Contour => spec.contours,
            _ => true,
        });
    }
    ensure!(
        features.len() <= MAX_FEATURES,
        "標準地図の地物候補数上限を超えました"
    );
    let mut total = 0_usize;
    for feature in &features {
        total = total
            .checked_add(point_count(&feature.geometry))
            .context("頂点数の加算が上限を超えました")?;
        ensure!(
            total <= MAX_TOTAL_POINTS,
            "標準地図の総頂点数上限を超えました"
        );
    }
    features.sort_unstable_by_key(|feature| {
        (
            phase(feature),
            feature.layer,
            feature.structure,
            feature.kind as i64,
            feature.osm_type,
            feature.osm_id,
            feature.role,
        )
    });
    let mut roads = if spec.is_some_and(|spec| !spec.roads) {
        Vec::new()
    } else {
        store.query_candidates(query, tile.z)?
    };
    roads.sort_unstable_by_key(|road| {
        (
            road.attributes.effective_layer,
            road.attributes.structure_rank,
            road.attributes.road_class.priority(),
            road.osm_way_id,
            road.feature_id,
        )
    });
    let details = super::store::details(store.connection())?;
    let landmask = details.as_ref().and_then(|details| {
        details
            .sources
            .iter()
            .find(|source| source.kind == "landmask")
    });
    let mut raster = Raster::new(
        window,
        if spec.is_some() {
            carto_style::BACKGROUND
        } else {
            BACKGROUND
        },
        context,
    )?;
    raster.carto = spec.is_some();
    if let Some(source) = landmask {
        let bounds: Rect = match source.details.get("coverage") {
            Some(value) => {
                serde_json::from_value(value.clone()).context("海陸処理範囲の形式が不正です")?
            },
            None => Rect {
                min_x: 0.0,
                max_x: 1.0,
                min_y: 0.0,
                max_y: 1.0,
            },
        };
        ensure!(
            bounds.min_x.is_finite()
                && bounds.max_x.is_finite()
                && bounds.min_y.is_finite()
                && bounds.max_y.is_finite()
                && bounds.min_x <= bounds.max_x
                && bounds.min_y <= bounds.max_y,
            "海陸処理範囲が不正です"
        );
        let ring = [
            Point {
                x: bounds.min_x,
                y: bounds.min_y,
            },
            Point {
                x: bounds.max_x,
                y: bounds.min_y,
            },
            Point {
                x: bounds.max_x,
                y: bounds.max_y,
            },
            Point {
                x: bounds.min_x,
                y: bounds.max_y,
            },
            Point {
                x: bounds.min_x,
                y: bounds.min_y,
            },
        ];
        let mask = raster.polygon_mask(&[&ring])?;
        raster.blend(
            &mask,
            if spec.is_some() {
                carto_style::SEA
            } else {
                SEA
            },
        )?;
        raster.landmask = Some(mask);
    }

    for feature in features.iter().filter(|feature| phase(feature) < 30) {
        raster.feature(feature, tile.z)?;
    }
    if spec.is_none_or(|spec| spec.hillshade) {
        raster.shade(store.connection(), query, tile.z)?;
    }
    raster.roads(store, &roads, tile.z, 0)?;
    for feature in features
        .iter()
        .filter(|feature| (30..50).contains(&phase(feature)))
    {
        raster.feature(feature, tile.z)?;
    }
    for feature in features
        .iter()
        .filter(|feature| phase(feature) == 50 && feature.structure == 0)
    {
        raster.feature(feature, tile.z)?;
    }
    for feature in features
        .iter()
        .filter(|feature| phase(feature) == 50 && feature.structure == 1)
    {
        raster.feature(feature, tile.z)?;
    }
    raster.roads(store, &roads, tile.z, 1)?;
    for feature in features
        .iter()
        .filter(|feature| phase(feature) >= 60 || (phase(feature) == 50 && feature.structure == 2))
    {
        raster.feature(feature, tile.z)?;
    }
    raster.roads(store, &roads, tile.z, 2)?;
    context.check()?;
    let labels = if let Some(spec) = spec.filter(|spec| spec.labels) {
        super::text::draw_labels(
            store.connection(),
            tile,
            width,
            height,
            spec.language,
            &mut raster.pixmap,
            context,
        )?
    } else {
        0
    };
    let candidate_count = (features.len() + roads.len()) as u64 + labels;
    let loaded_vertices = total as u64 + raster.road_vertices;
    Ok((raster.pixmap, candidate_count, loaded_vertices))
}

fn phase(feature: &Feature) -> i32 {
    match feature.kind {
        FeatureKind::Land => 0,
        FeatureKind::Forest
        | FeatureKind::Grass
        | FeatureKind::Park
        | FeatureKind::Farmland
        | FeatureKind::Residential
        | FeatureKind::Commercial
        | FeatureKind::Industrial
        | FeatureKind::Sand
        | FeatureKind::BareRock
        | FeatureKind::Wetland => 10,
        FeatureKind::Water => 40,
        FeatureKind::Waterway | FeatureKind::Railway if feature.structure == 0 => 25,
        FeatureKind::Waterway if feature.structure < 2 => 40,
        FeatureKind::Contour => 30,
        FeatureKind::Building => 45,
        FeatureKind::Railway => 50,
        FeatureKind::Waterway => 60,
    }
}

fn point_count(geometry: &Geometry) -> usize {
    match geometry {
        Geometry::Line(points) => points.len(),
        Geometry::Polygon(parts) => parts
            .iter()
            .map(|part| part.outer.len() + part.holes.iter().map(Vec::len).sum::<usize>())
            .sum(),
    }
}

#[derive(Clone, Copy)]
struct Window {
    origin_x: i64,
    origin_y: i64,
    width: usize,
    height: usize,
    scale: f64,
}

impl Window {
    fn new(tile: TileId, width: usize, height: usize) -> Result<Self> {
        ensure!(
            width > 0 && width <= 512 && height > 0 && height <= 512,
            "描画窓の寸法が上限を超えました"
        );
        Ok(Self {
            origin_x: i64::from(tile.x) * i64::from(TILE_SIZE),
            origin_y: i64::from(tile.y) * i64::from(TILE_SIZE),
            width,
            height,
            scale: f64::from(TILE_SIZE) * 2_f64.powi(tile.z.into()),
        })
    }
    fn bounds(self) -> Rect {
        Rect {
            min_x: self.origin_x as f64 / self.scale,
            max_x: (self.origin_x as f64 + self.width as f64) / self.scale,
            min_y: self.origin_y as f64 / self.scale,
            max_y: (self.origin_y as f64 + self.height as f64) / self.scale,
        }
    }
    fn pixel(self, point: Point) -> Result<Point> {
        ensure!(
            point.x.is_finite()
                && point.y.is_finite()
                && (0.0..=1.0).contains(&point.x)
                && (0.0..=1.0).contains(&point.y),
            "地物に不正な座標があります"
        );
        Ok(Point {
            x: (point.x * self.scale * COORDINATE_GRID).round() / COORDINATE_GRID,
            y: (point.y * self.scale * COORDINATE_GRID).round() / COORDINATE_GRID,
        })
    }
}

struct Raster<'a> {
    pixmap: Pixmap,
    window: Window,
    context: &'a OperationContext,
    work: usize,
    road_vertices: u64,
    landmask: Option<Mask>,
    carto: bool,
}

struct Mask {
    samples: Vec<u16>,
    bounds: Option<(usize, usize, usize, usize)>,
}

impl Mask {
    fn new(window: Window) -> Self {
        Self {
            samples: vec![0; window.width * window.height],
            bounds: None,
        }
    }
    fn include(&mut self, left: usize, right: usize, row: usize) {
        if left >= right {
            return;
        }
        self.bounds = Some(match self.bounds {
            None => (left, right, row, row + 1),
            Some((x0, x1, y0, y1)) => (x0.min(left), x1.max(right), y0.min(row), y1.max(row + 1)),
        });
    }
}

impl<'a> Raster<'a> {
    fn new(window: Window, background: [u8; 4], context: &'a OperationContext) -> Result<Self> {
        let mut pixmap = Pixmap::new(window.width as u32, window.height as u32)
            .context("標準地図の画像領域を確保できません")?;
        let [r, g, b, a] = background;
        pixmap.fill(Color::from_rgba8(r, g, b, a));
        Ok(Self {
            pixmap,
            window,
            context,
            work: 0,
            road_vertices: 0,
            landmask: None,
            carto: false,
        })
    }

    fn charge(&mut self, work: usize) -> Result<()> {
        self.work = self
            .work
            .checked_add(work)
            .context("地図描画の演算量が上限を超えました")?;
        ensure!(self.work <= MAX_WORK, "地図描画の演算量上限を超えました");
        self.context.check()
    }

    fn feature(&mut self, feature: &Feature, zoom: u8) -> Result<()> {
        let mut style = feature_style(feature.kind);
        if self.carto {
            style.color = carto_style::feature_color(feature.kind);
        }
        if zoom < style.zoom {
            return Ok(());
        }
        if feature.kind == FeatureKind::Contour {
            let interval = CONTOUR_DISPLAY
                .iter()
                .rev()
                .find(|(minimum, _)| zoom >= *minimum)
                .map(|(_, interval)| *interval)
                .unwrap_or(500);
            if feature.role % interval != 0 {
                return Ok(());
            }
        }
        match &feature.geometry {
            Geometry::Polygon(parts) => {
                let rings = parts
                    .iter()
                    .flat_map(|part| {
                        std::iter::once(part.outer.as_slice())
                            .chain(part.holes.iter().map(Vec::as_slice))
                    })
                    .collect::<Vec<_>>();
                let mut mask = self.polygon_mask(&rings)?;
                if feature.kind == FeatureKind::Land {
                    if let Some(coverage) = &self.landmask {
                        mask.bounds = match (mask.bounds, coverage.bounds) {
                            (Some((x0, x1, y0, y1)), Some((cx0, cx1, cy0, cy1))) => {
                                let bounds = (x0.max(cx0), x1.min(cx1), y0.max(cy0), y1.min(cy1));
                                (bounds.0 < bounds.1 && bounds.2 < bounds.3).then_some(bounds)
                            },
                            _ => None,
                        };
                        if let Some((left, right, top, bottom)) = mask.bounds {
                            for row in top..bottom {
                                for column in left..right {
                                    let index = row * self.window.width + column;
                                    mask.samples[index] &= coverage.samples[index];
                                }
                            }
                        }
                    }
                }
                self.blend(&mask, style.color)?;
                if feature.kind == FeatureKind::Building {
                    let mut outline = Mask::new(self.window);
                    for ring in rings {
                        self.stroke_mask(ring, f64::from(style.width), &mut outline)?;
                    }
                    self.blend(
                        &outline,
                        if self.carto {
                            carto_style::BUILDING_OUTLINE
                        } else {
                            BUILDING_OUTLINE
                        },
                    )?;
                }
            },
            Geometry::Line(points) => {
                let width = match feature.kind {
                    FeatureKind::Contour if feature.role % 100 == 0 => MAJOR_CONTOUR_WIDTH,
                    FeatureKind::Waterway => {
                        f64::from(style.width)
                            * (1.0
                                + f64::from(zoom.saturating_sub(WATERWAY_GROWTH_START_ZOOM))
                                    * WATERWAY_WIDTH_GROWTH)
                    },
                    _ => f64::from(style.width),
                };
                let mut mask = Mask::new(self.window);
                self.stroke_mask(points, width, &mut mask)?;
                self.blend(&mask, style.color)?;
            },
        }
        Ok(())
    }

    fn roads(
        &mut self,
        store: &Store,
        roads: &[FeatureKey],
        zoom: u8,
        structure: u8,
    ) -> Result<()> {
        if self.carto {
            return self.carto_roads(store, roads, zoom, structure);
        }
        let style = Style::roads_v1();
        let selected = roads
            .iter()
            .filter(|road| road.attributes.structure_rank == structure)
            .collect::<Vec<_>>();
        let mut first = 0;
        while first < selected.len() {
            let layer = selected[first].attributes.effective_layer;
            let mut end = first + 1;
            while end < selected.len() && selected[end].attributes.effective_layer == layer {
                end += 1;
            }
            for casing in [true, false] {
                for road in &selected[first..end] {
                    self.context.check()?;
                    let points = store.load_geometry(road.feature_id, zoom)?;
                    self.road_vertices = self
                        .road_vertices
                        .checked_add(points.len() as u64)
                        .context("道路の読込点数が上限を超えました")?;
                    ensure!(
                        points.len() <= MAX_TOTAL_POINTS,
                        "道路の頂点数上限を超えました"
                    );
                    let width = f64::from(if casing {
                        style.outer_width(road.attributes, zoom)
                    } else {
                        style.width(road.attributes, zoom)
                    });
                    let mut mask = Mask::new(self.window);
                    self.stroke_mask(&points, width, &mut mask)?;
                    self.blend(
                        &mask,
                        if structure == 0 && !casing {
                            TUNNEL
                        } else {
                            style.color(road.attributes, casing)
                        },
                    )?;
                }
            }
            first = end;
        }
        Ok(())
    }

    fn polygon_mask(&mut self, rings: &[&[Point]]) -> Result<Mask> {
        let mut rows = vec![Vec::<f64>::new(); self.window.height * SAMPLES];
        let mut crossings = 0_usize;
        for ring in rings {
            ensure!(
                ring.len() >= 4 && ring.len() <= MAX_TOTAL_POINTS && ring.first() == ring.last(),
                "面の輪郭が閉じていません"
            );
            for (index, pair) in ring.windows(2).enumerate() {
                if index.is_multiple_of(1024) {
                    self.context.check()?;
                }
                let (a, b) = (self.window.pixel(pair[0])?, self.window.pixel(pair[1])?);
                self.edge_crossings(a, b, &mut rows, &mut crossings)?;
            }
        }
        let mut mask = Mask::new(self.window);
        for (row, xs) in rows.iter_mut().enumerate() {
            self.charge(xs.len().saturating_add(1))?;
            xs.sort_unstable_by(f64::total_cmp);
            ensure!(xs.len().is_multiple_of(2), "面の走査線交点数が不正です");
            for interval in xs.chunks_exact(2) {
                self.fill_interval(&mut mask, row, interval[0], interval[1])?;
            }
        }
        Ok(mask)
    }

    fn carto_roads(
        &mut self,
        store: &Store,
        roads: &[FeatureKey],
        zoom: u8,
        structure: u8,
    ) -> Result<()> {
        let selected = roads
            .iter()
            .filter(|road| road.attributes.structure_rank == structure)
            .collect::<Vec<_>>();
        let mut first = 0;
        while first < selected.len() {
            let layer = selected[first].attributes.effective_layer;
            let mut end = first + 1;
            while end < selected.len() && selected[end].attributes.effective_layer == layer {
                end += 1;
            }
            for casing in [true, false] {
                for road in &selected[first..end] {
                    self.context.check()?;
                    let points = store.load_geometry(road.feature_id, zoom)?;
                    ensure!(
                        points.len() <= MAX_TOTAL_POINTS,
                        "道路の頂点数上限を超えました"
                    );
                    self.road_vertices = self
                        .road_vertices
                        .checked_add(points.len() as u64)
                        .context("道路の読込点数が上限を超えました")?;
                    let width = carto_style::road_width(road.attributes, zoom, casing);
                    let mut mask = Mask::new(self.window);
                    if let Some((on, off)) = carto_style::road_dash(road.attributes, zoom, casing) {
                        self.dashed_stroke_mask(&points, width, on, off, &mut mask)?;
                    } else {
                        self.stroke_mask(&points, width, &mut mask)?;
                    }
                    self.blend(
                        &mask,
                        carto_style::road_color(road.attributes, zoom, casing),
                    )?;
                }
            }
            first = end;
        }
        Ok(())
    }

    fn dashed_stroke_mask(
        &mut self,
        points: &[Point],
        width: f64,
        on: f64,
        off: f64,
        mask: &mut Mask,
    ) -> Result<()> {
        let period = on + off;
        let margin = width / 2.0 + 1.0;
        let bounds = Rect {
            min_x: self.window.origin_x as f64 - margin,
            max_x: self.window.origin_x as f64 + self.window.width as f64 + margin,
            min_y: self.window.origin_y as f64 - margin,
            max_y: self.window.origin_y as f64 + self.window.height as f64 + margin,
        };
        let mut distance = 0.0;
        for (index, pair) in points.windows(2).enumerate() {
            if index.is_multiple_of(128) {
                self.context.check()?;
            }
            let (a, b) = (self.window.pixel(pair[0])?, self.window.pixel(pair[1])?);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let length = libm::sqrt(dx * dx + dy * dy);
            if length == 0.0 {
                continue;
            }
            // 破線の位相は地物全体の起点から測り、タイルごとに先頭へ戻さない。
            if let Some((left, right)) = clip_segment_parameters(a, b, bounds) {
                let first = ((distance + left * length) / period).floor() as i64;
                let last = ((distance + right * length) / period).floor() as i64;
                ensure!(
                    last.saturating_sub(first) <= 1024,
                    "破線の区間数上限を超えました"
                );
                for step in first..=last {
                    let start = ((step as f64 * period - distance) / length).max(left);
                    let end = ((step as f64 * period + on - distance) / length).min(right);
                    if start >= end {
                        continue;
                    }
                    let segment = [start, end].map(|t| Point {
                        x: (a.x + dx * t) / self.window.scale,
                        y: (a.y + dy * t) / self.window.scale,
                    });
                    self.stroke_mask(&segment, width, mask)?;
                }
            }
            distance += length;
        }
        Ok(())
    }

    fn edge_crossings(
        &mut self,
        a: Point,
        b: Point,
        rows: &mut [Vec<f64>],
        crossings: &mut usize,
    ) -> Result<()> {
        if a.y == b.y {
            return Ok(());
        }
        let (a, b) = if a.y < b.y { (a, b) } else { (b, a) };
        let base = self.window.origin_y * SAMPLES as i64;
        let start = ((a.y * SAMPLES as f64 - 0.5).ceil() as i64 - base).clamp(0, rows.len() as i64)
            as usize;
        let end = ((b.y * SAMPLES as f64 - 0.5).ceil() as i64 - base).clamp(0, rows.len() as i64)
            as usize;
        self.charge(end.saturating_sub(start))?;
        *crossings = crossings
            .checked_add(end.saturating_sub(start))
            .context("交点数が上限を超えました")?;
        ensure!(
            *crossings <= MAX_CROSSINGS,
            "面の走査線交点数上限を超えました"
        );
        for (row, xs) in rows.iter_mut().enumerate().take(end).skip(start) {
            let y = self.window.origin_y as f64 + (row as f64 + 0.5) / SAMPLES as f64;
            let x = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
            ensure!(x.is_finite(), "面の交点座標が不正です");
            xs.push(x);
        }
        Ok(())
    }

    fn fill_interval(&mut self, mask: &mut Mask, row: usize, start: f64, end: f64) -> Result<()> {
        let base = self.window.origin_x * SAMPLES as i64;
        let left = ((start * SAMPLES as f64 - 0.5).ceil() as i64 - base)
            .clamp(0, (self.window.width * SAMPLES) as i64) as usize;
        let right = ((end * SAMPLES as f64 - 0.5).ceil() as i64 - base)
            .clamp(0, (self.window.width * SAMPLES) as i64) as usize;
        self.charge(right.saturating_sub(left))?;
        if left < right {
            mask.include(left / SAMPLES, (right - 1) / SAMPLES + 1, row / SAMPLES);
        }
        for sample in left..right {
            let pixel = (row / SAMPLES) * self.window.width + sample / SAMPLES;
            mask.samples[pixel] |= 1 << ((row % SAMPLES) * SAMPLES + sample % SAMPLES);
        }
        Ok(())
    }

    fn pixel_polygon_union(&mut self, points: &[Point], mask: &mut Mask) -> Result<()> {
        // 線の各長方形・円近似は凸面なので、交点リストを全画面へ確保しない。
        let min_y = points
            .iter()
            .map(|point| point.y)
            .fold(f64::INFINITY, f64::min);
        let max_y = points
            .iter()
            .map(|point| point.y)
            .fold(f64::NEG_INFINITY, f64::max);
        let base = self.window.origin_y * SAMPLES as i64;
        let limit = (self.window.height * SAMPLES) as i64;
        let start = ((min_y * SAMPLES as f64 - 0.5).ceil() as i64 - base).clamp(0, limit) as usize;
        let end = ((max_y * SAMPLES as f64 - 0.5).ceil() as i64 - base).clamp(0, limit) as usize;
        self.charge(end.saturating_sub(start).saturating_mul(points.len()))?;
        for row in start..end {
            let y = self.window.origin_y as f64 + (row as f64 + 0.5) / SAMPLES as f64;
            let mut left = f64::INFINITY;
            let mut right = f64::NEG_INFINITY;
            for pair in points.windows(2) {
                let (a, b) = if pair[0].y < pair[1].y {
                    (pair[0], pair[1])
                } else {
                    (pair[1], pair[0])
                };
                if y >= a.y && y < b.y {
                    let x = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
                    left = left.min(x);
                    right = right.max(x);
                }
            }
            if left < right {
                self.fill_interval(mask, row, left, right)?;
            }
        }
        Ok(())
    }

    fn stroke_mask(&mut self, points: &[Point], width: f64, mask: &mut Mask) -> Result<()> {
        ensure!(
            width.is_finite() && width > 0.0 && width <= 32.0 && points.len() <= MAX_TOTAL_POINTS,
            "線の寸法が上限を超えました"
        );
        let radius = width / 2.0;
        let bounds = self
            .window
            .bounds()
            .expand((radius + 1.0) / self.window.scale);
        for (index, pair) in points.windows(2).enumerate() {
            if index.is_multiple_of(128) {
                self.context.check()?;
            }
            let (a, b) = (self.window.pixel(pair[0])?, self.window.pixel(pair[1])?);
            if !Rect::from_points(pair)?.intersects(bounds) {
                continue;
            }
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let length = libm::sqrt(dx * dx + dy * dy);
            if length == 0.0 {
                continue;
            }
            let (nx, ny) = (-dy / length * radius, dx / length * radius);
            let vertices = [
                Point {
                    x: a.x + nx,
                    y: a.y + ny,
                },
                Point {
                    x: b.x + nx,
                    y: b.y + ny,
                },
                Point {
                    x: b.x - nx,
                    y: b.y - ny,
                },
                Point {
                    x: a.x - nx,
                    y: a.y - ny,
                },
                Point {
                    x: a.x + nx,
                    y: a.y + ny,
                },
            ]
            .map(round_pixel);
            self.pixel_polygon_union(&vertices, mask)?;
        }
        for (index, point) in points.iter().enumerate() {
            if index.is_multiple_of(128) {
                self.context.check()?;
            }
            if !bounds.contains(*point) {
                continue;
            }
            let center = self.window.pixel(*point)?;
            let mut vertices = Vec::with_capacity(LINE_CIRCLE_POINTS + 1);
            for step in 0..LINE_CIRCLE_POINTS {
                let angle = (step as f64 / LINE_CIRCLE_POINTS as f64) * std::f64::consts::TAU;
                vertices.push(round_pixel(Point {
                    x: center.x + radius * libm::cos(angle),
                    y: center.y + radius * libm::sin(angle),
                }));
            }
            vertices.push(vertices[0]);
            self.pixel_polygon_union(&vertices, mask)?;
        }
        Ok(())
    }

    fn blend(&mut self, mask: &Mask, color: [u8; 4]) -> Result<()> {
        let Some((left, right, top, bottom)) = mask.bounds else {
            return Ok(());
        };
        self.charge((right - left).saturating_mul(bottom - top))?;
        for row in top..bottom {
            for column in left..right {
                let index = row * self.window.width + column;
                let count = mask.samples[index].count_ones();
                if count == 0 {
                    continue;
                }
                let pixel = &mut self.pixmap.data_mut()[index * 4..index * 4 + 4];
                for channel in 0..3 {
                    pixel[channel] = ((u32::from(color[channel]) * count
                        + u32::from(pixel[channel]) * (16 - count)
                        + 8)
                        / 16) as u8;
                }
                pixel[3] = 255;
            }
        }
        Ok(())
    }

    fn shade(&mut self, connection: &rusqlite::Connection, query: Rect, zoom: u8) -> Result<()> {
        if !super::store::details(connection)?.is_some_and(|details| details.elevation.is_some()) {
            return Ok(());
        }
        let sampler = Sampler::new(connection, query, zoom, self.context)?;
        let step = sampler.step().max(1.0 / self.window.scale);
        ensure!(step.is_finite() && step > 0.0, "標高の標本間隔が不正です");
        for row in 0..self.window.height {
            self.charge(self.window.width.saturating_mul(9))?;
            let y = (self.window.origin_y as f64 + row as f64 + 0.5) / self.window.scale;
            for column in 0..self.window.width {
                let x = (self.window.origin_x as f64 + column as f64 + 0.5) / self.window.scale;
                let mut heights = [0_f64; 9];
                let mut valid = true;
                for dy in 0..3 {
                    for dx in 0..3 {
                        match sampler.sample(Point {
                            x: x + (dx as f64 - 1.0) * step,
                            y: y + (dy as f64 - 1.0) * step,
                        }) {
                            Some(value) if value.is_finite() => {
                                heights[dy * 3 + dx] = f64::from(value)
                            },
                            _ => valid = false,
                        }
                    }
                }
                if !valid {
                    continue;
                }
                let factor = shade_factor(heights, y, step);
                let offset = (row * self.window.width + column) * 4;
                for channel in &mut self.pixmap.data_mut()[offset..offset + 3] {
                    *channel = (f64::from(*channel) * factor).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        Ok(())
    }
}

fn round_pixel(point: Point) -> Point {
    Point {
        x: (point.x * COORDINATE_GRID).round() / COORDINATE_GRID,
        y: (point.y * COORDINATE_GRID).round() / COORDINATE_GRID,
    }
}

fn clip_segment_parameters(a: Point, b: Point, bounds: Rect) -> Option<(f64, f64)> {
    let mut left = 0.0_f64;
    let mut right = 1.0_f64;
    for (p, q) in [
        (-(b.x - a.x), a.x - bounds.min_x),
        (b.x - a.x, bounds.max_x - a.x),
        (-(b.y - a.y), a.y - bounds.min_y),
        (b.y - a.y, bounds.max_y - a.y),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else if p < 0.0 {
            left = left.max(q / p);
        } else {
            right = right.min(q / p);
        }
        if left > right {
            return None;
        }
    }
    Some((left, right))
}

fn shade_factor(heights: [f64; 9], world_y: f64, step: f64) -> f64 {
    let metres =
        EARTH_CIRCUMFERENCE * step / libm::cosh(std::f64::consts::PI * (1.0 - 2.0 * world_y));
    let dx =
        (heights[2] + 2.0 * heights[5] + heights[8] - heights[0] - 2.0 * heights[3] - heights[6])
            / (8.0 * metres);
    let dy =
        (heights[6] + 2.0 * heights[7] + heights[8] - heights[0] - 2.0 * heights[1] - heights[2])
            / (8.0 * metres);
    let light = (0.5 * dx + 0.5 * dy + std::f64::consts::FRAC_1_SQRT_2)
        / libm::sqrt(dx * dx + dy * dy + 1.0);
    (1.0 + SHADE_STRENGTH * (light / std::f64::consts::FRAC_1_SQRT_2 - 1.0))
        .clamp(SHADE_MIN, SHADE_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilegen::cancel::CancellationToken;

    fn context() -> OperationContext {
        OperationContext::new(CancellationToken::new())
    }
    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }
    fn rectangle(x: f64, y: f64, w: f64, h: f64) -> Vec<Point> {
        vec![
            point(x, y),
            point(x + w, y),
            point(x + w, y + h),
            point(x, y + h),
            point(x, y),
        ]
    }

    #[test]
    fn 面の穴は下の地物を残し全頂点が窓外でも塗る() {
        let context = context();
        let window = Window::new(TileId::new(1, 0, 0).unwrap(), 256, 256).unwrap();
        let mut raster = Raster::new(window, [20, 90, 30, 255], &context).unwrap();
        let outer = rectangle(0.0, 0.0, 0.8, 0.8);
        let hole = rectangle(0.1, 0.1, 0.1, 0.1);
        let mask = raster.polygon_mask(&[&outer, &hole]).unwrap();
        raster.blend(&mask, [30, 120, 240, 255]).unwrap();
        let pixel =
            |x: usize, y: usize| &raster.pixmap.data()[(y * 256 + x) * 4..(y * 256 + x) * 4 + 4];
        assert_eq!(pixel(10, 10), [30, 120, 240, 255]);
        assert_eq!(pixel(75, 75), [20, 90, 30, 255]);
        assert_eq!(pixel(250, 250), [30, 120, 240, 255]);
    }

    #[test]
    fn 海陸の処理範囲外を海や陸として確定しない() {
        let context = context();
        let window = Window::new(TileId::new(1, 0, 0).unwrap(), 256, 256).unwrap();
        let mut raster = Raster::new(window, BACKGROUND, &context).unwrap();
        let coverage = rectangle(0.1, 0.1, 0.2, 0.2);
        let mask = raster.polygon_mask(&[&coverage]).unwrap();
        raster.blend(&mask, SEA).unwrap();
        raster.landmask = Some(mask);
        let feature = Feature {
            osm_type: 3,
            osm_id: 1,
            role: 0,
            kind: FeatureKind::Land,
            geometry: Geometry::Polygon(vec![super::super::model::PolygonPart {
                outer: rectangle(0.2, 0.0, 0.3, 0.5),
                holes: vec![],
            }]),
            layer: 0,
            structure: 1,
        };
        raster.feature(&feature, 1).unwrap();
        let pixel =
            |x: usize, y: usize| &raster.pixmap.data()[(y * 256 + x) * 4..(y * 256 + x) * 4 + 4];
        assert_eq!(pixel(20, 90), BACKGROUND);
        assert_eq!(pixel(75, 90), SEA);
        assert_eq!(pixel(125, 90), feature_style(FeatureKind::Land).color);
        assert_eq!(pixel(200, 90), BACKGROUND);
    }

    #[test]
    fn 水域面が等高線を覆い湖面に地形線を残さない() {
        let context = context();
        let window = Window::new(TileId::new(1, 0, 0).unwrap(), 256, 256).unwrap();
        let mut raster = Raster::new(window, BACKGROUND, &context).unwrap();
        let contour = Feature {
            osm_type: 4,
            osm_id: 1,
            role: 100,
            kind: FeatureKind::Contour,
            geometry: Geometry::Line(vec![point(0.05, 0.2), point(0.45, 0.2)]),
            layer: 0,
            structure: 1,
        };
        let water = Feature {
            osm_type: 1,
            osm_id: 2,
            role: 0,
            kind: FeatureKind::Water,
            geometry: Geometry::Polygon(vec![super::super::model::PolygonPart {
                outer: rectangle(0.15, 0.1, 0.2, 0.2),
                holes: vec![],
            }]),
            layer: 0,
            structure: 1,
        };
        assert!(phase(&contour) < phase(&water));
        raster.feature(&contour, 14).unwrap();
        raster.feature(&water, 14).unwrap();
        let pixel =
            |x: usize, y: usize| &raster.pixmap.data()[(y * 256 + x) * 4..(y * 256 + x) * 4 + 4];
        assert_eq!(pixel(60, 102), feature_style(FeatureKind::Contour).color);
        assert_eq!(pixel(120, 102), feature_style(FeatureKind::Water).color);
    }

    #[test]
    fn 複合面と線の四タイルは直接描画窓と一致する() {
        let context = context();
        let tile = TileId::new(2, 1, 1).unwrap();
        let outer = vec![
            point(0.20, 0.20),
            point(0.78, 0.24),
            point(0.75, 0.78),
            point(0.45, 0.63),
            point(0.24, 0.75),
            point(0.20, 0.20),
        ];
        let hole = rectangle(0.46, 0.43, 0.08, 0.15);
        let line = vec![point(0.20, 0.25), point(0.49, 0.51), point(0.80, 0.68)];
        let render = |tile, width, height| {
            let mut raster = Raster::new(
                Window::new(tile, width, height).unwrap(),
                BACKGROUND,
                &context,
            )
            .unwrap();
            let mask = raster.polygon_mask(&[&outer, &hole]).unwrap();
            raster.blend(&mask, [171, 211, 231, 255]).unwrap();
            let mut mask = Mask::new(raster.window);
            raster.stroke_mask(&line, 3.6, &mut mask).unwrap();
            raster.blend(&mask, [200, 100, 40, 255]).unwrap();
            raster.pixmap
        };
        let quad = render(tile, 512, 512);
        for dy in 0..2 {
            for dx in 0..2 {
                let image = render(TileId::new(2, 1 + dx, 1 + dy).unwrap(), 256, 256);
                for row in 0..256_usize {
                    let expected = ((row + dy as usize * 256) * 512 + dx as usize * 256) * 4;
                    assert_eq!(
                        &quad.data()[expected..expected + 1024],
                        &image.data()[row * 1024..(row + 1) * 1024]
                    );
                }
            }
        }
    }

    #[test]
    fn 平面の陰影は色を変えず勾配の向きで明暗が変わる() {
        assert!((shade_factor([100.0; 9], 0.5, 0.0001) - 1.0).abs() < 1e-12);
        let east = [0.0, 100.0, 200.0, 0.0, 100.0, 200.0, 0.0, 100.0, 200.0];
        let west = east.map(|height| 200.0 - height);
        assert!(shade_factor(east, 0.5, 0.00001) > shade_factor(west, 0.5, 0.00001));
    }

    #[test]
    fn 描画設定の識別は安定する() {
        assert_eq!(style_hash(), style_hash());
        assert_eq!(style_hash().len(), 64);
    }

    #[test]
    fn 取消と不正輪郭を描画前に拒否する() {
        let token = CancellationToken::new();
        let context = OperationContext::new(token.clone());
        let mut raster = Raster::new(
            Window::new(TileId::new(1, 0, 0).unwrap(), 256, 256).unwrap(),
            BACKGROUND,
            &context,
        )
        .unwrap();
        assert!(
            raster
                .polygon_mask(&[&[
                    point(0.0, 0.0),
                    point(0.1, 0.0),
                    point(0.1, 0.1),
                    point(0.0, 0.1)
                ]])
                .is_err()
        );
        token.cancel();
        assert!(
            raster
                .polygon_mask(&[&rectangle(0.0, 0.0, 0.5, 0.5)])
                .is_err()
        );
    }
}
