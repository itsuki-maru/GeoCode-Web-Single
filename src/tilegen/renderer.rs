use std::mem::size_of;

use anyhow::{Context, Result, ensure};
use tiny_skia::{Color, FillRule, IntRect, Paint, PathBuilder, Pixmap, Transform};

use crate::tilegen::geometry::{Point, Rect, clip_segment};
use crate::tilegen::style::{RoadAttributes, Style};
use crate::tilegen::tile::{TILE_SIZE, TileId};

const MAX_CANDIDATES: usize = 1_000_000;
const MAX_CANDIDATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_POINTS: usize = 1_000_000;
const MAX_EDGE_PX: f64 = 16.0;
// 1つのWay・描画段階だけを対象とする。走査用の辺を作る前の点は、各8バイトとパス命令を使う。
const MAX_OUTLINE_POINTS: usize = 8_000_000;
const CHECK_INTERVAL: usize = 1024;

#[derive(Debug, Clone, Copy)]
pub struct Candidate {
    pub id: i64,
    pub osm_way_id: i64,
    pub attrs: RoadAttributes,
}

pub fn query_rect(tile: TileId, style: &Style) -> Rect {
    tile.bounds().expand(
        f64::from(style.buffer(tile.z)) / (f64::from(TILE_SIZE) * 2_f64.powi(tile.z.into())),
    )
}

/// 形状の使用量を一定範囲に保つため、各地物・描画段階につき一度ローダーを呼ぶ。
pub fn render_tile(
    tile: TileId,
    style: &Style,
    candidates: &[Candidate],
    load: impl FnMut(i64) -> Result<Vec<Point>>,
) -> Result<Pixmap> {
    render_window(tile, TILE_SIZE, TILE_SIZE, style, candidates, load)
}

/// 形状処理を上限付きの単位へ分け、その間に操作の状態を協調的に検査する。
/// ソート・メモリ確保・tiny-skiaのラスタ化は前後で検査するが、
/// それらの内部処理をこのコールバックで中断することはできない。
pub(crate) fn render_tile_with_check(
    tile: TileId,
    style: &Style,
    candidates: &[Candidate],
    load: impl FnMut(i64) -> Result<Vec<Point>>,
    check: impl FnMut() -> Result<()>,
) -> Result<Pixmap> {
    render_window_with_check(tile, TILE_SIZE, TILE_SIZE, style, candidates, load, check)
}

/// 品質検証の基準専用。固定の2×2タイル領域に余白を加えて検索する。
/// 個々の4タイルの検索とは独立して呼び出す。
pub fn query_quad_rect(tile: TileId, style: &Style) -> Result<Rect> {
    let bottom_right = quad_bottom_right(tile)?;
    let first = tile.bounds();
    let last = bottom_right.bounds();
    Ok(Rect {
        min_x: first.min_x,
        min_y: first.min_y,
        max_x: last.max_x,
        max_y: last.max_y,
    }
    .expand(f64::from(style.buffer(tile.z)) / (f64::from(TILE_SIZE) * 2_f64.powi(tile.z.into()))))
}

/// 品質検証の基準専用。描画済みタイルを結合せず、512pxを直接描画する。
/// 候補数・形状量・ラスタ分割に対する既存の上限は引き続き適用する。
pub fn render_quad(
    tile: TileId,
    style: &Style,
    candidates: &[Candidate],
    load: impl FnMut(i64) -> Result<Vec<Point>>,
) -> Result<Pixmap> {
    quad_bottom_right(tile)?;
    render_window(tile, 2 * TILE_SIZE, 2 * TILE_SIZE, style, candidates, load)
}

fn quad_bottom_right(tile: TileId) -> Result<TileId> {
    TileId::new(tile.z, tile.x, tile.y)?;
    TileId::new(tile.z, tile.x + 1, tile.y + 1)
        .context("QA 2x2 window must stay inside the XYZ world")
}

fn render_window(
    tile: TileId,
    width: u32,
    height: u32,
    style: &Style,
    candidates: &[Candidate],
    load: impl FnMut(i64) -> Result<Vec<Point>>,
) -> Result<Pixmap> {
    render_window_with_check(tile, width, height, style, candidates, load, || Ok(()))
}

