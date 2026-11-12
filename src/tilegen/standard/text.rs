//! 固定フォントと世界座標の候補選別による、タイル境界に依存しない地名描画。

use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

use anyhow::{Context, Result, ensure};
use harfrust::{Buffer, Direction, ShaperFont};
use sha2::{Digest, Sha256};
use skrifa::{DrawMemory, Font, GlyphId, PathSink, ScalerFont};
use tiny_skia::{FillRule, Paint, Path, PathBuilder, Pixmap, PixmapPaint, Stroke, Transform};
use unicode_segmentation::UnicodeSegmentation;

use crate::tilegen::{
    geometry::Rect,
    identity::IdentityHasher,
    operation::{DiagnosticLevel, OperationContext},
    render_spec::LabelLanguage,
    tile::{TILE_SIZE, TileId},
};

use super::labels::{CATEGORIES, LabelCandidate, query_labels_for_categories};

static FONT_BYTES: &[u8] = include_bytes!("../../../res/fonts/NotoSansCJKjp-Regular.otf");
const CELL_SIZE: f64 = 128.0;
const CELL_LIMIT: usize = 16;
const MAX_HALF_EXTENT: f64 = 128.0;
const MAX_WIDTH: f64 = 224.0;
const MAX_GRAPHEMES: usize = 48;
const MAX_LAYOUTS: usize = 4096;
const MAX_GLYPHS: usize = 131_072;
const MAX_GLYPH_CACHE: usize = 512;
const HALO_WIDTH: f32 = 2.6;
const COLLISION_PADDING: f64 = 2.0;
const POSITION_GRID: f64 = 64.0;
// 可視名の代表点までH、反対側の外端までさらにH、競合相手の代表点までさらにH。
// 両方の衝突余白、2つの矩形の切り捨て各1px、2点の量子化各半標本も含める。
const LABEL_QUERY_MARGIN: f64 =
    MAX_HALF_EXTENT * 3.0 + COLLISION_PADDING * 2.0 + 2.0 + 1.0 / POSITION_GRID;
const NO_LINE_START: &str = ")]}.｝）］｠〉》」』】〕〗〙〛、。，．・：；？！!?:;,ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ’”";
const NO_LINE_END: &str = "([{｛（［｟〈《「『【〔〖〘〚‘“";

pub fn font_hash() -> String {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| format!("{:x}", Sha256::digest(FONT_BYTES)))
        .clone()
}

/// 文字の結果を変える設定だけを、フォントそのものの内容とは別に識別する。
pub fn layout_hash() -> String {
    let mut hash = IdentityHasher::new("geocode-world-label-layout-v1");
    hash.text("harfrust-0.16.0-skrifa-0.50.0-unhinted-horizontal-grapheme-kinsoku-short-name-two-lines-outer-blockers-v3");
    hash.text(NO_LINE_START);
    hash.text(NO_LINE_END);
    for value in [
        CELL_SIZE,
        MAX_HALF_EXTENT,
        MAX_WIDTH,
        COLLISION_PADDING,
        POSITION_GRID,
        LABEL_QUERY_MARGIN,
    ] {
        hash.bytes(&value.to_le_bytes());
    }
    for value in [CELL_LIMIT, MAX_GRAPHEMES] {
        hash.u32(value as u32);
    }
    hash.f32(HALO_WIDTH);
    // 既存の識別順を維持し、照会と表示設定が使う許可表を共有する。
    for category in CATEGORIES {
        hash.text(category);
        for zoom in 0..=22 {
            if let Some(style) = label_style(category, zoom) {
                hash.u8(zoom);
                hash.u8(style.size);
                hash.bytes(&style.color);
            }
        }
    }
    hash.finish()
}

fn font() -> &'static Font {
    static FONT: OnceLock<Font> = OnceLock::new();
    FONT.get_or_init(|| Font::new(FONT_BYTES, 0).expect("同梱した固定フォントを読めること"))
}

#[derive(Clone, Copy)]
struct LabelStyle {
    size: u8,
    color: [u8; 4],
}

fn label_style(category: &str, zoom: u8) -> Option<LabelStyle> {
    let (minimum, size, color) = match category {
        "place.city" => (5, if zoom < 9 { 15 } else { 17 }, [58, 58, 58, 255]),
        "place.town" => (8, 14, [65, 65, 65, 255]),
        "place.village" => (10, 13, [70, 70, 70, 255]),
        "place.suburb" | "place.quarter" => (12, 12, [85, 85, 85, 255]),
        "place.hamlet" => (12, 12, [80, 80, 80, 255]),
        "place.neighbourhood" => (14, 11, [100, 100, 100, 255]),
        "place.isolated_dwelling" => (15, 11, [100, 100, 100, 255]),
        "place.locality" => (13, 11, [100, 100, 100, 255]),
        "place.administrative" => (9, 12, [105, 89, 112, 255]),
        "natural.island" => (7, 13, [80, 95, 80, 255]),
        "natural.peak" | "natural.volcano" | "natural.saddle" => (11, 12, [112, 82, 59, 255]),
        "water.lake" => (9, 12, [54, 117, 142, 255]),
        "water.river" => (11, 12, [54, 117, 142, 255]),
        "landmark.airport" => (10, 12, [80, 78, 122, 255]),
        "landmark.station" => (13, 12, [80, 78, 122, 255]),
        "landmark.park" => (14, 11, [57, 104, 49, 255]),
        "landmark.hospital" => (14, 11, [164, 73, 73, 255]),
        "landmark.townhall" | "landmark.education" | "landmark.tourism" | "landmark.historic" => {
            (14, 11, [108, 87, 112, 255])
        },
        _ => return None,
    };
    (zoom >= minimum).then_some(LabelStyle { size, color })
}

fn name_for(candidate: &LabelCandidate, language: LabelLanguage) -> Option<&str> {
    let keys = match language {
        LabelLanguage::Ja => ["name:ja", "name", "int_name", "name:en", "short_name"],
        LabelLanguage::Local => ["name", "name:ja", "int_name", "name:en", "short_name"],
        LabelLanguage::En => ["name:en", "int_name", "name", "name:ja", "short_name"],
    };
    keys.into_iter()
        .filter_map(|key| candidate.names.get(key))
        .map(String::as_str)
        .find(|text| !text.trim().is_empty())
}

#[derive(Clone)]
struct PositionedGlyph {
    id: u32,
    x: f64,
    y: f64,
}
struct Line {
    glyphs: Vec<PositionedGlyph>,
    width: f64,
    missing: bool,
}
struct Layout {
    style: LabelStyle,
    lines: Vec<Line>,
    bounds: Rect,
    anchor_x: f64,
    anchor_y: f64,
}

fn shape_line(text: &str, size: u8) -> Result<Line> {
    let font = font();
    let shaper = ShaperFont::new(font);
    let mut buffer = Buffer::new();
    buffer.push_str(text);
    buffer.set_direction(Direction::LeftToRight);
    buffer.guess_segment_properties();
    buffer.set_language(Some("ja".parse().expect("固定した言語識別子")));
    harfrust::shape(&shaper, &mut buffer, Default::default())
        .map_err(|error| anyhow::anyhow!("地名の文字整形に失敗しました: {error:?}"))?;
    let scale = f64::from(size) / f64::from(font.units_per_em());
    let mut x = 0.0;
    let mut y = 0.0;
    let mut glyphs = Vec::with_capacity(buffer.glyph_infos().len());
    let mut missing = false;
    let replacement = font
        .charmap()
        .map_unicode('□')
        .expect("固定フォントの欠字表示用字形");
    for (info, position) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
        // 原文字列を整形してから欠字を判断する。結合・異体字・ZWJなどを
        // charmapだけで欠字扱いすると、整形器が解釈する前に情報が失われる。
        let absent = info.glyph_id == 0;
        missing |= absent;
        glyphs.push(PositionedGlyph {
            id: if absent {
                replacement.to_u32()
            } else {
                info.glyph_id
            },
            x: x + if absent {
                0.0
            } else {
                f64::from(position.x_offset) * scale
            },
            y: y - if absent {
                0.0
            } else {
                f64::from(position.y_offset) * scale
            },
        });
        x += f64::from(if absent {
            shaper.glyph_h_advance(replacement)
        } else {
            position.x_advance
        }) * scale;
        y -= f64::from(position.y_advance) * scale;
    }
    ensure!(
        x.is_finite() && (0.0..=2048.0).contains(&x),
        "地名の文字幅が不正です"
    );
    Ok(Line {
        glyphs,
        width: x,
        missing,
    })
}

fn normalized_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn prohibited_start(grapheme: &str) -> bool {
    grapheme
        .chars()
        .next()
        .is_some_and(|ch| NO_LINE_START.contains(ch))
}

fn prohibited_end(grapheme: &str) -> bool {
    grapheme
        .chars()
        .next()
        .is_some_and(|ch| NO_LINE_END.contains(ch))
}

fn legal_break(graphemes: &[&str], index: usize) -> bool {
    index > 0
        && index < graphemes.len()
        && graphemes[..index]
            .iter()
            .rev()
            .find(|text| !text.trim().is_empty())
            .is_some_and(|text| !prohibited_end(text))
        && graphemes[index..]
            .iter()
            .find(|text| !text.trim().is_empty())
            .is_some_and(|text| !prohibited_start(text))
}

fn fitting_prefix(graphemes: &[&str], suffix: &str, size: u8) -> Result<usize> {
    let mut left = 0;
    let mut right = graphemes.len();
    while left < right {
        let middle = left + (right - left).div_ceil(2);
        let text = graphemes[..middle].join("") + suffix;
        if shape_line(&text, size)?.width <= MAX_WIDTH {
            left = middle;
        } else {
            right = middle - 1;
        }
    }
    Ok(left)
}