#[allow(clippy::too_many_arguments)]
fn render_window_with_check(
    tile: TileId,
    width: u32,
    height: u32,
    style: &Style,
    candidates: &[Candidate],
    mut load: impl FnMut(i64) -> Result<Vec<Point>>,
    mut check: impl FnMut() -> Result<()>,
) -> Result<Pixmap> {
    check()?;
    TileId::new(tile.z, tile.x, tile.y)?;
    ensure!(
        candidates.len() <= MAX_CANDIDATES,
        "too many rendering candidates for {tile}"
    );
    ensure!(
        candidates
            .len()
            .checked_mul(size_of::<Candidate>() + size_of::<&Candidate>())
            .is_some_and(|bytes| bytes <= MAX_CANDIDATE_BYTES),
        "candidate byte budget exceeded for {tile}"
    );
    let query_buffer = style.buffer(tile.z);
    // raster_partsは検索矩形の外側にも、規則に従う短い辺を最大2本保持する。
    // その輪郭全体もビットマップ内へ収める。タイルごとに異なるビットマップ境界で
    // 辺を切ると、アンチエイリアスの固定小数点走査がリセットされるためである。
    let buffer = if query_buffer == 0 {
        0
    } else {
        query_buffer
            + 2 * MAX_EDGE_PX as u32
            + (style.max_outer_width(tile.z) / 2.0).ceil() as u32
            + 1
    };
    let mut pixmap =
        Pixmap::new(width + 2 * buffer, height + 2 * buffer).context("cannot allocate raster")?;
    let [r, g, b, a] = Style::BACKGROUND;
    pixmap.fill(Color::from_rgba8(r, g, b, a));
    check()?;
    if style.max_outer_width(tile.z) == 0.0 {
        return Ok(pixmap);
    }
    let n = 2_f64.powi(tile.z.into());
    let scale = f64::from(TILE_SIZE) * n;
    let origin = Point {
        x: f64::from(tile.x) / n,
        y: f64::from(tile.y) / n,
    };
    let rect = Rect {
        min_x: origin.x,
        min_y: origin.y,
        max_x: origin.x + f64::from(width) / scale,
        max_y: origin.y + f64::from(height) / scale,
    }
    .expand(f64::from(query_buffer) / scale);
    let mut ordered = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if index.is_multiple_of(CHECK_INTERVAL) {
            check()?;
        }
        if style.visible(candidate.attrs, tile.z) {
            ordered.push(candidate);
        }
    }
    check()?;
    ordered.sort_unstable_by_key(|candidate| {
        (
            candidate.attrs.effective_layer,
            candidate.attrs.structure_rank,
            candidate.attrs.road_class.priority(),
            candidate.osm_way_id,
            candidate.id,
        )
    });
    check()?;
    let mut first = 0;
    while first < ordered.len() {
        check()?;
        let group = (
            ordered[first].attrs.effective_layer,
            ordered[first].attrs.structure_rank,
        );
        let mut last = first + 1;
        while last < ordered.len()
            && (
                ordered[last].attrs.effective_layer,
                ordered[last].attrs.structure_rank,
            ) == group
        {
            if last.is_multiple_of(CHECK_INTERVAL) {
                check()?;
            }
            last += 1;
        }
        for casing in [true, false] {
            check()?;
            for candidate in &ordered[first..last] {
                check()?;
                let points = load(candidate.id).with_context(|| {
                    format!("geometry for Way {} in {tile}", candidate.osm_way_id)
                })?;
                check()?;
                ensure!(
                    points.len() <= MAX_POINTS,
                    "Way {} exceeds point budget",
                    candidate.osm_way_id
                );
                for (index, point) in points.iter().enumerate() {
                    if index.is_multiple_of(CHECK_INTERVAL) {
                        check()?;
                    }
                    ensure!(
                        point.x.is_finite() && point.y.is_finite(),
                        "non-finite coordinate in Way {}",
                        candidate.osm_way_id
                    );
                }
                let mut builder = PathBuilder::new();
                let mut outline_points = 0_usize;
                let radius = f64::from(if casing {
                    style.outer_width(candidate.attrs, tile.z)
                } else {
                    style.width(candidate.attrs, tile.z)
                }) / 2.0;
                for part in raster_parts(&points, rect, scale, &mut check)? {
                    check()?;
                    for (index, pair) in part.windows(2).enumerate() {
                        if index.is_multiple_of(CHECK_INTERVAL) {
                            check()?;
                        }
                        append_rectangle(
                            &mut builder,
                            pair[0],
                            pair[1],
                            scale,
                            radius,
                            tile,
                            buffer,
                            &mut outline_points,
                        )?;
                    }
                }
                append_round_vertices(
                    &mut builder,
                    &points,
                    rect,
                    scale,
                    radius,
                    tile,
                    buffer,
                    &mut outline_points,
                    &mut check,
                )?;
                check()?;
                let Some(path) = builder.finish() else {
                    continue;
                };
                let mut paint = Paint::default();
                let [r, g, b, a] = style.color(candidate.attrs, casing);
                paint.set_color_rgba8(r, g, b, a);
                paint.anti_alias = true;
                check()?;
                pixmap.fill_path(
                    &path,
                    &paint,
                    FillRule::Winding,
                    Transform::identity(),
                    None,
                );
                check()?;
            }
        }
        first = last;
    }
    check()?;
    let cropped = pixmap
        .clone_rect(
            IntRect::from_xywh(buffer as i32, buffer as i32, width, height)
                .context("invalid output rectangle")?,
        )
        .context("cannot crop output tile")?;
    check()?;
    Ok(cropped)
}