/// 禁則は1行目の改行位置を後ろへ詰めず、許容できる位置まで前へ戻す。
/// 許容位置がない場合は改行せず省略し、行末の開き括弧も残さない。
fn line_texts(text: &str, size: u8) -> Result<Vec<String>> {
    let normalized = normalized_text(text);
    let all = normalized.graphemes(true).collect::<Vec<_>>();
    let mut graphemes = all[..all.len().min(MAX_GRAPHEMES)].to_vec();
    let capped = all.len() > MAX_GRAPHEMES;
    if graphemes.is_empty() {
        return Ok(Vec::new());
    }
    if !capped && shape_line(&graphemes.join(""), size)?.width <= MAX_WIDTH {
        return Ok(vec![graphemes.join("")]);
    }
    let fit = fitting_prefix(&graphemes, "", size)?;
    let boundary = (1..=fit.min(graphemes.len().saturating_sub(1)))
        .rev()
        .find(|&index| legal_break(&graphemes, index));
    let mut result = Vec::new();
    if let Some(boundary) = boundary {
        result.push(graphemes[..boundary].join("").trim().to_owned());
        graphemes.drain(..boundary);
        while graphemes.first().is_some_and(|text| text.trim().is_empty()) {
            graphemes.remove(0);
        }
        if !capped && shape_line(&graphemes.join(""), size)?.width <= MAX_WIDTH {
            result.push(graphemes.join("").trim().to_owned());
            return Ok(result);
        }
    }
    let mut fit = fitting_prefix(&graphemes, "…", size)?;
    while fit > 0 && (prohibited_end(graphemes[fit - 1]) || graphemes[fit - 1].trim().is_empty()) {
        fit -= 1;
    }
    if fit > 0 {
        result.push(graphemes[..fit].join("").trim().to_owned() + "…");
    }
    result.retain(|text| !text.is_empty());
    Ok(result)
}

fn prepare_lines(text: &str, size: u8) -> Result<(Vec<Line>, bool)> {
    let lines = line_texts(text, size)?
        .iter()
        .map(|text| shape_line(text, size))
        .collect::<Result<Vec<_>>>()?;
    let missing = lines.iter().any(|line| line.missing);
    Ok((lines, missing))
}

fn display_name_for(
    candidate: &LabelCandidate,
    language: LabelLanguage,
    size: u8,
) -> Result<Option<&str>> {
    let Some(name) = name_for(candidate, language) else {
        return Ok(None);
    };
    let normalized = normalized_text(name);
    let graphemes = normalized.graphemes(true).collect::<Vec<_>>();
    let long =
        graphemes.len() > MAX_GRAPHEMES || shape_line(&graphemes.join(""), size)?.width > MAX_WIDTH;
    if long {
        if let Some(short) = candidate
            .names
            .get("short_name")
            .map(String::as_str)
            .filter(|short| !short.trim().is_empty())
        {
            let normalized = normalized_text(short);
            if normalized.graphemes(true).count() <= MAX_GRAPHEMES
                && shape_line(&normalized, size)?.width <= MAX_WIDTH
            {
                return Ok(Some(short));
            }
        }
    }
    Ok(Some(name))
}

fn layout(
    candidate: &LabelCandidate,
    zoom: u8,
    language: LabelLanguage,
    scale: f64,
    context: &OperationContext,
) -> Result<Option<Layout>> {
    let Some(style) = label_style(&candidate.category, zoom) else {
        return Ok(None);
    };
    let Some(name) = display_name_for(candidate, language, style.size)? else {
        return Ok(None);
    };
    let (lines, missing) = prepare_lines(name, style.size)?;
    if missing {
        context.diagnostic(
            DiagnosticLevel::Warning,
            "固定フォントにない文字を地名内で四角に置き換えました",
        );
    }
    if lines.is_empty() {
        return Ok(None);
    }
    let width = lines
        .iter()
        .map(|line| line.width)
        .fold(0.0_f64, f64::max)
        .ceil()
        + 12.0;
    let height = lines.len() as f64 * (f64::from(style.size) + 4.0) + 12.0;
    ensure!(
        width <= 256.0 && height <= 64.0,
        "地名の描画領域が上限を超えました"
    );
    let anchor_x = (candidate.anchor.x * scale * POSITION_GRID).round() / POSITION_GRID;
    let anchor_y = (candidate.anchor.y * scale * POSITION_GRID).round() / POSITION_GRID;
    let left = (anchor_x - width / 2.0).floor();
    let top = (anchor_y - height / 2.0).floor();
    Ok(Some(Layout {
        style,
        lines,
        bounds: Rect {
            min_x: left,
            max_x: left + width,
            min_y: top,
            max_y: top + height,
        },
        anchor_x,
        anchor_y,
    }))
}