fn reserve_outline_points(count: &mut usize, additional: usize) -> Result<()> {
    *count = count
        .checked_add(additional)
        .context("outline vertex count overflow")?;
    ensure!(
        *count <= MAX_OUTLINE_POINTS,
        "flattened stroke exceeds outline vertex budget"
    );
    Ok(())
}

/// タイル単位の整数平行移動を行う前に、最終輪郭の頂点を格子へ合わせる。
/// 各座標の丸めによる変位は最大1/8192ピクセル。可視座標に短い辺の余白を加えても
/// 十分小さい範囲に収まるため、変換後のf32で正確に表せる。
fn outline_pixel(point: Point, tile: TileId, buffer: u32) -> (f32, f32) {
    const GRID: f64 = 4096.0;
    let x = (point.x * GRID).round() / GRID;
    let y = (point.y * GRID).round() / GRID;
    (
        (x - f64::from(tile.x * TILE_SIZE) + f64::from(buffer)) as f32,
        (y - f64::from(tile.y * TILE_SIZE) + f64::from(buffer)) as f32,
    )
}

/// 丸い線は、辺に沿う長方形と元の頂点に置く扇形の和集合で構成する。
/// 同じ向きの輪郭を巻き数規則で1回塗りつぶし、重なり部分も一度だけ塗る。
#[allow(clippy::too_many_arguments)]
fn append_rectangle(
    builder: &mut PathBuilder,
    a: Point,
    b: Point,
    scale: f64,
    radius: f64,
    tile: TileId,
    buffer: u32,
    count: &mut usize,
) -> Result<()> {
    let dx = (b.x - a.x) * scale;
    let dy = (b.y - a.y) * scale;
    let length = libm::sqrt(dx * dx + dy * dy);
    if length == 0.0 {
        return Ok(());
    }
    let nx = -dy / length * radius;
    let ny = dx / length * radius;
    let a = Point {
        x: a.x * scale,
        y: a.y * scale,
    };
    let b = Point {
        x: b.x * scale,
        y: b.y * scale,
    };
    reserve_outline_points(count, 4)?;
    for (index, point) in [
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
    ]
    .into_iter()
    .enumerate()
    {
        let (x, y) = outline_pixel(point, tile, buffer);
        if index == 0 {
            builder.move_to(x, y);
        } else {
            builder.line_to(x, y);
        }
    }
    builder.close();
    Ok(())
}