fn cell_range(bounds: Rect) -> (i64, i64, i64, i64) {
    (
        (bounds.min_x / CELL_SIZE).floor() as i64,
        (bounds.max_x / CELL_SIZE).floor() as i64,
        (bounds.min_y / CELL_SIZE).floor() as i64,
        (bounds.max_y / CELL_SIZE).floor() as i64,
    )
}

fn label_query_bounds(viewport: Rect, scale: f64) -> Rect {
    let cells = cell_range(viewport.expand(LABEL_QUERY_MARGIN));
    Rect {
        min_x: (cells.0 as f64 * CELL_SIZE / scale).max(0.0),
        max_x: ((cells.1 + 1) as f64 * CELL_SIZE / scale).min(1.0),
        min_y: (cells.2 as f64 * CELL_SIZE / scale).max(0.0),
        max_y: ((cells.3 + 1) as f64 * CELL_SIZE / scale).min(1.0),
    }
}

pub fn draw_labels(
    connection: &rusqlite::Connection,
    tile: TileId,
    width: u32,
    height: u32,
    language: LabelLanguage,
    image: &mut Pixmap,
    context: &OperationContext,
) -> Result<u64> {
    context.check()?;
    let categories = CATEGORIES
        .iter()
        .copied()
        .filter(|category| label_style(category, tile.z).is_some())
        .collect::<Vec<_>>();
    if categories.is_empty() {
        return Ok(0);
    }
    let scale = f64::from(TILE_SIZE) * 2_f64.powi(i32::from(tile.z));
    let viewport = Rect {
        min_x: f64::from(tile.x * TILE_SIZE),
        min_y: f64::from(tile.y * TILE_SIZE),
        max_x: f64::from(tile.x * TILE_SIZE) + f64::from(width),
        max_y: f64::from(tile.y * TILE_SIZE) + f64::from(height),
    };
    // 可視候補とその外側競合相手を含めた後、世界固定セル全体へ拡張する。
    // セル上限の選別にも同じセルの全候補を使い、隣接窓と条件を揃える。
    let query = label_query_bounds(viewport, scale);
    let mut candidates = query_labels_for_categories(connection, query, &categories)?;
    candidates.sort_unstable_by_key(|candidate| {
        (
            Reverse(candidate.importance),
            candidate.osm_type,
            candidate.osm_id,
            candidate.category.clone(),
        )
    });
    let candidate_count = candidates.len() as u64;
    let mut counts = BTreeMap::<(i64, i64), usize>::new();
    let mut layouts = Vec::new();
    let mut glyphs = 0;
    for candidate in candidates {
        context.check()?;
        if label_style(&candidate.category, tile.z).is_none()
            || name_for(&candidate, language).is_none()
        {
            continue;
        }
        let cell = (
            (candidate.anchor.x * scale / CELL_SIZE).floor() as i64,
            (candidate.anchor.y * scale / CELL_SIZE).floor() as i64,
        );
        let count = counts.entry(cell).or_default();
        if *count >= CELL_LIMIT {
            continue;
        }
        *count += 1;
        if let Some(layout) = layout(&candidate, tile.z, language, scale, context)? {
            glyphs += layout
                .lines
                .iter()
                .map(|line| line.glyphs.len())
                .sum::<usize>();
            ensure!(
                layouts.len() < MAX_LAYOUTS && glyphs <= MAX_GLYPHS,
                "地名配置の処理量が上限を超えました"
            );
            layouts.push(layout);
        }
    }
    let mut buckets = BTreeMap::<(i64, i64), Vec<usize>>::new();
    for (index, layout) in layouts.iter().enumerate() {
        let cells = cell_range(layout.bounds.expand(COLLISION_PADDING));
        for y in cells.2..=cells.3 {
            for x in cells.0..=cells.1 {
                buckets.entry((x, y)).or_default().push(index);
            }
        }
    }
    let mut cache = BTreeMap::new();
    let mut scalers = BTreeMap::new();
    for (index, layout) in layouts.iter().enumerate() {
        context.check()?;
        if !layout.bounds.intersects(viewport) {
            continue;
        }
        let cells = cell_range(layout.bounds.expand(COLLISION_PADDING));
        let mut blockers = BTreeSet::new();
        for y in cells.2..=cells.3 {
            for x in cells.0..=cells.1 {
                if let Some(indices) = buckets.get(&(x, y)) {
                    blockers.extend(indices.iter().copied().filter(|&other| other < index));
                }
            }
        }
        // 上位候補が自分も他の文字に隠れるかは調べない。再帰的な伝播を避け、局所情報だけで確定する。
        if blockers.into_iter().any(|other| {
            layouts[other]
                .bounds
                .expand(COLLISION_PADDING)
                .intersects(layout.bounds.expand(COLLISION_PADDING))
        }) {
            continue;
        }
        draw_layout(layout, viewport, image, &mut cache, &mut scalers, context)?;
    }
    Ok(candidate_count)
}

struct TinySink(PathBuilder);
impl PathSink for TinySink {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, -y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, -y);
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.0.quad_to(cx, -cy, x, -y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.cubic_to(cx0, -cy0, cx1, -cy1, x, -y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

fn draw_layout(
    layout: &Layout,
    viewport: Rect,
    image: &mut Pixmap,
    cache: &mut BTreeMap<(u8, u32), Option<Path>>,
    scalers: &mut BTreeMap<u8, ScalerFont>,
    context: &OperationContext,
) -> Result<()> {
    let scaler = scalers.entry(layout.style.size).or_insert_with(|| {
        ScalerFont::force_unhinted(font().clone(), Some(f32::from(layout.style.size)))
    });
    let mut paths = Vec::new();
    for (line_index, line) in layout.lines.iter().enumerate() {
        let x = layout.anchor_x - layout.bounds.min_x - line.width / 2.0;
        let y = layout.anchor_y
            - layout.bounds.min_y
            - layout.lines.len() as f64 * (f64::from(layout.style.size) + 4.0) / 2.0
            + f64::from(layout.style.size)
            + line_index as f64 * (f64::from(layout.style.size) + 4.0);
        for glyph in &line.glyphs {
            context.check()?;
            let key = (layout.style.size, glyph.id);
            let path = if let Some(path) = cache.get(&key) {
                path.clone()
            } else {
                let mut sink = TinySink(PathBuilder::new());
                if let Some(outline) = scaler.outline(GlyphId::new(glyph.id)) {
                    outline
                        .draw(DrawMemory::Scratch, &mut sink)
                        .context("地名の字形を読めません")?;
                }
                let path = sink.0.finish();
                if cache.len() < MAX_GLYPH_CACHE {
                    cache.insert(key, path.clone());
                }
                path
            };
            if let Some(path) = path {
                paths.push((
                    path,
                    Transform::from_translate((x + glyph.x) as f32, (y + glyph.y) as f32),
                ));
            }
        }
    }
    // 小さな文字画像を世界座標で一度描き、整数位置で切り出すことで端のAAも一致させる。
    let mut sprite = Pixmap::new(
        (layout.bounds.max_x - layout.bounds.min_x) as u32,
        (layout.bounds.max_y - layout.bounds.min_y) as u32,
    )
    .context("地名の画像領域を確保できません")?;
    let mut halo = Paint::default();
    halo.set_color_rgba8(255, 255, 255, 245);
    halo.anti_alias = true;
    let stroke = Stroke {
        width: HALO_WIDTH,
        line_cap: tiny_skia::LineCap::Round,
        line_join: tiny_skia::LineJoin::Round,
        ..Default::default()
    };
    for (path, transform) in &paths {
        sprite.stroke_path(path, &halo, &stroke, *transform, None);
    }
    let mut fill = Paint::default();
    let [r, g, b, a] = layout.style.color;
    fill.set_color_rgba8(r, g, b, a);
    fill.anti_alias = true;
    for (path, transform) in &paths {
        sprite.fill_path(path, &fill, FillRule::Winding, *transform, None);
    }
    image.draw_pixmap(
        (layout.bounds.min_x - viewport.min_x) as i32,
        (layout.bounds.min_y - viewport.min_y) as i32,
        sprite.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        None,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilegen::{cancel::CancellationToken, geometry::Point};

    fn context() -> OperationContext {
        OperationContext::new(CancellationToken::new())
    }
    fn tile() -> TileId {
        TileId::new(14, 8192, 8192).unwrap()
    }
    fn candidate(id: i64, x: f64, y: f64, name: &str, importance: i64) -> LabelCandidate {
        let tile = tile();
        let scale = f64::from(TILE_SIZE) * 2_f64.powi(i32::from(tile.z));
        LabelCandidate {
            osm_type: 0,
            osm_id: id,
            category: "place.city".into(),
            names: BTreeMap::from([("name".into(), name.into())]),
            anchor: Point {
                x: (f64::from(tile.x * TILE_SIZE) + x) / scale,
                y: (f64::from(tile.y * TILE_SIZE) + y) / scale,
            },
            importance,
            population: None,
            admin_level: None,
            capital: false,
        }
    }
    fn connection(candidates: &[LabelCandidate]) -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        super::super::labels::initialize(&connection).unwrap();
        for candidate in candidates {
            super::super::labels::insert(&connection, candidate).unwrap();
        }
        connection
    }
    fn draw(connection: &rusqlite::Connection, tile: TileId, size: u32) -> Pixmap {
        let mut image = Pixmap::new(size, size).unwrap();
        draw_labels(
            connection,
            tile,
            size,
            size,
            LabelLanguage::Ja,
            &mut image,
            &context(),
        )
        .unwrap();
        image
    }
    fn crop(image: &Pixmap, x: u32, y: u32) -> Vec<u8> {
        let mut result = Vec::new();
        for row in y..y + TILE_SIZE {
            let start = ((row * image.width() + x) * 4) as usize;
            result.extend_from_slice(&image.data()[start..start + TILE_SIZE as usize * 4]);
        }
        result
    }

    #[test]
    fn 日本語と結合文字を整形し長名と欠字を上限内へ収める() {
        assert_eq!(
            font_hash(),
            "68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5"
        );
        let (lines, missing) = prepare_lines(
            "高松市・国立公園 e\u{301}\u{10ffff}".repeat(20).as_str(),
            17,
        )
        .unwrap();
        assert!(missing);
        assert!(!lines.is_empty() && lines.len() <= 2);
        assert!(
            lines.iter().all(
                |line| line.width <= MAX_WIDTH && line.glyphs.iter().all(|glyph| glyph.id != 0)
            )
        );
        let image = draw(
            &connection(&[candidate(1, 128.25, 128.75, "高松市・瀬戸内海", 1)]),
            tile(),
            256,
        );
        assert!(image.data().chunks_exact(4).any(|pixel| pixel[3] > 0));
        assert!(
            image
                .data()
                .chunks_exact(4)
                .any(|pixel| pixel[0] > 180 && pixel[3] > 100)
        );
    }

    #[test]
    fn 言語の優先順を固定する() {
        let mut label = candidate(1, 0.0, 0.0, "現地名", 1);
        label.names.insert("name:ja".into(), "日本語名".into());
        label.names.insert("name:en".into(), "English".into());
        assert_eq!(name_for(&label, LabelLanguage::Ja), Some("日本語名"));
        assert_eq!(name_for(&label, LabelLanguage::Local), Some("現地名"));
        assert_eq!(name_for(&label, LabelLanguage::En), Some("English"));
    }

    #[test]
    fn 名称の許可表と表示対象ズームを一致させる() {
        let expected = [
            ("place.city", 5),
            ("place.town", 8),
            ("place.village", 10),
            ("place.hamlet", 12),
            ("place.suburb", 12),
            ("place.quarter", 12),
            ("place.neighbourhood", 14),
            ("place.isolated_dwelling", 15),
            ("place.locality", 13),
            ("place.administrative", 9),
            ("natural.island", 7),
            ("natural.peak", 11),
            ("natural.volcano", 11),
            ("natural.saddle", 11),
            ("water.lake", 9),
            ("water.river", 11),
            ("landmark.station", 13),
            ("landmark.airport", 10),
            ("landmark.townhall", 14),
            ("landmark.education", 14),
            ("landmark.hospital", 14),
            ("landmark.park", 14),
            ("landmark.tourism", 14),
            ("landmark.historic", 14),
        ];
        assert_eq!(CATEGORIES, expected.map(|(category, _)| category));
        assert_eq!(
            CATEGORIES.into_iter().collect::<BTreeSet<_>>().len(),
            CATEGORIES.len()
        );
        for (category, minimum) in expected {
            for zoom in 0..=22 {
                assert_eq!(
                    label_style(category, zoom).is_some(),
                    zoom >= minimum,
                    "{category}: z{zoom}"
                );
            }
        }
        assert!(label_style("unknown.category", 22).is_none());
    }

    #[test]
    fn 未表示の施設が十万件を超えても低ズームを描き表示対象の上限は維持する() {
        let conn = connection(&[]);
        let count = super::super::labels::MAX_QUERY_LABELS as i64 + 1;
        conn.execute("WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?) INSERT INTO map_labels(osm_type,osm_id,category,names,x,y,importance,population,admin_level,capital) SELECT 0,id,'landmark.park','{\"name\":\"公園\"}',0.515625,0.515625,400000000,NULL,NULL,0 FROM ids", [count]).unwrap();
        conn.execute(
            "INSERT INTO map_label_rtree SELECT id,x,x,y,y FROM map_labels",
            [],
        )
        .unwrap();
        let mut city = candidate(count + 1, 128.0, 128.0, "県庁所在市", 900000000);
        city.anchor = Point {
            x: 0.515625,
            y: 0.515625,
        };
        super::super::labels::insert(&conn, &city).unwrap();
        for zoom in 0_u8..5 {
            let coordinate = if zoom == 0 { 0 } else { 1 << (zoom - 1) };
            let tile = TileId::new(zoom, coordinate, coordinate).unwrap();
            let mut image = Pixmap::new(256, 256).unwrap();
            assert_eq!(
                draw_labels(
                    &conn,
                    tile,
                    256,
                    256,
                    LabelLanguage::Ja,
                    &mut image,
                    &context()
                )
                .unwrap(),
                0
            );
            assert!(image.data().iter().all(|&byte| byte == 0));
        }
        let mut image = Pixmap::new(256, 256).unwrap();
        assert_eq!(
            draw_labels(
                &conn,
                TileId::new(5, 16, 16).unwrap(),
                256,
                256,
                LabelLanguage::Ja,
                &mut image,
                &context()
            )
            .unwrap(),
            1
        );
        assert!(image.data().iter().any(|&byte| byte != 0));
        let error = draw_labels(
            &conn,
            TileId::new(14, 8448, 8448).unwrap(),
            256,
            256,
            LabelLanguage::Ja,
            &mut Pixmap::new(256, 256).unwrap(),
            &context(),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("名称候補の取得量が上限"),
            "{error:#}"
        );
    }

    #[test]
    fn 異体字と結合文字と不可視の整形情報を原列のまま渡す() {
        let text = "葛\u{e0100} e\u{301} A\u{200d}B C\u{200c}D";
        assert_eq!(line_texts(text, 17).unwrap(), vec![text.to_owned()]);
        let (lines, missing) = prepare_lines(text, 17).unwrap();
        assert!(!missing, "異体字セレクタやZWJ/ZWNJを欠字へ置き換えない");
        assert!(
            lines
                .iter()
                .all(|line| line.glyphs.iter().all(|glyph| glyph.id != 0))
        );
        let long = "葛\u{e0100}".repeat(30);
        let texts = line_texts(&long, 17).unwrap();
        assert_eq!(texts.len(), 2);
        assert!(texts.iter().all(|line| {
            line.graphemes(true)
                .all(|cluster| cluster == "葛\u{e0100}" || cluster == "…")
        }));
    }

    #[test]
    fn 日本語の行頭句読点と行末開き括弧を避けて改行する() {
        for text in [
            "地".repeat(13) + "）高松市",
            "地".repeat(12) + "（高松市）",
            "地".repeat(12) + "（ 高松市）",
        ] {
            let lines = line_texts(&text, 17).unwrap();
            assert_eq!(lines.len(), 2);
            let first_last = lines[0].graphemes(true).last().unwrap();
            let second_first = lines[1].graphemes(true).next().unwrap();
            assert!(
                !prohibited_end(first_last),
                "行末に開き括弧を残さない: {lines:?}"
            );
            assert!(
                !prohibited_start(second_first),
                "行頭に句読点や閉じ括弧を置かない: {lines:?}"
            );
            assert_eq!(
                lines.concat(),
                text,
                "禁則のための折り返しで名称を欠落させない"
            );
            assert!(
                lines
                    .iter()
                    .all(|line| shape_line(line, 17).unwrap().width <= MAX_WIDTH)
            );
        }
    }

    #[test]
    fn 長名だけは一行に収まる短縮名を優先し大きすぎる短縮名を採用しない() {
        let long_name = "瀬戸内海国立公園高松地区自然観察施設";
        let mut label = candidate(1, 128.0, 128.0, long_name, 1);
        label
            .names
            .insert("short_name".into(), "自然観察施設".into());
        assert_eq!(
            display_name_for(&label, LabelLanguage::Ja, 17).unwrap(),
            Some("自然観察施設")
        );
        label.names.insert("name".into(), "高松市".into());
        assert_eq!(
            display_name_for(&label, LabelLanguage::Ja, 17).unwrap(),
            Some("高松市")
        );
        label.names.insert("name".into(), long_name.into());
        label.names.insert("short_name".into(), long_name.repeat(3));
        assert_eq!(
            display_name_for(&label, LabelLanguage::Ja, 17).unwrap(),
            Some(long_name)
        );
    }

    #[test]
    fn 小集落と小字も高ズームで描画する() {
        for (id, category, minimum) in [
            (1, "place.isolated_dwelling", 15),
            (2, "place.locality", 13),
        ] {
            assert!(label_style(category, minimum - 1).is_none());
            assert!(label_style(category, minimum).is_some());
            let mut label = candidate(id, 128.0, 128.0, "山の集落", 1);
            label.category = category.into();
            assert!(
                draw(&connection(&[label]), tile(), 256)
                    .data()
                    .iter()
                    .any(|&byte| byte != 0)
                    == (tile().z >= minimum)
            );
        }
    }

    #[test]
    fn 外側で隠れる上位の原候補も競合として残す() {
        let low = candidate(1, 210.0, 130.0, "地名地名地名", 1);
        let middle = candidate(2, 290.0, 130.0, "地名地名地名", 2);
        let high = candidate(3, 370.0, 130.0, "地名地名地名", 3);
        assert!(
            draw(&connection(&[low.clone()]), tile(), 256)
                .data()
                .iter()
                .any(|&byte| byte != 0)
        );
        let with_high = draw(&connection(&[low.clone(), high.clone()]), tile(), 256);
        assert!(with_high.data().iter().any(|&byte| byte != 0));
        let connection = connection(&[low, middle, high]);
        let result = draw(&connection, tile(), 256);
        assert!(result.data().iter().all(|&byte| byte == 0));
        assert!(
            result.data() == crop(&draw(&connection, tile(), 512), 0, 0),
            "外側の競合が大きな描画窓でも一致する"
        );
    }

    #[test]
    fn 可視文字の反対側へ離れた長名の競合も四隅の窓で一致する() {
        let long_name = "地".repeat(13);
        for (visible_x, blocker_x) in [(151.0, -80.0), (361.0, 592.0)] {
            for y in [251.5, 260.5] {
                let low = candidate(1, visible_x, y, &long_name, 1);
                let high = candidate(2, blocker_x, y, &long_name, 2);
                let conn = connection(&[low.clone(), high]);
                let quad = draw(&conn, tile(), 512);
                for dy in 0..2 {
                    for dx in 0..2 {
                        let current = TileId::new(tile().z, tile().x + dx, tile().y + dy).unwrap();
                        assert!(
                            draw(&conn, current, 256).data() == crop(&quad, dx * 256, dy * 256),
                            "外側競合を含めた文字の四隅が一致しません: visible_x={visible_x}, y={y}, tile={current}"
                        );
                    }
                }
                // 代表点と反対側のタイルに低順位名の一部が見えることを確認する。
                // 高順位名はこの列には入らず、競合後は低順位名だけが消える。
                let dx = if visible_x < 256.0 { 1 } else { 0 };
                let lone = connection(&[low]);
                let mut visible = false;
                for dy in 0..2 {
                    let current = TileId::new(tile().z, tile().x + dx, tile().y + dy).unwrap();
                    visible |= draw(&lone, current, 256)
                        .data()
                        .iter()
                        .any(|&byte| byte != 0);
                    assert!(
                        draw(&conn, current, 256)
                            .data()
                            .iter()
                            .all(|&byte| byte == 0),
                        "代表点が遠い上位名との競合で低順位名を消せません: {current}"
                    );
                }
                assert!(visible, "反例の長名がタイル境界を越えていません");
            }
        }
    }

    #[test]
    fn 外側競合の照会範囲は上下左右に三半径と丸めの余白を持つ() {
        let viewport = Rect {
            min_x: 10_000.25,
            max_x: 10_256.25,
            min_y: 20_000.75,
            max_y: 20_256.75,
        };
        let scale = 256.0 * 16384.0;
        let query = label_query_bounds(viewport, scale);
        let needed = 3.0 * MAX_HALF_EXTENT + 2.0 * COLLISION_PADDING + 2.0 + 1.0 / POSITION_GRID;
        assert!(query.min_x * scale <= viewport.min_x - needed);
        assert!(query.max_x * scale >= viewport.max_x + needed);
        assert!(query.min_y * scale <= viewport.min_y - needed);
        assert!(query.max_y * scale >= viewport.max_y + needed);
        assert_eq!((query.min_x * scale / CELL_SIZE).fract(), 0.0);
        assert_eq!((query.min_y * scale / CELL_SIZE).fract(), 0.0);
    }

    #[test]
    fn 世界固定セルの候補上限を窓の外側も含めて適用する() {
        let mut candidates = (1..=16)
            .map(|id| candidate(id, 370.0, 140.0, "町", 100 - id))
            .collect::<Vec<_>>();
        candidates.push(candidate(100, 257.0, 140.0, "町", 1));
        let full = draw(&connection(&candidates), tile(), 256);
        assert!(full.data().iter().all(|&byte| byte == 0));
        candidates.remove(0);
        let reduced = draw(&connection(&candidates), tile(), 256);
        assert!(reduced.data().iter().any(|&byte| byte != 0));
    }

    #[test]
    fn 隣接タイルと大きな窓で文字とセル境界の画素が一致する() {
        let mut candidates = vec![
            candidate(1, 255.75, 190.25, "日本語の境界ラベル", 10000),
            candidate(2, 400.5, 300.5, "瀬戸内海", 9000),
            candidate(3, -15.25, 70.75, "外側に代表点", 8000),
        ];
        for id in 10..60 {
            candidates.push(candidate(
                id,
                245.0 + (id % 5) as f64 * 21.0,
                10.0 + (id / 5) as f64 * 8.0,
                "町",
                100 - id,
            ));
        }
        let conn = connection(&candidates);
        let quad = draw(&conn, tile(), 512);
        for y in 0..2 {
            for x in 0..2 {
                let current = TileId::new(tile().z, tile().x + x, tile().y + y).unwrap();
                assert!(
                    draw(&conn, current, 256).data() == crop(&quad, x * TILE_SIZE, y * TILE_SIZE),
                    "文字の境界画素が異なります: {current}"
                );
            }
        }
        candidates.reverse();
        assert!(
            quad.data() == draw(&connection(&candidates), tile(), 512).data(),
            "候補の入力順で画素が変化しました"
        );
    }

    #[test]
    fn 取消済みの文字描画は候補を取得する前に停止する() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let context = OperationContext::new(cancellation);
        let mut image = Pixmap::new(256, 256).unwrap();
        assert!(
            draw_labels(
                &rusqlite::Connection::open_in_memory().unwrap(),
                tile(),
                256,
                256,
                LabelLanguage::Ja,
                &mut image,
                &context
            )
            .is_err()
        );
    }
}