/// f32へ変換する前に、頂点を基準に固定した座標系で曲線を折れ線へ変換する。
/// タイル局所座標で3次曲線を折れ線化すると、256pxの移動後に4×4のアンチエイリアスが変わり得る。
/// 多角形の半径方向の誤差は1/256px以下、世界座標格子への丸めによる追加誤差は各軸1/8192px以下。
#[allow(clippy::too_many_arguments)]
fn append_round_sector(
    builder: &mut PathBuilder,
    center: Point,
    radius: f64,
    start: f64,
    sweep: f64,
    tile: TileId,
    buffer: u32,
    count: &mut usize,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    const FLATNESS: f64 = 1.0 / 256.0;
    let angle_limit = 2.0 * libm::acos((1.0 - FLATNESS / radius).clamp(-1.0, 1.0));
    let steps = (sweep.abs() / angle_limit).ceil().max(1.0) as usize;
    reserve_outline_points(count, steps + 2)?;
    let (x, y) = outline_pixel(center, tile, buffer);
    builder.move_to(x, y);
    for step in 0..=steps {
        if step.is_multiple_of(CHECK_INTERVAL) {
            check()?;
        }
        let angle = start + sweep * step as f64 / steps as f64;
        let point = Point {
            x: center.x + radius * libm::cos(angle),
            y: center.y + radius * libm::sin(angle),
        };
        let (x, y) = outline_pixel(point, tile, buffer);
        builder.line_to(x, y);
    }
    builder.close();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_round_vertices(
    builder: &mut PathBuilder,
    points: &[Point],
    rect: Rect,
    scale: f64,
    radius: f64,
    tile: TileId,
    buffer: u32,
    count: &mut usize,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    let mut vertices = Vec::with_capacity(points.len());
    for (index, &point) in points.iter().enumerate() {
        if index.is_multiple_of(CHECK_INTERVAL) {
            check()?;
        }
        if vertices.last() != Some(&point) {
            vertices.push(point);
        }
    }
    if vertices.len() < 2 {
        return Ok(());
    }
    for (index, &point) in vertices.iter().enumerate() {
        if index.is_multiple_of(CHECK_INTERVAL) {
            check()?;
        }
        // 拡張した表示範囲には半径とアンチエイリアスの余白を含める。
        // 範囲外の頂点が端部や接合部を通じて切り抜き後の出力へ影響することはない。
        if !rect.contains(point) {
            continue;
        }
        let center = Point {
            x: point.x * scale,
            y: point.y * scale,
        };
        let incoming = (index > 0).then(|| Point {
            x: point.x - vertices[index - 1].x,
            y: point.y - vertices[index - 1].y,
        });
        let outgoing = (index + 1 < vertices.len()).then(|| Point {
            x: vertices[index + 1].x - point.x,
            y: vertices[index + 1].y - point.y,
        });
        let (start, sweep) = match (incoming, outgoing) {
            (None, Some(direction)) => (
                libm::atan2(direction.y, direction.x) - std::f64::consts::FRAC_PI_2,
                -std::f64::consts::PI,
            ),
            (Some(direction), None) => (
                libm::atan2(direction.y, direction.x) + std::f64::consts::FRAC_PI_2,
                -std::f64::consts::PI,
            ),
            (Some(a), Some(b)) => {
                let length_a = libm::sqrt(a.x * a.x + a.y * a.y);
                let length_b = libm::sqrt(b.x * b.x + b.y * b.y);
                let turn =
                    libm::acos(((a.x * b.x + a.y * b.y) / (length_a * length_b)).clamp(-1.0, 1.0));
                if turn < 1e-12 {
                    continue;
                }
                let start = if a.x * b.y - a.y * b.x >= 0.0 {
                    libm::atan2(b.y, b.x) - std::f64::consts::FRAC_PI_2
                } else {
                    libm::atan2(a.y, a.x) + std::f64::consts::FRAC_PI_2
                };
                (start, -turn)
            },
            _ => continue,
        };
        append_round_sector(
            builder, center, radius, start, sweep, tile, buffer, count, check,
        )?;
    }
    Ok(())
}

/// 規則に従う短い辺をタイル間で共通に保つ。走査変換では辺に沿って固定小数点の
/// 丸めが積み重なるため、タイルごとに異なる切断点でリセットすると継ぎ目が生じる。
/// 分割位置は元の線分とズームだけで決め、タイルには依存させない。
fn raster_parts(
    points: &[Point],
    rect: Rect,
    scale: f64,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Vec<Vec<Point>>> {
    let mut paths = Vec::new();
    let mut current = Vec::new();
    let mut raster_points = 0_usize;
    for (index, pair) in points.windows(2).enumerate() {
        if index.is_multiple_of(CHECK_INTERVAL) {
            check()?;
        }
        let (a, b) = (pair[0], pair[1]);
        let Some((enter, exit)) = clip_segment(a, b, rect) else {
            if !current.is_empty() {
                paths.push(std::mem::take(&mut current));
            }
            continue;
        };
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let span = dx.abs().max(dy.abs()) * scale;
        ensure!(span.is_finite(), "geometry span overflow");
        if span == 0.0 {
            continue;
        }
        let steps = (span / MAX_EDGE_PX).ceil().max(1.0) as u64;
        let parameter = |p: Point| {
            if dx.abs() >= dy.abs() {
                (p.x - a.x) / dx
            } else {
                (p.y - a.y) / dy
            }
        };
        let start =
            ((parameter(enter).clamp(0.0, 1.0) * steps as f64).floor() as u64).saturating_sub(1);
        let end = ((parameter(exit).clamp(0.0, 1.0) * steps as f64).ceil() as u64)
            .saturating_add(1)
            .min(steps);
        let at = |i: u64| {
            if i == 0 {
                a
            } else if i == steps {
                b
            } else {
                let t = i as f64 / steps as f64;
                Point {
                    x: a.x + t * dx,
                    y: a.y + t * dy,
                }
            }
        };
        let first = at(start);
        if current.last().is_some_and(|last| *last != first) {
            paths.push(std::mem::take(&mut current));
        }
        if current.is_empty() {
            current.push(first);
        }
        let additional = usize::try_from(end - start)?.saturating_add(1);
        raster_points = raster_points
            .checked_add(additional)
            .context("raster vertex count overflow")?;
        ensure!(
            raster_points <= MAX_POINTS,
            "subdivided geometry exceeds raster vertex budget"
        );
        for (index, i) in (start + 1..=end).enumerate() {
            if index.is_multiple_of(CHECK_INTERVAL) {
                check()?;
            }
            current.push(at(i));
        }
    }
    if !current.is_empty() {
        paths.push(current);
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::tilegen::style::normalize_tags;

    fn candidate(id: i64, highway: &str, bridge: bool) -> Candidate {
        let mut tags = BTreeMap::from([("highway".into(), highway.into())]);
        if bridge {
            tags.insert("bridge".into(), "yes".into());
        }
        Candidate {
            id,
            osm_way_id: id,
            attrs: normalize_tags(&tags).unwrap(),
        }
    }

    fn from_pixels(tile: TileId, pixels: &[(f64, f64)]) -> Vec<Point> {
        let n = 2_f64.powi(tile.z.into());
        pixels
            .iter()
            .map(|&(x, y)| Point {
                x: (f64::from(tile.x) + x / 256.0) / n,
                y: (f64::from(tile.y) + y / 256.0) / n,
            })
            .collect()
    }

    #[test]
    fn background_zoom_does_not_load_geometry() {
        let image = render_tile(
            TileId::new(5, 0, 0).unwrap(),
            &Style::roads_v1(),
            &[],
            |_| panic!("unexpected load"),
        )
        .unwrap();
        assert_eq!((image.width(), image.height()), (256, 256));
        assert!(
            image
                .data()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| *pixel == Style::BACKGROUND)
        );
    }

    #[test]
    fn stroke_outside_centerline_and_group_casings_are_visible() {
        let tile = TileId::new(18, 131072, 131072).unwrap();
        let style = Style::roads_v1();
        let outer = from_pixels(tile, &[(-2.0, -100.0), (-2.0, 400.0)]);
        let image = render_tile(tile, &style, &[candidate(1, "motorway", false)], |_| {
            Ok(outer.clone())
        })
        .unwrap();
        assert_ne!(
            image.pixel(0, 128).unwrap().demultiply().red(),
            Style::BACKGROUND[0]
        );
        let horizontal = from_pixels(tile, &[(-100.0, 128.0), (400.0, 128.0)]);
        let vertical = from_pixels(tile, &[(128.0, -100.0), (128.0, 400.0)]);
        let candidates = [
            candidate(1, "motorway", false),
            candidate(2, "motorway", false),
        ];
        let crossing = render_tile(tile, &style, &candidates, |id| {
            Ok(if id == 1 {
                vertical.clone()
            } else {
                horizontal.clone()
            })
        })
        .unwrap();
        assert_eq!(
            crossing.pixel(128, 133).unwrap().demultiply().red(),
            Style::ROAD[0]
        );
        assert!(
            crossing
                .data()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 255)
        );
    }

    #[test]
    fn bridge_layer_and_candidate_permutations_are_deterministic() {
        let tile = TileId::new(18, 131072, 131072).unwrap();
        let style = Style::roads_v1();
        let horizontal = from_pixels(tile, &[(-100.0, 128.0), (400.0, 128.0)]);
        let vertical = from_pixels(tile, &[(128.0, -100.0), (128.0, 400.0)]);
        let candidates = [candidate(1, "path", true), candidate(2, "motorway", false)];
        let load = |id| {
            Ok(if id == 1 {
                vertical.clone()
            } else {
                horizontal.clone()
            })
        };
        let a = render_tile(tile, &style, &candidates, load).unwrap();
        let b = render_tile(tile, &style, &[candidates[1], candidates[0]], load).unwrap();
        assert_eq!(a.data(), b.data());
        assert!(
            a.pixel(128, 128)
                .unwrap()
                .demultiply()
                .red()
                .abs_diff(Style::PATH[0])
                <= 1
        );
    }

    #[test]
    fn adjacent_tiles_match_same_zoom_large_region() {
        let tile = TileId::new(22, 2097152, 2097152).unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false), candidate(2, "path", true)];
        let main = from_pixels(
            tile,
            &[
                (-200.0, 10.25),
                (100.25, 140.125),
                (450.2, 120.7),
                (620.0, 460.0),
            ],
        );
        let bridge = from_pixels(tile, &[(10.5, -150.0), (310.75, 620.0)]);
        let load = |id| {
            Ok(if id == 1 {
                main.clone()
            } else {
                bridge.clone()
            })
        };
        let large = render_window(tile, 512, 512, &style, &candidates, load).unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                let part = render_tile(
                    TileId::new(tile.z, tile.x + dx, tile.y + dy).unwrap(),
                    &style,
                    &candidates,
                    load,
                )
                .unwrap();
                for y in 0..256_u32 {
                    for x in 0..256_u32 {
                        if (254..=257).contains(&(x + dx * 256))
                            || (254..=257).contains(&(y + dy * 256))
                        {
                            let p = part.pixel(x, y).unwrap().demultiply();
                            let q = large
                                .pixel(x + dx * 256, y + dy * 256)
                                .unwrap()
                                .demultiply();
                            for (a, b) in [
                                (p.red(), q.red()),
                                (p.green(), q.green()),
                                (p.blue(), q.blue()),
                                (p.alpha(), q.alpha()),
                            ] {
                                assert!(
                                    a.abs_diff(b) <= 1,
                                    "seam mismatch at {},{}: {a} vs {b}",
                                    x + dx * 256,
                                    y + dy * 256
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn long_segment_subdivision_is_local_and_matches_tiles() {
        let tile = TileId::new(22, 2_097_152, 2_097_152).unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false)];
        let points = from_pixels(
            tile,
            &[(-50_000_000.0, -18_499_800.0), (50_000_000.0, 18_500_200.0)],
        );
        let parts = raster_parts(
            &points,
            query_rect(tile, &style),
            256.0 * 2_f64.powi(tile.z.into()),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(parts.iter().map(Vec::len).sum::<usize>() < 100);
        let large =
            render_window(tile, 512, 512, &style, &candidates, |_| Ok(points.clone())).unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                let small = render_tile(
                    TileId::new(tile.z, tile.x + dx, tile.y + dy).unwrap(),
                    &style,
                    &candidates,
                    |_| Ok(points.clone()),
                )
                .unwrap();
                for y in 0..256 {
                    for x in 0..256 {
                        let a = small.pixel(x, y).unwrap().demultiply();
                        let b = large
                            .pixel(x + dx * 256, y + dy * 256)
                            .unwrap()
                            .demultiply();
                        for (u, v) in [
                            (a.red(), b.red()),
                            (a.green(), b.green()),
                            (a.blue(), b.blue()),
                        ] {
                            assert!(
                                u.abs_diff(v) <= 1,
                                "long segment mismatch at {},{}",
                                x + dx * 256,
                                y + dy * 256
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn seam_tolerance_holds_for_different_slopes_and_odd_tile_origin() {
        let tile = TileId::new(22, 2_097_153, 2_097_153).unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false)];
        for slope in [0.03125, 0.2, 0.37, 0.71, 1.0, 1.413, 3.17, 13.2] {
            let points = from_pixels(
                tile,
                &[
                    (-1_000_000.0, 200.25 - slope * 1_000_000.0),
                    (1_000_000.0, 200.25 + slope * 1_000_000.0),
                ],
            );
            let large =
                render_window(tile, 512, 512, &style, &candidates, |_| Ok(points.clone())).unwrap();
            for dy in 0..2 {
                for dx in 0..2 {
                    let small = render_tile(
                        TileId::new(tile.z, tile.x + dx, tile.y + dy).unwrap(),
                        &style,
                        &candidates,
                        |_| Ok(points.clone()),
                    )
                    .unwrap();
                    for y in 0..256 {
                        for x in 0..256 {
                            if !(254..=257).contains(&(x + dx * 256))
                                && !(254..=257).contains(&(y + dy * 256))
                            {
                                continue;
                            }
                            let a = small.pixel(x, y).unwrap().demultiply();
                            let b = large
                                .pixel(x + dx * 256, y + dy * 256)
                                .unwrap()
                                .demultiply();
                            for (u, v) in [
                                (a.red(), b.red()),
                                (a.green(), b.green()),
                                (a.blue(), b.blue()),
                            ] {
                                assert!(
                                    u.abs_diff(v) <= 1,
                                    "slope {slope} mismatch at {},{}: {u} vs {v}",
                                    x + dx * 256,
                                    y + dy * 256
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn n05_real_polyline_seam_matches_independent_quad() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            tile: TileId,
            osm_way_id: i64,
            points: Vec<Point>,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../tests/fixtures/tilegen/n05-seam-way944741541-z14.json"
        ))
        .unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(fixture.osm_way_id, "path", false)];
        let reference = render_quad(fixture.tile, &style, &candidates, |_| {
            Ok(fixture.points.clone())
        })
        .unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                let tile =
                    TileId::new(fixture.tile.z, fixture.tile.x + dx, fixture.tile.y + dy).unwrap();
                let image =
                    render_tile(tile, &style, &candidates, |_| Ok(fixture.points.clone())).unwrap();
                for y in 0..256 {
                    for x in 0..256 {
                        let gx = x + 256 * dx;
                        let gy = y + 256 * dy;
                        if (254..=257).contains(&gx) || (254..=257).contains(&gy) {
                            let a = image.pixel(x, y).unwrap().demultiply();
                            let b = reference.pixel(gx, gy).unwrap().demultiply();
                            for (u, v) in [
                                (a.red(), b.red()),
                                (a.green(), b.green()),
                                (a.blue(), b.blue()),
                                (a.alpha(), b.alpha()),
                            ] {
                                assert!(
                                    u.abs_diff(v) <= 1,
                                    "real seam mismatch {gx},{gy}: {u} vs {v}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn round_tube_union_handles_duplicates_retracing_and_collinear_vertices() {
        let tile = TileId::new(18, 131072, 131072).unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false)];
        let render = |pixels: &[(f64, f64)]| {
            render_tile(tile, &style, &candidates, |_| Ok(from_pixels(tile, pixels))).unwrap()
        };
        let straight = render(&[(40.25, 128.375), (220.25, 128.375)]);
        let duplicate = render(&[(40.25, 128.375), (40.25, 128.375), (220.25, 128.375)]);
        let retraced = render(&[(40.25, 128.375), (220.25, 128.375), (40.25, 128.375)]);
        let split = render(&[(40.25, 128.375), (128.25, 128.375), (220.25, 128.375)]);
        assert_eq!(straight.data(), duplicate.data());
        assert_eq!(straight.data(), retraced.data());
        assert_eq!(straight.data(), split.data());
    }

    #[test]
    fn round_tube_preserves_closed_hole_short_cap_and_hairpin() {
        let tile = TileId::new(18, 131072, 131072).unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false)];
        let render = |pixels: &[(f64, f64)]| {
            render_tile(tile, &style, &candidates, |_| Ok(from_pixels(tile, pixels))).unwrap()
        };
        let triangle = render(&[(50.0, 50.0), (200.0, 50.0), (125.0, 200.0), (50.0, 50.0)]);
        assert_eq!(
            triangle.pixel(125, 100).unwrap().demultiply().red(),
            Style::BACKGROUND[0]
        );
        assert_eq!(
            triangle.pixel(125, 50).unwrap().demultiply().red(),
            Style::ROAD[0]
        );
        let tiny = render(&[(128.25, 128.375), (128.2500001, 128.3750001)]);
        assert_eq!(
            tiny.pixel(128, 128).unwrap().demultiply().red(),
            Style::ROAD[0]
        );
        assert_ne!(
            tiny.pixel(131, 128).unwrap().demultiply().red(),
            Style::BACKGROUND[0]
        );
        let hairpin = render(&[(50.25, 100.375), (200.25, 100.375), (50.5, 100.875)]);
        assert_eq!(
            hairpin.pixel(128, 100).unwrap().demultiply().red(),
            Style::ROAD[0]
        );
    }

    #[test]
    fn canonical_outline_is_safe_at_both_world_extremes() {
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false)];
        let render = |coordinate| {
            let tile = TileId::new(22, coordinate, coordinate).unwrap();
            render_tile(tile, &style, &candidates, |_| {
                Ok(from_pixels(
                    tile,
                    &[(32.125, 40.875), (128.375, 180.125), (220.875, 40.375)],
                ))
            })
            .unwrap()
        };
        assert_eq!(render(0).data(), render((1 << 22) - 1).data());
    }

    #[test]
    fn outline_budget_rejects_growth_before_allocating_it() {
        let mut count = MAX_OUTLINE_POINTS - 1;
        assert!(reserve_outline_points(&mut count, 2).is_err());
        let mut count = usize::MAX;
        assert!(reserve_outline_points(&mut count, 1).is_err());
    }

    #[test]
    fn checked_render_preserves_pixels_and_checks_long_geometry_validation() {
        use std::cell::Cell;

        let tile = TileId::new(18, 131072, 131072).unwrap();
        let style = Style::roads_v1();
        let candidates = [candidate(1, "motorway", false)];
        let points = from_pixels(tile, &[(12.5, 30.25), (128.0, 180.75), (240.5, 45.0)]);
        let legacy = render_tile(tile, &style, &candidates, |_| Ok(points.clone())).unwrap();
        let checked =
            render_tile_with_check(tile, &style, &candidates, |_| Ok(points.clone()), || Ok(()))
                .unwrap();
        assert_eq!(legacy.data(), checked.data());

        let loaded = Cell::new(false);
        let checks_after_load = Cell::new(0);
        let cancel = crate::tilegen::cancel::CancellationToken::new();
        let error = render_tile_with_check(
            tile,
            &style,
            &candidates,
            |_| {
                loaded.set(true);
                Ok(vec![points[0]; 20_000])
            },
            || {
                if loaded.get() {
                    checks_after_load.set(checks_after_load.get() + 1);
                    if checks_after_load.get() == 3 {
                        cancel.cancel();
                    }
                }
                cancel.check()
            },
        )
        .unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error));
        assert_eq!(checks_after_load.get(), 3);
    }

    #[test]
    fn segment_scanning_checks_cancellation_even_when_geometry_is_outside() {
        let points = vec![Point { x: 2.0, y: 2.0 }; 20_000];
        let rect = Rect {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 1.0,
            max_y: 1.0,
        };
        let cancel = crate::tilegen::cancel::CancellationToken::new();
        let mut checks = 0;
        let error = raster_parts(&points, rect, 256.0, &mut || {
            checks += 1;
            if checks == 3 {
                cancel.cancel();
            }
            cancel.check()
        })
        .unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error));
        assert_eq!(checks, 3);
    }

    #[test]
    fn subdivision_checks_cancellation_inside_one_long_segment() {
        let points = [Point { x: 0.0, y: 0.5 }, Point { x: 1.0, y: 0.5 }];
        let rect = Rect {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 1.0,
            max_y: 1.0,
        };
        let cancel = crate::tilegen::cancel::CancellationToken::new();
        let mut checks = 0;
        let error = raster_parts(&points, rect, 32_768.0, &mut || {
            checks += 1;
            if checks == 3 {
                cancel.cancel();
            }
            cancel.check()
        })
        .unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error));
        assert_eq!(checks, 3);
    }

    #[test]
    fn duplicate_vertex_scan_checks_cancellation_before_outline_allocation() {
        let tile = TileId::new(18, 131072, 131072).unwrap();
        let points = vec![Point { x: 2.0, y: 2.0 }; 20_000];
        let rect = query_rect(tile, &Style::roads_v1());
        let cancel = crate::tilegen::cancel::CancellationToken::new();
        let mut checks = 0;
        let mut builder = PathBuilder::new();
        let mut count = 0;
        let error = append_round_vertices(
            &mut builder,
            &points,
            rect,
            256.0,
            2.0,
            tile,
            32,
            &mut count,
            &mut || {
                checks += 1;
                if checks == 3 {
                    cancel.cancel();
                }
                cancel.check()
            },
        )
        .unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error));
        assert_eq!(count, 0);
    }
}
