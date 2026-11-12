//! 国土地理院DEMの上限付き読取、固定格子チャンク、等高線と描画用標高参照。

use super::{
    model::{
        ElevationCrs, ElevationDatumPolicy, Feature, FeatureKind, Geometry, SourceInfo,
        UnknownElevationCrs,
    },
    store,
};
use crate::tilegen::{
    geometry::{Point, Rect, project},
    operation::OperationContext,
};
use anyhow::{Context, Result, bail, ensure};
use flate2::{
    Compression,
    read::{DeflateDecoder, ZlibDecoder},
    write::ZlibEncoder,
};
use quick_xml::{Reader, XmlVersion, events::Event};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

const SIDE: usize = 128;
const CELLS: usize = SIDE * SIDE;
const CHUNK_BYTES: usize = CELLS * 5;
const MAX_XML_BYTES: u64 = 128 * 1024 * 1024;
const MAX_HEADER_BYTES: u64 = 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRY_CHARS: usize = 256;
const MAX_GRID_CELLS: usize = 4_000_000;
const MAX_INPUTS: usize = 200_000;
const MAX_LEVEL: u8 = 14;
const MAX_QUERY_CHUNKS: usize = 1024;
const MAX_CONTOUR_SEGMENTS: usize = 262_144;
pub(crate) const EFFECTIVE_SURFACE_POLICY: &str = "source-ground-surface-and-10m-other-v1";

/// 呼出元のトランザクションは所有せず、新規作業DBへの書込だけを有界にまとめる。
pub(crate) struct WriteBatch<'a> {
    connection: &'a Connection,
    owned: bool,
    bytes: usize,
    updates: usize,
}
impl<'a> WriteBatch<'a> {
    pub(crate) fn new(connection: &'a Connection) -> Result<Self> {
        let owned = connection.is_autocommit();
        if owned {
            connection.execute_batch("BEGIN IMMEDIATE")?;
        }
        Ok(Self {
            connection,
            owned,
            bytes: 0,
            updates: 0,
        })
    }
    pub(crate) fn record(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self.bytes.saturating_add(bytes);
        self.updates += 1;
        if self.owned && (self.bytes >= 8 * 1024 * 1024 || self.updates >= 256) {
            self.connection.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
            self.bytes = 0;
            self.updates = 0;
        }
        Ok(())
    }
    pub(crate) fn finish(mut self) -> Result<()> {
        if self.owned {
            self.connection.execute_batch("COMMIT")?;
            self.owned = false;
        }
        Ok(())
    }
}
impl Drop for WriteBatch<'_> {
    fn drop(&mut self) {
        if self.owned {
            let _ = self.connection.execute_batch("ROLLBACK");
        }
    }
}

pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE standard_dem_chunks(
           resolution INTEGER NOT NULL CHECK(resolution BETWEEN 1 AND 36000),
           level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 14),
           cx INTEGER NOT NULL,cy INTEGER NOT NULL,data BLOB NOT NULL,
           PRIMARY KEY(resolution,level,cx,cy)
         ) WITHOUT ROWID;
         CREATE TABLE standard_dem_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )?;
    Ok(())
}

#[derive(Clone)]
struct Chunk {
    values: Vec<f32>,
    mask: Vec<u8>,
}
impl Chunk {
    fn empty() -> Self {
        Self {
            values: vec![0.0; CELLS],
            mask: vec![0; CELLS],
        }
    }
    fn encode(&self) -> Result<Vec<u8>> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        for v in &self.values {
            encoder.write_all(&v.to_le_bytes())?;
        }
        encoder.write_all(&self.mask)?;
        Ok(encoder.finish()?)
    }
    fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(
            bytes.len() <= CHUNK_BYTES + 1024,
            "標高チャンクの圧縮サイズが上限を超えました"
        );
        let mut data = Vec::new();
        ZlibDecoder::new(bytes)
            .take(CHUNK_BYTES as u64 + 1)
            .read_to_end(&mut data)?;
        ensure!(
            data.len() == CHUNK_BYTES,
            "標高チャンクの展開サイズが不正です"
        );
        let values = data[..CELLS * 4]
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect::<Vec<_>>();
        let mask = data[CELLS * 4..].to_vec();
        ensure!(
            mask.iter().all(|&m| m <= 2) && values.iter().all(|v| v.is_finite()),
            "標高チャンクに不正な値があります"
        );
        Ok(Self { values, mask })
    }
}

fn load_chunk(
    connection: &Connection,
    resolution: u32,
    level: u8,
    cx: i64,
    cy: i64,
) -> Result<Option<Chunk>> {
    let mut statement=connection.prepare("SELECT length(data),data FROM standard_dem_chunks WHERE resolution=? AND level=? AND cx=? AND cy=?")?;
    let mut rows = statement.query(params![resolution, level, cx, cy])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let length: i64 = row.get(0)?;
    ensure!(
        (1..=(CHUNK_BYTES + 1024) as i64).contains(&length),
        "標高チャンクの保存サイズが不正です"
    );
    Ok(Some(Chunk::decode(&row.get::<_, Vec<u8>>(1)?)?))
}
fn save_chunk(
    connection: &Connection,
    resolution: u32,
    level: u8,
    cx: i64,
    cy: i64,
    chunk: &Chunk,
) -> Result<()> {
    if chunk.mask.iter().any(|&v| v != 0) {
        connection.execute(
            "INSERT OR REPLACE INTO standard_dem_chunks VALUES(?,?,?,?,?)",
            params![resolution, level, cx, cy, chunk.encode()?],
        )?;
    }
    Ok(())
}

#[derive(Debug)]
struct Grid {
    resolution: u32,
    x0: i64,
    y0: i64,
    width: usize,
    height: usize,
    values: Vec<f32>,
    mask: Vec<u8>,
    crs: ElevationCrs,
}

#[derive(Debug)]
struct GridHeader {
    resolution: u32,
    x0: i64,
    y0: i64,
    width: usize,
    height: usize,
    crs: ElevationCrs,
    lower: [f64; 2],
    upper: [f64; 2],
    declared_type: Option<String>,
}

enum ParsedDem {
    None,
    Header(GridHeader),
    Grid(Grid),
}

/// 公式の格子は北西始点で西から東、次いで北から南のセル中心を表す。
fn parse_grid(input: impl BufRead, context: &OperationContext) -> Result<Option<Grid>> {
    match parse_dem(input, context, false)? {
        ParsedDem::Grid(grid) => Ok(Some(grid)),
        ParsedDem::None => Ok(None),
        ParsedDem::Header(_) => unreachable!(),
    }
}

fn parse_dem(
    input: impl BufRead,
    context: &OperationContext,
    header_only: bool,
) -> Result<ParsedDem> {
    let mut reader = Reader::from_reader(input);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut stack = Vec::<String>::new();
    let mut text = String::new();
    let mut dem = false;
    let mut crs = None;
    let mut declared_type = None;
    let mut lower = None;
    let mut upper = None;
    let mut low = None;
    let mut high = None;
    let mut start = [0_i64; 2];
    let mut values = Vec::new();
    let mut masks = Vec::new();
    let mut tuple_count = 0_usize;
    loop {
        context.check()?;
        let event = reader
            .read_event_into(&mut buffer)
            .context("DEM XMLを解析できません")?;
        ensure!(
            reader.buffer_position()
                <= if header_only {
                    MAX_HEADER_BYTES
                } else {
                    MAX_XML_BYTES
                },
            "DEM XMLのサイズが128MiBを超えました"
        );
        match event {
            Event::Start(e) => {
                ensure!(stack.len() < 64, "DEM XMLの入れ子が深すぎます");
                let name = String::from_utf8(e.local_name().as_ref().to_vec())?;
                if name == "DEM" {
                    ensure!(!dem, "1つのXMLに複数DEMは指定できません");
                    dem = true;
                }
                if name == "Envelope" {
                    for a in e.attributes() {
                        let a = a?;
                        if a.key.local_name().as_ref() == b"srsName" {
                            crs = Some(
                                a.decoded_and_normalized_value(
                                    XmlVersion::Explicit1_0,
                                    reader.decoder(),
                                )?
                                .into_owned(),
                            );
                        }
                    }
                }
                if name == "sequenceRule" {
                    for a in e.attributes() {
                        let a = a?;
                        if a.key.local_name().as_ref() == b"order" {
                            ensure!(
                                a.decoded_and_normalized_value(
                                    XmlVersion::Explicit1_0,
                                    reader.decoder()
                                )?
                                .split_whitespace()
                                .collect::<String>()
                                    == "+x-y",
                                "未対応のDEM格子走査方向です"
                            );
                        }
                    }
                }
                if name == "Grid" {
                    for a in e.attributes() {
                        let a = a?;
                        if a.key.local_name().as_ref() == b"dimension" {
                            ensure!(
                                a.decoded_and_normalized_value(
                                    XmlVersion::Explicit1_0,
                                    reader.decoder()
                                )?
                                .as_ref()
                                    == "2",
                                "DEM格子は2次元だけに対応しています"
                            );
                        }
                    }
                }
                if name == "tupleList" && dem && header_only {
                    let mut header = grid_header(crs, lower, upper, low, high)?;
                    header.declared_type = declared_type;
                    return Ok(ParsedDem::Header(header));
                }
                stack.push(name);
                text.clear();
            },
            Event::Empty(e) if header_only && dem && e.local_name().as_ref() == b"tupleList" => {
                let mut header = grid_header(crs, lower, upper, low, high)?;
                header.declared_type = declared_type;
                return Ok(ParsedDem::Header(header));
            },
            Event::Text(e) => {
                if stack.last().is_some_and(|s| s == "tupleList") {
                    ensure!(
                        low.is_some() && high.is_some(),
                        "DEM格子数より前に標高配列があります"
                    );
                    let decoded = e.decode()?;
                    for tuple in decoded.split_whitespace() {
                        if tuple_count.is_multiple_of(4096) {
                            context.check()?;
                        }
                        ensure!(tuple_count < MAX_GRID_CELLS, "DEMセル数が上限を超えました");
                        let (kind, number) = tuple
                            .split_once(',')
                            .context("DEM構成点が種別,標高の形式ではありません")?;
                        let v: f32 = number.parse().context("DEM標高が数値ではありません")?;
                        ensure!(v.is_finite(), "DEM標高が有限値ではありません");
                        let mask = match kind {
                            "地表面" | "表層面" => {
                                ensure!((-15000.0..=100000.0).contains(&v), "DEM標高が範囲外です");
                                1
                            },
                            "海水面" | "内水面" => {
                                ensure!((-15000.0..=100000.0).contains(&v), "水面標高が範囲外です");
                                2
                            },
                            // 旧10m標高は地形図由来の有効標高も「その他」で格納する。
                            // XML内のDEM種別で限定し、ファイル名や測地系では推定しない。
                            "その他" if declared_type.as_deref() == Some("10mメッシュ（標高）") =>
                            {
                                ensure!((-15000.0..=100000.0).contains(&v), "DEM標高が範囲外です");
                                1
                            },
                            "データなし" | "海水底面" | "内水底面" | "その他" => 0,
                            _ => bail!("未対応のDEM構成点種別です: {kind}"),
                        };
                        let mask = if v == -9999.0 { 0 } else { mask };
                        values.push(if mask == 0 { 0.0 } else { v });
                        masks.push(mask);
                        tuple_count += 1;
                    }
                } else {
                    let decoded = e.decode()?;
                    ensure!(
                        text.len() + decoded.len() <= 64 * 1024,
                        "DEM属性テキストが長すぎます"
                    );
                    text.push_str(&decoded);
                }
            },
            Event::End(e) => {
                let name = std::str::from_utf8(e.local_name().as_ref())?.to_owned();
                match name.as_str() {
                    "type" if dem => {
                        ensure!(text.len() <= 256, "DEM種別が長すぎます");
                        declared_type = Some(text.trim().to_owned());
                    },
                    "lowerCorner" => lower = Some(pair_f64(&text)?),
                    "upperCorner" => upper = Some(pair_f64(&text)?),
                    "low" => low = Some(pair_i64(&text)?),
                    "high" => high = Some(pair_i64(&text)?),
                    "startPoint" => start = pair_i64(&text)?,
                    "sequenceRule" => ensure!(
                        text.trim() == "Linear",
                        "DEMの配列順序がLinearではありません"
                    ),
                    "axisLabels" => ensure!(
                        text.split_whitespace().collect::<Vec<_>>() == vec!["x", "y"],
                        "未対応のDEM格子軸です"
                    ),
                    _ => (),
                }
                ensure!(
                    stack.pop().as_deref() == Some(name.as_str()),
                    "DEM XMLの要素対応が不正です"
                );
                text.clear();
            },
            Event::DocType(_) | Event::GeneralRef(_) => {
                bail!("DEM XMLのDTD・実体参照には対応していません")
            },
            Event::CData(_) => bail!("DEM XMLのCDATAには対応していません"),
            Event::Decl(e) => {
                ensure!(
                    e.version()?.as_ref() == b"1.0",
                    "DEM XMLは版1.0だけに対応しています"
                );
                if let Some(encoding) = e.encoding() {
                    ensure!(
                        encoding?.as_ref().eq_ignore_ascii_case(b"UTF-8"),
                        "DEM XMLはUTF-8だけに対応しています"
                    );
                }
            },
            Event::Eof => break,
            _ => (),
        }
        buffer.clear();
    }
    ensure!(stack.is_empty(), "DEM XMLが途中で終了しています");
    if !dem {
        return Ok(ParsedDem::None);
    }
    ensure!(
        !header_only,
        "DEMヘッダーにtupleListがありません（ヘッダー上限は1MiBです）"
    );
    let header = grid_header(crs, lower, upper, low, high)?;
    let count = header.width * header.height;
    ensure!(
        start[0] >= 0
            && start[0] < header.width as i64
            && start[1] >= 0
            && start[1] < header.height as i64,
        "DEM開始セルが範囲外です"
    );
    let offset = start[1] as usize * header.width + start[0] as usize;
    ensure!(
        offset + values.len() <= count,
        "DEM構成点数が格子を超えました"
    );
    let mut full_values = vec![0.0; count];
    let mut full_mask = vec![0; count];
    full_values[offset..offset + values.len()].copy_from_slice(&values);
    full_mask[offset..offset + masks.len()].copy_from_slice(&masks);
    Ok(ParsedDem::Grid(Grid {
        resolution: header.resolution,
        x0: header.x0,
        y0: header.y0,
        width: header.width,
        height: header.height,
        values: full_values,
        mask: full_mask,
        crs: header.crs,
    }))
}

fn grid_header(
    crs: Option<String>,
    lower: Option<[f64; 2]>,
    upper: Option<[f64; 2]>,
    low: Option<[i64; 2]>,
    high: Option<[i64; 2]>,
) -> Result<GridHeader> {
    let crs = crs.context("DEMの座標参照系がありません")?.parse()?;
    let lower = lower.context("DEMの南西境界がありません")?;
    let upper = upper.context("DEMの北東境界がありません")?;
    ensure!(
        lower[0] < upper[0]
            && lower[1] < upper[1]
            && lower[0] >= -85.0
            && upper[0] <= 85.0
            && lower[1] >= -180.0
            && upper[1] <= 180.0,
        "DEMの緯度経度境界が不正です"
    );
    let low = low.context("DEM格子のlowがありません")?;
    let high = high.context("DEM格子のhighがありません")?;
    ensure!(
        low == [0, 0] && high.iter().all(|&v| v >= 1 && v < MAX_GRID_CELLS as i64),
        "DEM格子のlow/highが不正です"
    );
    let width = usize::try_from(high[0] + 1)?;
    let height = usize::try_from(high[1] + 1)?;
    let count = width.checked_mul(height).context("DEM格子数が溢れました")?;
    ensure!(count <= MAX_GRID_CELLS, "DEM格子数が上限を超えました");
    let rx = width as f64 / (upper[1] - lower[1]);
    let ry = height as f64 / (upper[0] - lower[0]);
    let resolution = rx.round() as u32;
    ensure!(
        (1..=36000).contains(&resolution)
            && (rx - f64::from(resolution)).abs() < 0.01
            && (ry - rx).abs() < 0.01,
        "未対応のDEM格子間隔です（経緯度の等間隔格子のみ対応）"
    );
    let x0 = ((lower[1] + 180.0) * f64::from(resolution)).round() as i64;
    let y0 = ((90.0 - upper[0]) * f64::from(resolution)).round() as i64;
    ensure!(
        ((lower[1] + 180.0) * f64::from(resolution) - x0 as f64).abs() < 0.001
            && ((90.0 - upper[0]) * f64::from(resolution) - y0 as f64).abs() < 0.001,
        "DEM格子が共通のセル境界に揃っていません"
    );
    Ok(GridHeader {
        resolution,
        x0,
        y0,
        width,
        height,
        crs,
        lower,
        upper,
        declared_type: None,
    })
}
fn pair_f64(text: &str) -> Result<[f64; 2]> {
    let v = text
        .split_whitespace()
        .map(str::parse::<f64>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(
        v.len() == 2 && v.iter().all(|v| v.is_finite()),
        "DEM座標は有限値2つが必要です"
    );
    Ok([v[0], v[1]])
}
fn pair_i64(text: &str) -> Result<[i64; 2]> {
    let v = text
        .split_whitespace()
        .map(str::parse::<i64>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(v.len() == 2, "DEM格子番号は整数2つが必要です");
    Ok([v[0], v[1]])
}

#[derive(Debug, Clone)]
struct Snapshot {
    bytes: u64,
    modified: SystemTime,
}
impl Snapshot {
    fn of(path: &Path) -> Result<Self> {
        let m = fs::metadata(path)?;
        ensure!(m.is_file(), "DEM入力は通常ファイルを指定してください");
        Ok(Self {
            bytes: m.len(),
            modified: m.modified()?,
        })
    }
    fn verify(&self, path: &Path) -> Result<()> {
        let now = Self::of(path)?;
        ensure!(
            self.bytes == now.bytes && self.modified == now.modified,
            "DEM入力が取り込み中に変更されました: {}",
            path.display()
        );
        Ok(())
    }
}
#[derive(Debug, Clone)]
struct XmlInput {
    path: PathBuf,
    entry_name: Option<String>,
    offset: u64,
    compressed: u64,
    bytes: u64,
    method: u16,
    crc: Option<u32>,
    priority: i64,
    snapshot: Snapshot,
    hash: String,
}

impl XmlInput {
    fn label(&self) -> String {
        match &self.entry_name {
            Some(entry) => format!("DEM入力 {} 内の {}", self.path.display(), entry),
            None => format!("DEM入力 {}", self.path.display()),
        }
    }

    fn read_header(&self, context: &OperationContext) -> Result<Option<GridHeader>> {
        let result: Result<Option<GridHeader>> = (|| {
            let parsed = parse_dem(
                BufReader::new(self.reader()?.take(MAX_HEADER_BYTES)),
                context,
                true,
            )?;
            self.snapshot.verify(&self.path)?;
            match parsed {
                ParsedDem::None => Ok(None),
                ParsedDem::Header(header) => Ok(Some(header)),
                ParsedDem::Grid(_) => unreachable!(),
            }
        })();
        result.with_context(|| self.label())
    }

    fn reader(&self) -> Result<Box<dyn Read>> {
        self.snapshot.verify(&self.path)?;
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.offset))?;
        let reader = file.take(self.compressed);
        Ok(match self.method {
            0 => Box::new(reader),
            8 => Box::new(DeflateDecoder::new(reader)),
            _ => bail!("未対応のZIP圧縮方式です"),
        })
    }
    fn read_payload(
        &self,
        context: &OperationContext,
        parse: bool,
    ) -> Result<(Option<Grid>, String)> {
        self.read_payload_inner(context, parse)
            .with_context(|| self.label())
    }

    fn read_payload_inner(
        &self,
        context: &OperationContext,
        parse: bool,
    ) -> Result<(Option<Grid>, String)> {
        ensure!(
            self.bytes <= MAX_XML_BYTES,
            "DEM XMLの展開サイズが上限を超えました"
        );
        let mut reader = VerifiedReader {
            inner: self.reader()?,
            sha: Sha256::new(),
            crc: crc32fast::Hasher::new(),
            bytes: 0,
        };
        let grid = if parse {
            parse_grid(BufReader::new(&mut reader), context)?
        } else {
            let mut block = [0; 64 * 1024];
            loop {
                context.check()?;
                if reader.read(&mut block)? == 0 {
                    break;
                }
            }
            None
        };
        ensure!(
            reader.bytes == self.bytes,
            "DEM XMLのサイズがZIPの宣言と一致しません"
        );
        if let Some(crc) = self.crc {
            ensure!(reader.crc.finalize() == crc, "DEM ZIPのCRCが一致しません");
        }
        let hash = format!("{:x}", reader.sha.finalize());
        self.snapshot.verify(&self.path)?;
        Ok((grid, hash))
    }
}
struct VerifiedReader {
    inner: Box<dyn Read>,
    sha: Sha256,
    crc: crc32fast::Hasher,
    bytes: u64,
}
impl Read for VerifiedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buffer)?;
        self.bytes += n as u64;
        if self.bytes > MAX_XML_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "DEM XMLのサイズが上限を超えました",
            ));
        }
        self.sha.update(&buffer[..n]);
        self.crc.update(&buffer[..n]);
        Ok(n)
    }
}

fn collect_files(
    input: &Path,
    priority: i64,
    depth: usize,
    output: &mut Vec<XmlInput>,
    context: &OperationContext,
) -> Result<()> {
    context.check()?;
    ensure!(
        depth <= 16 && output.len() <= MAX_INPUTS,
        "DEM入力の階層・ファイル数が上限を超えました"
    );
    let meta = fs::symlink_metadata(input)?;
    ensure!(
        !meta.file_type().is_symlink(),
        "DEM入力にシンボリックリンクは指定できません"
    );
    if meta.is_dir() {
        let mut children = fs::read_dir(input)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        ensure!(
            children.len() <= MAX_INPUTS,
            "DEMディレクトリの項目数が多すぎます"
        );
        children.sort();
        for path in children {
            collect_files(&path, priority, depth + 1, output, context)?;
        }
    } else {
        let extension = input
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "xml" | "gml" => {
                let snapshot = Snapshot::of(input)?;
                ensure!(
                    snapshot.bytes <= MAX_XML_BYTES,
                    "DEM XMLのサイズが上限を超えました"
                );
                output.push(XmlInput {
                    path: input.to_owned(),
                    entry_name: None,
                    offset: 0,
                    compressed: snapshot.bytes,
                    bytes: snapshot.bytes,
                    method: 0,
                    crc: None,
                    priority,
                    snapshot,
                    hash: String::new(),
                });
            },
            "zip" => output.extend(zip_inputs(input, priority, context)?),
            "json" if depth == 0 => {
                ensure!(
                    meta.len() <= 8 * 1024 * 1024,
                    "DEM入力一覧JSONが大きすぎます"
                );
                let manifest: Value = serde_json::from_reader(File::open(input)?)?;
                let list = manifest["files"]
                    .as_array()
                    .context("DEM入力一覧にはfiles配列が必要です")?;
                ensure!(list.len() <= MAX_INPUTS, "DEM入力一覧が多すぎます");
                for item in list {
                    let text = item
                        .as_str()
                        .or_else(|| item["path"].as_str())
                        .context("DEM入力一覧にはpathが必要です")?;
                    let path = Path::new(text);
                    let path = if path.is_absolute() {
                        path.to_owned()
                    } else {
                        input.parent().unwrap_or(Path::new(".")).join(path)
                    };
                    let item_priority = match item.get("priority") {
                        None => 0,
                        Some(value) => value
                            .as_i64()
                            .context("DEM入力一覧のpriorityは64bit整数を指定してください")?,
                    };
                    collect_files(&path, item_priority, depth + 1, output, context)?;
                }
            },
            _ if depth == 0 => {
                bail!("DEM入力はZIP/XML/ディレクトリ/入力一覧JSONを指定してください")
            },
            _ => (),
        }
    }
    ensure!(output.len() <= MAX_INPUTS, "DEM XML数が上限を超えました");
    Ok(())
}

fn zip_inputs(path: &Path, priority: i64, context: &OperationContext) -> Result<Vec<XmlInput>> {
    let snapshot = Snapshot::of(path)?;
    ensure!(snapshot.bytes >= 22, "DEM ZIPが短すぎます");
    let mut file = File::open(path)?;
    let tail_len = snapshot.bytes.min(65557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64)))?;
    let mut tail = vec![0; tail_len];
    file.read_exact(&mut tail)?;
    let eocd = (0..=tail.len() - 22)
        .rev()
        .find(|&p| {
            tail[p..p + 4] == [0x50, 0x4b, 0x05, 0x06]
                && p + 22 + le16(&tail[p + 20..]) as usize == tail.len()
        })
        .context("DEM ZIPの終端がありません")?;
    ensure!(
        le16(&tail[eocd + 4..]) == 0 && le16(&tail[eocd + 6..]) == 0,
        "分割ZIPには対応していません"
    );
    let mut entries = u64::from(le16(&tail[eocd + 10..]));
    let mut directory = u64::from(le32(&tail[eocd + 16..]));
    if entries == 65535 || directory == u64::from(u32::MAX) {
        let position = snapshot.bytes - tail_len as u64 + eocd as u64;
        ensure!(position >= 20, "ZIP64 locatorがありません");
        file.seek(SeekFrom::Start(position - 20))?;
        let mut locator = [0; 20];
        file.read_exact(&mut locator)?;
        ensure!(
            le32(&locator) == 0x07064b50 && le32(&locator[4..]) == 0 && le32(&locator[16..]) == 1,
            "ZIP64 locatorが不正です"
        );
        file.seek(SeekFrom::Start(le64(&locator[8..])))?;
        let mut end = [0; 56];
        file.read_exact(&mut end)?;
        ensure!(
            le32(&end) == 0x06064b50 && le32(&end[16..]) == 0 && le32(&end[20..]) == 0,
            "ZIP64終端が不正です"
        );
        entries = le64(&end[32..]);
        directory = le64(&end[48..]);
    }
    ensure!(
        entries <= MAX_INPUTS as u64 && directory < snapshot.bytes,
        "DEM ZIPの項目数・索引位置が不正です"
    );
    file.seek(SeekFrom::Start(directory))?;
    let mut output = Vec::new();
    for _ in 0..entries {
        context.check()?;
        let mut h = [0; 46];
        file.read_exact(&mut h)?;
        ensure!(le32(&h) == 0x02014b50, "DEM ZIP索引が不正です");
        let name_len = le16(&h[28..]) as usize;
        let extra_len = le16(&h[30..]) as usize;
        let comment_len = le16(&h[32..]) as usize;
        let mut name = vec![0; name_len];
        file.read_exact(&mut name)?;
        let mut extra = vec![0; extra_len];
        file.read_exact(&mut extra)?;
        file.seek(SeekFrom::Current(comment_len as i64))?;
        let mut bytes = u64::from(le32(&h[24..]));
        let mut compressed = u64::from(le32(&h[20..]));
        let mut offset = u64::from(le32(&h[42..]));
        let mut p = 0;
        while p + 4 <= extra.len() {
            let tag = le16(&extra[p..]);
            let n = le16(&extra[p + 2..]) as usize;
            p += 4;
            ensure!(p + n <= extra.len(), "ZIP拡張属性が不正です");
            if tag == 1 {
                let mut z = p;
                for value in [&mut bytes, &mut compressed, &mut offset] {
                    if *value == u64::from(u32::MAX) {
                        ensure!(z + 8 <= p + n, "ZIP64属性が短すぎます");
                        *value = le64(&extra[z..]);
                        z += 8;
                    }
                }
            }
            p += n;
        }
        let lower = String::from_utf8_lossy(&name).to_ascii_lowercase();
        ensure!(
            !lower.ends_with(".zip"),
            "入れ子のDEM ZIPは先に通常の展開を行い、展開先ディレクトリを指定してください"
        );
        if !lower.ends_with(".xml") && !lower.ends_with(".gml") {
            continue;
        }
        ensure!(le16(&h[8..]) & 1 == 0, "暗号化DEM ZIPには対応していません");
        let method = le16(&h[10..]);
        ensure!(method == 0 || method == 8, "DEM ZIPの圧縮方式が未対応です");
        ensure!(
            bytes <= MAX_XML_BYTES && compressed <= MAX_XML_BYTES + 1024 && offset < directory,
            "DEM ZIPのXMLサイズ・位置が不正です"
        );
        let resume = file.stream_position()?;
        file.seek(SeekFrom::Start(offset))?;
        let mut local = [0; 30];
        file.read_exact(&mut local)?;
        ensure!(
            le32(&local) == 0x04034b50
                && le16(&local[8..]) == method
                && le16(&local[6..]) == le16(&h[8..]),
            "ZIPローカルヘッダーが不正です"
        );
        let mut local_name = vec![0; le16(&local[26..]) as usize];
        file.read_exact(&mut local_name)?;
        ensure!(local_name == name, "ZIPの索引とローカル名が一致しません");
        if le16(&local[6..]) & 8 == 0 {
            ensure!(
                le32(&local[14..]) == le32(&h[16..]),
                "ZIPの索引とローカルCRCが一致しません"
            );
            for (declared, actual) in [
                (le32(&local[18..]), compressed),
                (le32(&local[22..]), bytes),
            ] {
                ensure!(
                    declared == u32::MAX || u64::from(declared) == actual,
                    "ZIPの索引とローカルサイズが一致しません"
                );
            }
        }
        let data = offset
            .checked_add(30 + u64::from(le16(&local[26..])) + u64::from(le16(&local[28..])))
            .context("ZIP位置が溢れました")?;
        ensure!(
            data.checked_add(compressed).is_some_and(|e| e <= directory),
            "ZIP内容が索引へ重なっています"
        );
        file.seek(SeekFrom::Start(resume))?;
        output.push(XmlInput {
            path: path.to_owned(),
            entry_name: Some(diagnostic_entry_name(&name)),
            offset: data,
            compressed,
            bytes,
            method,
            crc: Some(le32(&h[16..])),
            priority,
            snapshot: snapshot.clone(),
            hash: String::new(),
        });
    }
    snapshot.verify(path)?;
    Ok(output)
}
fn le16(v: &[u8]) -> u16 {
    u16::from_le_bytes(v[..2].try_into().unwrap())
}

fn diagnostic_entry_name(name: &[u8]) -> String {
    let decoded = String::from_utf8_lossy(name);
    let mut characters = decoded.chars();
    let mut short = characters
        .by_ref()
        .take(MAX_DIAGNOSTIC_ENTRY_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        short.push('…');
    }
    short
}
fn le32(v: &[u8]) -> u32 {
    u32::from_le_bytes(v[..4].try_into().unwrap())
}
fn le64(v: &[u8]) -> u64 {
    u64::from_le_bytes(v[..8].try_into().unwrap())
}

/// 標高配列を読み込む前の検査結果。全文検査や測地系補正の完了を表さない。
#[derive(Debug, Clone, Serialize)]
pub struct ElevationInspection {
    pub allowed: bool,
    pub exit_code: i32,
    pub error: Option<String>,
    pub validation_scope: &'static str,
    pub validation_complete: bool,
    pub datum_policy: ElevationDatumPolicy,
    pub input_grids: u64,
    pub source_coordinate_systems: Vec<String>,
    pub coordinate_system_counts: BTreeMap<String, u64>,
    pub mixed_input_coordinate_systems: bool,
    pub geographic_bounds: Option<[f64; 4]>,
    pub grid_dimensions: BTreeMap<String, u64>,
    pub declared_grid_types: BTreeMap<String, u64>,
    pub warnings: Vec<String>,
    pub horizontal_transformation: &'static str,
    pub vertical_correction: &'static str,
    #[serde(skip)]
    input: PathBuf,
    #[serde(skip)]
    inputs: Vec<XmlInput>,
    #[serde(skip)]
    manifest_snapshot: Option<Snapshot>,
}
impl ElevationInspection {
    /// 検査後に資料や入力一覧が増減・更新されていないか、本読取の直前に確認する。
    pub fn verify_unchanged(&self, context: &OperationContext) -> Result<()> {
        ensure!(self.allowed, "受入可能なDEM事前検査の結果ではありません");
        if let Some(snapshot) = &self.manifest_snapshot {
            snapshot.verify(&self.input)?;
        }
        let mut current = Vec::new();
        collect_files(&self.input, 0, 0, &mut current, context)
            .with_context(|| format!("DEM入力一覧 {}", self.input.display()))?;
        let key = |item: &XmlInput| {
            (
                item.path.clone(),
                item.entry_name.clone(),
                item.offset,
                item.compressed,
                item.bytes,
                item.method,
                item.crc,
                item.priority,
            )
        };
        ensure!(
            self.inputs.iter().map(key).eq(current.iter().map(key)),
            "DEM入力の構成が事前検査後に変更されました"
        );
        for item in &self.inputs {
            context.check()?;
            item.snapshot.verify(&item.path)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct DatumPolicyRejected(String);
impl std::fmt::Display for DatumPolicyRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for DatumPolicyRejected {}

fn check_datum_policy(crs: &BTreeSet<ElevationCrs>, policy: ElevationDatumPolicy) -> Result<()> {
    if crs.len() <= 1 {
        return Ok(());
    }
    let message = if crs.contains(&ElevationCrs::Jgd2024) {
        "JGD2024とJGD2000・JGD2011の標高は同じ完成DBへ混合できません"
    } else if policy == ElevationDatumPolicy::Strict {
        "JGD2000とJGD2011の混在には--elevation-datum-policy allow-jgd2000-2011の明示指定が必要です"
    } else {
        return Ok(());
    };
    Err(DatumPolicyRejected(message.to_owned()).into())
}

/// 設定・DB・生成所有権なしで、入力のヘッダーだけを有界に検査する。
pub fn inspect_input(
    input: &Path,
    policy: ElevationDatumPolicy,
    context: &OperationContext,
) -> ElevationInspection {
    let mut report = ElevationInspection {
        allowed: false,
        exit_code: 1,
        error: None,
        validation_scope: "header-only",
        validation_complete: false,
        datum_policy: policy,
        input_grids: 0,
        source_coordinate_systems: Vec::new(),
        coordinate_system_counts: BTreeMap::new(),
        mixed_input_coordinate_systems: false,
        geographic_bounds: None,
        grid_dimensions: BTreeMap::new(),
        declared_grid_types: BTreeMap::new(),
        warnings: Vec::new(),
        horizontal_transformation: "none-source-lonlat-v1",
        vertical_correction: "none-source-height-v1",
        input: input.to_owned(),
        inputs: Vec::new(),
        manifest_snapshot: None,
    };
    let result = (|| -> Result<()> {
        if input
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("json"))
        {
            report.manifest_snapshot = Some(Snapshot::of(input)?);
        }
        collect_files(input, 0, 0, &mut report.inputs, context)
            .with_context(|| format!("DEM入力一覧 {}", input.display()))?;
        ensure!(!report.inputs.is_empty(), "標高入力にXMLがありません");
        let mut systems = BTreeSet::new();
        for item in &report.inputs {
            context.check()?;
            if let Some(header) = item.read_header(context)? {
                systems.insert(header.crs);
                report.input_grids += 1;
                *report
                    .coordinate_system_counts
                    .entry(header.crs.as_str().to_owned())
                    .or_default() += 1;
                *report
                    .grid_dimensions
                    .entry(format!("{}x{}", header.width, header.height))
                    .or_default() += 1;
                *report
                    .declared_grid_types
                    .entry(header.declared_type.unwrap_or_else(|| "未宣言".into()))
                    .or_default() += 1;
                // 格子寸法の種類にも上限を設け、巨大な結果JSONを作らない。
                ensure!(
                    report.grid_dimensions.len() <= 64,
                    "DEM格子寸法の種類が上限を超えました"
                );
                ensure!(
                    report.declared_grid_types.len() <= 64,
                    "DEM種別の種類が上限を超えました"
                );
                let b = [
                    header.lower[1],
                    header.lower[0],
                    header.upper[1],
                    header.upper[0],
                ];
                report.geographic_bounds = Some(match report.geographic_bounds {
                    None => b,
                    Some(a) => [
                        a[0].min(b[0]),
                        a[1].min(b[1]),
                        a[2].max(b[2]),
                        a[3].max(b[3]),
                    ],
                });
            }
        }
        report.source_coordinate_systems = systems.iter().map(|s| s.as_str().to_owned()).collect();
        report.mixed_input_coordinate_systems = systems.len() > 1;
        ensure!(report.input_grids > 0, "標高入力にDEMがありません");
        report.validation_complete = true;
        check_datum_policy(&systems, policy)?;
        if systems.len() > 1 {
            report.warnings.push("JGD2000・JGD2011の原座標・原標高を併用します。測地系補正・標高改定の補正は行わず、境界にずれや標高差が生じる場合があります。".into());
        }
        if let Some(snapshot) = &report.manifest_snapshot {
            snapshot.verify(input)?;
        }
        Ok(())
    })();
    match result.with_context(|| format!("DEM事前検査 {}", input.display())) {
        Ok(()) => {
            report.allowed = true;
            report.exit_code = 0;
        },
        Err(error) => {
            report.exit_code = if crate::tilegen::cancel::is_interrupted(&error) {
                130
            } else if error.is::<DatumPolicyRejected>() || error.is::<UnknownElevationCrs>() {
                2
            } else {
                1
            };
            report.error = Some(format!("{error:#}"));
            // 部分集計も報告するが、検査完了とは扱わない。
            report.source_coordinate_systems =
                report.coordinate_system_counts.keys().cloned().collect();
            report.mixed_input_coordinate_systems = report.source_coordinate_systems.len() > 1;
        },
    }
    report
}

#[derive(Default)]
struct CrsStats {
    input_grids: u64,
    valid_grids: u64,
    contributed_cells: u64,
    ground_cells: u64,
    coverage_bounds: Option<Rect>,
    digest: Sha256,
}

fn extend_bounds(current: Option<Rect>, added: Option<Rect>) -> Option<Rect> {
    match (current, added) {
        (None, b) | (b, None) => b,
        (Some(a), Some(b)) => Some(Rect {
            min_x: a.min_x.min(b.min_x),
            max_x: a.max_x.max(b.max_x),
            min_y: a.min_y.min(b.min_y),
            max_y: a.max_y.max(b.max_y),
        }),
    }
}

struct GridStats {
    cells: u64,
    ground: u64,
    bounds: Option<Rect>,
    min: f32,
    max: f32,
}
fn store_grid(
    connection: &Connection,
    grid: &Grid,
    context: &OperationContext,
    batch: &mut WriteBatch<'_>,
) -> Result<GridStats> {
    let mut chunks = BTreeMap::<(i64, i64), Chunk>::new();
    let mut added = 0;
    let mut ground = 0;
    let mut bounds = None::<(i64, i64, i64, i64)>;
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for y in 0..grid.height {
        context.check()?;
        for x in 0..grid.width {
            let source = y * grid.width + x;
            if grid.mask[source] == 0 {
                continue;
            }
            let gx = grid.x0 + x as i64;
            let gy = grid.y0 + y as i64;
            let key = (gx / SIDE as i64, gy / SIDE as i64);
            if !chunks.contains_key(&key) {
                chunks.insert(
                    key,
                    load_chunk(connection, grid.resolution, 0, key.0, key.1)?
                        .unwrap_or_else(Chunk::empty),
                );
            }
            let chunk = chunks.get_mut(&key).unwrap();
            let at = (gy as usize % SIDE) * SIDE + gx as usize % SIDE;
            if chunk.mask[at] == 0 {
                chunk.values[at] = grid.values[source];
                chunk.mask[at] = grid.mask[source];
                added += 1;
                min = min.min(grid.values[source]);
                max = max.max(grid.values[source]);
                bounds = Some(match bounds {
                    Some((x0, x1, y0, y1)) => (x0.min(gx), x1.max(gx), y0.min(gy), y1.max(gy)),
                    None => (gx, gx, gy, gy),
                });
                if grid.mask[source] == 1 {
                    ground += 1;
                }
            }
        }
    }
    for ((cx, cy), chunk) in chunks {
        context.check()?;
        save_chunk(connection, grid.resolution, 0, cx, cy, &chunk)?;
        batch.record(CHUNK_BYTES)?;
    }
    let bounds = bounds
        .map(|(x0, x1, y0, y1)| -> Result<Rect> {
            let r = f64::from(grid.resolution);
            let nw = project(x0 as f64 / r - 180.0, 90.0 - y0 as f64 / r)?;
            let se = project((x1 + 1) as f64 / r - 180.0, 90.0 - (y1 + 1) as f64 / r)?;
            Rect::new(nw.x, se.x, nw.y, se.y)
        })
        .transpose()?;
    Ok(GridStats {
        cells: added,
        ground,
        bounds,
        min,
        max,
    })
}

fn build_pyramid(
    connection: &Connection,
    resolution: u32,
    context: &OperationContext,
    batch: &mut WriteBatch<'_>,
) -> Result<()> {
    for level in 1..=MAX_LEVEL {
        context.check()?;
        let mut statement=connection.prepare("SELECT cx/2,cy/2 FROM standard_dem_chunks WHERE resolution=? AND level=? GROUP BY cx/2,cy/2 ORDER BY cx/2,cy/2")?;
        let mut rows = statement.query(params![resolution, level - 1])?;
        while let Some(row) = rows.next()? {
            let cx: i64 = row.get(0)?;
            let cy: i64 = row.get(1)?;
            context.check()?;
            let mut output = Chunk::empty();
            for dy in 0..2_i64 {
                for dx in 0..2_i64 {
                    if let Some(child) =
                        load_chunk(connection, resolution, level - 1, cx * 2 + dx, cy * 2 + dy)?
                    {
                        for y in 0..SIDE / 2 {
                            for x in 0..SIDE / 2 {
                                let indices = [
                                    (y * 2) * SIDE + x * 2,
                                    (y * 2) * SIDE + x * 2 + 1,
                                    (y * 2 + 1) * SIDE + x * 2,
                                    (y * 2 + 1) * SIDE + x * 2 + 1,
                                ];
                                let mut sum = 0.0_f64;
                                let mut count = 0;
                                let mut mask = 1;
                                for i in indices {
                                    if child.mask[i] != 0 {
                                        sum += f64::from(child.values[i]);
                                        count += 1;
                                        mask = mask.max(child.mask[i]);
                                    }
                                }
                                if count > 0 {
                                    let at = (dy as usize * SIDE / 2 + y) * SIDE
                                        + dx as usize * SIDE / 2
                                        + x;
                                    output.values[at] = (sum / f64::from(count)) as f32;
                                    output.mask[at] = mask;
                                }
                            }
                        }
                    }
                }
            }
            save_chunk(connection, resolution, level, cx, cy, &output)?;
            batch.record(CHUNK_BYTES)?;
        }
    }
    Ok(())
}

pub fn import_into(
    connection: &Connection,
    input: &Path,
    context: &OperationContext,
) -> Result<(Vec<SourceInfo>, Value)> {
    import_into_with_policy(connection, input, ElevationDatumPolicy::Strict, context)
}

pub fn import_into_with_policy(
    connection: &Connection,
    input: &Path,
    policy: ElevationDatumPolicy,
    context: &OperationContext,
) -> Result<(Vec<SourceInfo>, Value)> {
    import_into_with_policy_and_contours(connection, input, policy, true, context)
}

/// 名称対応形式では、標高格子を保持したまま等高線の計算と格納を省略できる。
pub fn import_into_with_policy_and_contours(
    connection: &Connection,
    input: &Path,
    policy: ElevationDatumPolicy,
    contours: bool,
    context: &OperationContext,
) -> Result<(Vec<SourceInfo>, Value)> {
    let inspection = inspect_input(input, policy, context);
    context.check()?;
    ensure!(
        inspection.allowed,
        "{}",
        inspection
            .error
            .as_deref()
            .unwrap_or("DEM事前検査に失敗しました")
    );
    inspection.verify_unchanged(context)?;
    let mut inputs = inspection.inputs.clone();
    // 圧縮容器の日時・格納順を除き、同順位では内容のhash順で採用する。
    for item in &mut inputs {
        item.hash = item.read_payload(context, false)?.1;
    }
    inputs.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.hash.cmp(&b.hash))
    });
    inputs.dedup_by(|a, b| a.hash == b.hash && a.priority == b.priority);
    let mut identity = Sha256::new();
    identity.update(b"geocode-gsi-dem-inputs-v2");
    let mut batch = WriteBatch::new(connection)?;
    let mut systems = BTreeSet::<ElevationCrs>::new();
    let mut stats = BTreeMap::<String, CrsStats>::new();
    for (crs, count) in &inspection.coordinate_system_counts {
        stats.insert(
            crs.clone(),
            CrsStats {
                input_grids: *count,
                ..Default::default()
            },
        );
    }
    let mut resolutions = BTreeSet::new();
    let mut cells = 0_u64;
    let mut ground_cells = 0_u64;
    let mut bytes = 0_u64;
    let mut grids = 0_u64;
    let mut coverage = None::<Rect>;
    let mut min_m = f32::INFINITY;
    let mut max_m = f32::NEG_INFINITY;
    for item in &inputs {
        context.check()?;
        let (grid, hash) = item.read_payload(context, true)?;
        ensure!(hash == item.hash, "標高入力が取り込み中に変更されました");
        if let Some(grid) = grid {
            systems.insert(grid.crs);
            check_datum_policy(&systems, policy).with_context(|| item.label())?;
            let row = stats
                .get_mut(grid.crs.as_str())
                .context("DEMのCRSが事前検査後に変わりました")?;
            identity.update(item.priority.to_le_bytes());
            identity.update(hash.as_bytes());
            row.digest.update(item.priority.to_le_bytes());
            row.digest.update(hash.as_bytes());
            bytes += item.bytes;
            if !grid.mask.iter().any(|&kind| kind != 0) {
                continue;
            }
            row.valid_grids += 1;
            grids += 1;
            resolutions.insert(grid.resolution);
            let added = store_grid(connection, &grid, context, &mut batch)?;
            cells += added.cells;
            ground_cells += added.ground;
            min_m = min_m.min(added.min);
            max_m = max_m.max(added.max);
            row.contributed_cells += added.cells;
            row.ground_cells += added.ground;
            row.coverage_bounds = extend_bounds(row.coverage_bounds, added.bounds);
            coverage = extend_bounds(coverage, added.bounds);
        }
    }
    ensure!(ground_cells > 0, "有効な地表・表層の標高セルがありません");
    let source_coordinate_systems = inspection.source_coordinate_systems.clone();
    let contributing_coordinate_systems = stats
        .iter()
        .filter(|(_, s)| s.contributed_cells > 0)
        .map(|(crs, _)| crs.clone())
        .collect::<Vec<_>>();
    let mixed_coordinate_systems = contributing_coordinate_systems.len() > 1;
    let effective_datum_policy = if mixed_coordinate_systems {
        "source-values-mixed-jgd2000-2011-v2"
    } else {
        "source-values-single-crs-v2"
    };
    identity.update(effective_datum_policy.as_bytes());
    identity.update(b"none-source-lonlat-v1\0none-source-height-v1");
    identity.update(EFFECTIVE_SURFACE_POLICY.as_bytes());
    let crs = if source_coordinate_systems.len() == 1 {
        source_coordinate_systems.first().cloned()
    } else {
        None
    };
    let coordinate_systems = stats
        .into_iter()
        .map(|(crs, s)| {
            (
                crs,
                json!({"input_grids":s.input_grids,"valid_grids":s.valid_grids,
            "contributed_cells":s.contributed_cells,"ground_cells":s.ground_cells,
            "coverage_bounds":s.coverage_bounds,"sha256":format!("{:x}",s.digest.finalize())}),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for &resolution in &resolutions {
        build_pyramid(connection, resolution, context, &mut batch)?;
    }
    let contour_count = if contours {
        generate_contours(connection, &resolutions, context, &mut batch)?
    } else {
        identity.update(b"contour-data-off-v1");
        0
    };
    let chunks: u64 =
        connection.query_row("SELECT count(*) FROM standard_dem_chunks", [], |r| r.get(0))?;
    let summary = json!({"revision":2,"crs":crs,
        "input_grids":inspection.input_grids,"source_coordinate_systems":source_coordinate_systems,
        "contributing_coordinate_systems":contributing_coordinate_systems,
        "mixed_input_coordinate_systems":inspection.mixed_input_coordinate_systems,
        "mixed_coordinate_systems":mixed_coordinate_systems,"coordinate_systems":coordinate_systems,
        "datum_policy":policy.as_str(),"effective_datum_policy":effective_datum_policy,
        "effective_surface_policy":EFFECTIVE_SURFACE_POLICY,
        "horizontal_transformation":"none-source-lonlat-v1","vertical_correction":"none-source-height-v1",
        "vertical_reference":"国土地理院の原資料値・垂直補正なし",
        "vertical_validation":"宣言CRS・格子・許可された混在を検査。原資料の測量時期と標高改定版の一致は保証しない",
        "cells":cells,"ground_cells":ground_cells,"grids":grids,"chunks":chunks,"min_elevation_m":min_m,"max_elevation_m":max_m,"coverage_bounds":coverage,"coverage_is_complete":false,"cells_per_degree":resolutions,"contour_interval_m":20,"index_contour_interval_m":100,"contour_features":contour_count,"write_batch_max_bytes":8*1024*1024,"surface_policy":"地表面・表層面とDEM種別10mメッシュ（標高）のその他を採用、水面は陰影参照のみ、水底・他種別のその他・データなし・標高-9999は欠損"});
    connection.execute(
        "INSERT INTO standard_dem_metadata VALUES('document',?)",
        [summary.to_string()],
    )?;
    let source = SourceInfo {
        kind: "elevation".into(),
        sha256: format!("{:x}", identity.finalize()),
        bytes,
        details: summary.clone(),
    };
    for item in &inputs {
        item.snapshot.verify(&item.path)?;
    }
    inspection.verify_unchanged(context)?;
    batch.finish()?;
    Ok((vec![source], summary))
}

/// 完成時だけ、実際の固定格子と集計の一致をストリームで検査する。
pub(crate) fn validate_stored_summary(connection: &Connection, summary: &Value) -> Result<()> {
    let mut cells = 0_u64;
    let mut ground = 0_u64;
    let mut chunks = 0_u64;
    let mut statement =
        connection.prepare("SELECT level,length(data),data FROM standard_dem_chunks")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let length: u64 = row.get(1)?;
        ensure!(
            length <= (CHUNK_BYTES + 1024) as u64,
            "標高チャンクが過大です"
        );
        chunks += 1;
        if row.get::<_, u8>(0)? == 0 {
            let chunk = Chunk::decode(&row.get::<_, Vec<u8>>(2)?)?;
            cells += chunk.mask.iter().filter(|&&m| m != 0).count() as u64;
            ground += chunk.mask.iter().filter(|&&m| m == 1).count() as u64;
        }
    }
    ensure!(
        summary["cells"].as_u64() == Some(cells)
            && summary["ground_cells"].as_u64() == Some(ground)
            && summary["chunks"].as_u64() == Some(chunks),
        "標高メタデータと保存格子の件数が一致しません"
    );
    Ok(())
}

struct Set {
    resolution: u32,
    level: u8,
    chunks: BTreeMap<(i64, i64), Chunk>,
}
pub struct Sampler {
    sets: Vec<Set>,
    step: f64,
}
impl Sampler {
    pub fn new(
        connection: &Connection,
        query: Rect,
        zoom: u8,
        context: &OperationContext,
    ) -> Result<Self> {
        Self::with_target(
            connection,
            query,
            360.0 / (256.0 * 2_f64.powi(i32::from(zoom))),
            context,
        )
    }
    fn with_target(
        connection: &Connection,
        query: Rect,
        target_degrees: f64,
        context: &OperationContext,
    ) -> Result<Self> {
        let mut statement = connection.prepare(
            "SELECT DISTINCT resolution FROM standard_dem_chunks ORDER BY resolution DESC",
        )?;
        let resolutions = statement
            .query_map([], |r| r.get::<_, u32>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(resolutions.len() <= 16, "DEM解像度の種類が上限を超えました");
        let mut sets = Vec::new();
        let mut step = 1.0_f64;
        let mut total = 0;
        for resolution in resolutions {
            context.check()?;
            let mut level = 0;
            while level < MAX_LEVEL
                && (1_u32 << (level + 1)) as f64 / f64::from(resolution) <= target_degrees
            {
                level += 1;
            }
            let degrees = (1_u32 << level) as f64 / f64::from(resolution);
            step = step.min(degrees / 360.0);
            let west = (query.min_x * 360.0 - 180.0).clamp(-180.0, 180.0);
            let east = (query.max_x * 360.0 - 180.0).clamp(-180.0, 180.0);
            let north = latitude(query.min_y.clamp(0.0, 1.0));
            let south = latitude(query.max_y.clamp(0.0, 1.0));
            let cx0 = (((west + 180.0) / degrees - 3.0).floor() as i64).div_euclid(SIDE as i64);
            let cx1 = (((east + 180.0) / degrees + 3.0).ceil() as i64).div_euclid(SIDE as i64);
            let cy0 = (((90.0 - north) / degrees - 3.0).floor() as i64).div_euclid(SIDE as i64);
            let cy1 = (((90.0 - south) / degrees + 3.0).ceil() as i64).div_euclid(SIDE as i64);
            let mut s=connection.prepare("SELECT cx,cy,length(data),data FROM standard_dem_chunks WHERE resolution=? AND level=? AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ? ORDER BY cx,cy LIMIT 1025")?;
            let mut rows = s.query(params![resolution, level, cx0, cx1, cy0, cy1])?;
            let mut chunks = BTreeMap::new();
            while let Some(row) = rows.next()? {
                context.check()?;
                total += 1;
                ensure!(
                    total <= MAX_QUERY_CHUNKS,
                    "標高検索のチャンク数が上限を超えました"
                );
                let length: i64 = row.get(2)?;
                ensure!(
                    (1..=(CHUNK_BYTES + 1024) as i64).contains(&length),
                    "標高チャンクサイズが不正です"
                );
                let bytes: Vec<u8> = row.get(3)?;
                chunks.insert((row.get(0)?, row.get(1)?), Chunk::decode(&bytes)?);
            }
            if !chunks.is_empty() {
                sets.push(Set {
                    resolution,
                    level,
                    chunks,
                });
            }
        }
        Ok(Self { sets, step })
    }
    pub fn step(&self) -> f64 {
        self.step
    }
    pub fn sample(&self, point: Point) -> Option<f32> {
        self.sample_kind(point, false)
    }
    fn sample_kind(&self, point: Point, ground_only: bool) -> Option<f32> {
        let lon = point.x * 360.0 - 180.0;
        let lat = latitude(point.y);
        for set in &self.sets {
            let scale = f64::from(set.resolution) / f64::from(1_u32 << set.level);
            let x = (lon + 180.0) * scale - 0.5;
            let y = (90.0 - lat) * scale - 0.5;
            let ix = x.floor() as i64;
            let iy = y.floor() as i64;
            let tx = x - ix as f64;
            let ty = y - iy as f64;
            let mut value = 0.0_f64;
            let mut valid = true;
            for (dx, dy, weight) in [
                (0, 0, (1.0 - tx) * (1.0 - ty)),
                (1, 0, tx * (1.0 - ty)),
                (0, 1, (1.0 - tx) * ty),
                (1, 1, tx * ty),
            ] {
                if weight <= 1e-9 {
                    continue;
                }
                let gx = ix + dx;
                let gy = iy + dy;
                let Some(chunk) = set
                    .chunks
                    .get(&(gx.div_euclid(SIDE as i64), gy.div_euclid(SIDE as i64)))
                else {
                    valid = false;
                    break;
                };
                let at = gy.rem_euclid(SIDE as i64) as usize * SIDE
                    + gx.rem_euclid(SIDE as i64) as usize;
                if chunk.mask[at] == 0 || (ground_only && chunk.mask[at] != 1) {
                    valid = false;
                    break;
                }
                value += weight * f64::from(chunk.values[at]);
            }
            if valid {
                return Some(value as f32);
            }
        }
        None
    }
}
fn latitude(y: f64) -> f64 {
    libm::atan(libm::sinh(std::f64::consts::PI * (1.0 - 2.0 * y))) * 180.0 / std::f64::consts::PI
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Edge {
    x: i64,
    y: i64,
    axis: u8,
}
#[derive(Clone)]
struct Segment {
    a: Edge,
    b: Edge,
    pa: Point,
    pb: Point,
}
fn crossing(
    x: i64,
    y: i64,
    axis: u8,
    a: f32,
    b: f32,
    height: i32,
    resolution: u32,
) -> Result<(Edge, Point)> {
    let t = (f64::from(height) - f64::from(a)) / (f64::from(b) - f64::from(a));
    let edge = if t <= 0.0 {
        Edge { x, y, axis: 2 }
    } else if t >= 1.0 {
        Edge {
            x: x + i64::from(axis == 0),
            y: y + i64::from(axis == 1),
            axis: 2,
        }
    } else {
        Edge { x, y, axis }
    };
    let gx = x as f64 + 0.5 + if axis == 0 { t } else { 0.0 };
    let gy = y as f64 + 0.5 + if axis == 1 { t } else { 0.0 };
    Ok((
        edge,
        project(
            gx / f64::from(resolution) - 180.0,
            90.0 - gy / f64::from(resolution),
        )?,
    ))
}
fn cell_segments(
    x: i64,
    y: i64,
    z: [f32; 4],
    resolution: u32,
    output: &mut BTreeMap<i32, Vec<Segment>>,
) -> Result<usize> {
    let mut count = 0;
    let min = z.into_iter().fold(f32::INFINITY, f32::min);
    let max = z.into_iter().fold(f32::NEG_INFINITY, f32::max);
    let first = (f64::from(min) / 20.0).ceil() as i32 * 20;
    let last = (f64::from(max) / 20.0).floor() as i32 * 20;
    for height in (first..=last).step_by(20) {
        let above = z.map(|v| v > height as f32);
        let definitions = [
            (0, 1, x, y, 0),
            (1, 2, x + 1, y, 1),
            (3, 2, x, y + 1, 0),
            (0, 3, x, y, 1),
        ];
        let mut hits = Vec::new();
        for (a, b, gx, gy, axis) in definitions {
            if above[a] != above[b] {
                hits.push(crossing(gx, gy, axis, z[a], z[b], height, resolution)?);
            }
        }
        if hits.len() == 2 {
            output.entry(height).or_default().push(Segment {
                a: hits[0].0,
                b: hits[1].0,
                pa: hits[0].1,
                pb: hits[1].1,
            });
            count += 1;
        } else if hits.len() == 4 {
            // 鞍点は双線形補間の中心と固定の同値規則で接続する。
            let center = (z.iter().map(|&v| f64::from(v)).sum::<f64>() / 4.0) > f64::from(height);
            let pairs = if above[0] == center {
                [(0, 1), (2, 3)]
            } else {
                [(0, 3), (1, 2)]
            };
            for (a, b) in pairs {
                output.entry(height).or_default().push(Segment {
                    a: hits[a].0,
                    b: hits[b].0,
                    pa: hits[a].1,
                    pb: hits[b].1,
                });
                count += 1;
            }
        }
    }
    Ok(count)
}

fn store_contours(
    connection: &Connection,
    segments: BTreeMap<i32, Vec<Segment>>,
    next_id: &mut i64,
    context: &OperationContext,
    batch: &mut WriteBatch<'_>,
) -> Result<u64> {
    let mut written = 0;
    for (height, segments) in segments {
        context.check()?;
        let mut adjacency = BTreeMap::<Edge, Vec<usize>>::new();
        for (i, s) in segments.iter().enumerate() {
            if s.a != s.b {
                adjacency.entry(s.a).or_default().push(i);
                adjacency.entry(s.b).or_default().push(i);
            }
        }
        let mut used = vec![false; segments.len()];
        let starts = adjacency
            .iter()
            .filter(|(_, v)| v.len() != 2)
            .chain(adjacency.iter().filter(|(_, v)| v.len() == 2))
            .map(|(&p, _)| p)
            .collect::<Vec<_>>();
        for start in starts {
            while adjacency
                .get(&start)
                .is_some_and(|v| v.iter().any(|&i| !used[i]))
            {
                context.check()?;
                let mut at = start;
                let mut points = Vec::new();
                loop {
                    let Some(index) = adjacency
                        .get(&at)
                        .and_then(|v| v.iter().copied().find(|&i| !used[i]))
                    else {
                        break;
                    };
                    used[index] = true;
                    let segment = &segments[index];
                    let (p, next, q) = if segment.a == at {
                        (segment.pa, segment.b, segment.pb)
                    } else {
                        (segment.pb, segment.a, segment.pa)
                    };
                    if points.is_empty() {
                        points.push(p);
                    }
                    points.push(q);
                    at = next;
                    if points.len() >= 8192 || at == start {
                        break;
                    }
                }
                if points.len() >= 2 {
                    let bytes = points.len() * 16 * 5 + 512;
                    *next_id += 1;
                    store::insert_feature_with_context(
                        connection,
                        &Feature {
                            osm_type: 4,
                            osm_id: *next_id,
                            role: i64::from(height),
                            kind: FeatureKind::Contour,
                            geometry: Geometry::Line(points),
                            layer: 0,
                            structure: 1,
                        },
                        context,
                    )?;
                    written += 1;
                    batch.record(bytes)?;
                }
            }
        }
    }
    Ok(written)
}

fn generate_contours(
    connection: &Connection,
    resolutions: &BTreeSet<u32>,
    context: &OperationContext,
    batch: &mut WriteBatch<'_>,
) -> Result<u64> {
    let resolution = *resolutions.first().context("標高解像度がありません")?;
    ensure!(
        resolutions
            .iter()
            .all(|r| r % resolution == 0 && (r / resolution).is_power_of_two()),
        "混在DEMの解像度比は2の累乗に限ります"
    );
    connection.execute_batch("CREATE TEMP TABLE standard_contour_chunks(cx INTEGER,cy INTEGER,PRIMARY KEY(cx,cy)) WITHOUT ROWID")?;
    for &r in resolutions {
        let level = (r / resolution).trailing_zeros() as u8;
        connection.execute("INSERT OR IGNORE INTO standard_contour_chunks SELECT cx,cy FROM standard_dem_chunks WHERE resolution=? AND level=?",params![r,level])?;
    }
    // 一度に扱うのは128四方のセルと、その境界用近傍だけ。
    let mut next_id = 0_i64;
    let mut count = 0;
    let mut statement =
        connection.prepare("SELECT cx,cy FROM standard_contour_chunks ORDER BY cx,cy")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let cx: i64 = row.get(0)?;
        let cy: i64 = row.get(1)?;
        context.check()?;
        let x0 = cx * SIDE as i64;
        let y0 = cy * SIDE as i64;
        let northwest = project(
            (x0 as f64 + 0.5) / f64::from(resolution) - 180.0,
            90.0 - (y0 as f64 + 0.5) / f64::from(resolution),
        )?;
        let southeast = project(
            (x0 as f64 + SIDE as f64 + 1.5) / f64::from(resolution) - 180.0,
            90.0 - (y0 as f64 + SIDE as f64 + 1.5) / f64::from(resolution),
        )?;
        let sampler = Sampler::with_target(
            connection,
            Rect::new(northwest.x, southeast.x, northwest.y, southeast.y)?,
            1.0 / f64::from(resolution),
            context,
        )?;
        let mut rows = Vec::with_capacity((SIDE + 1) * (SIDE + 1));
        for y in 0..=SIDE {
            for x in 0..=SIDE {
                rows.push(sampler.sample_kind(
                    project(
                        (x0 as f64 + x as f64 + 0.5) / f64::from(resolution) - 180.0,
                        90.0 - (y0 as f64 + y as f64 + 0.5) / f64::from(resolution),
                    )?,
                    true,
                ));
            }
        }
        let mut segments = BTreeMap::new();
        let mut total = 0;
        for y in 0..SIDE {
            context.check()?;
            for x in 0..SIDE {
                let i = y * (SIDE + 1) + x;
                if let [Some(a), Some(b), Some(c), Some(d)] =
                    [rows[i], rows[i + 1], rows[i + SIDE + 2], rows[i + SIDE + 1]]
                {
                    total += cell_segments(
                        x0 + x as i64,
                        y0 + y as i64,
                        [a, b, c, d],
                        resolution,
                        &mut segments,
                    )?;
                    ensure!(
                        total <= MAX_CONTOUR_SEGMENTS,
                        "1チャンクの等高線量が上限を超えました"
                    );
                }
            }
        }
        count += store_contours(connection, segments, &mut next_id, context, batch)?;
    }
    drop(rows);
    drop(statement);
    connection.execute_batch("DROP TABLE standard_contour_chunks")?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn xml(
        width: usize,
        height: usize,
        west: f64,
        south: f64,
        step: f64,
        values: &str,
        start: &str,
        crs: &str,
    ) -> String {
        format!(
            "<Dataset xmlns:gml=\"http://www.opengis.net/gml/3.2\"><DEM><coverage><gml:boundedBy><gml:Envelope srsName=\"{crs}\"><gml:lowerCorner>{south:.12} {west:.12}</gml:lowerCorner><gml:upperCorner>{:.12} {:.12}</gml:upperCorner></gml:Envelope></gml:boundedBy><gml:gridDomain><gml:Grid dimension=\"2\"><gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>{} {}</gml:high></gml:GridEnvelope></gml:limits><gml:axisLabels>x y</gml:axisLabels></gml:Grid></gml:gridDomain><gml:rangeSet><gml:DataBlock><gml:tupleList>{values}</gml:tupleList></gml:DataBlock></gml:rangeSet><gml:coverageFunction><gml:GridFunction><gml:sequenceRule order=\"+x-y\">Linear</gml:sequenceRule><gml:startPoint>{start}</gml:startPoint></gml:GridFunction></gml:coverageFunction></coverage></DEM></Dataset>",
            south + height as f64 * step,
            west + width as f64 * step,
            width - 1,
            height - 1
        )
    }
    fn parse(text: &str) -> Result<Grid> {
        parse_grid(Cursor::new(text), &OperationContext::default())?.context("DEMなし")
    }
    fn connection() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        store::initialize(&c).unwrap();
        c
    }
    fn zipped(payload: &[u8], name: &str, deflate: bool) -> Vec<u8> {
        let method = if deflate { 8_u16 } else { 0 };
        let crc = crc32fast::hash(payload);
        let compressed = if deflate {
            let mut e = flate2::write::DeflateEncoder::new(Vec::new(), Compression::fast());
            e.write_all(payload).unwrap();
            e.finish().unwrap()
        } else {
            payload.to_vec()
        };
        let mut out = Vec::new();
        out.extend_from_slice(&0x04034b50_u32.to_le_bytes());
        out.extend_from_slice(&20_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&compressed);
        let offset = out.len();
        out.extend_from_slice(&0x02014b50_u32.to_le_bytes());
        out.extend_from_slice(&20_u16.to_le_bytes());
        out.extend_from_slice(&20_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0; 12]);
        out.extend_from_slice(&0_u32.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        let size = out.len() - offset;
        out.extend_from_slice(&0x06054b50_u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&1_u16.to_le_bytes());
        out.extend_from_slice(&1_u16.to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out
    }

    #[test]
    fn 公式DEM10と5の非正方形メッシュを等角セル中心へ解釈する() {
        // 2次メッシュの7分30秒×5分を1125×750で割ると両軸とも1/9000度。
        let ten = xml(
            1125,
            750,
            139.625,
            35.666666666667,
            1.0 / 9000.0,
            "地表面,123.45",
            "0 0",
            "fguuid:jgd2024.bl",
        );
        let g = parse(&ten).unwrap();
        assert_eq!(g.resolution, 9000);
        assert_eq!((g.width, g.height), (1125, 750));
        assert!((g.values[0] - 123.45).abs() < 0.001);
        assert_eq!(g.mask[1], 0);
        // 3次メッシュの45秒×30秒を225×150で割ると両軸とも1/18000度。
        let five = xml(
            225,
            150,
            139.625,
            35.666666666667,
            1.0 / 18000.0,
            "地表面,5",
            "224 149",
            "fguuid:jgd2011.bl",
        );
        let g = parse(&five).unwrap();
        assert_eq!(g.resolution, 18000);
        assert_eq!(g.mask[..g.mask.len() - 1].iter().sum::<u8>(), 0);
        assert_eq!(g.mask[g.mask.len() - 1], 1);
    }
    #[test]
    fn 開始位置末尾省略と水底欠損をゼロ標高から区別する() {
        let text = xml(
            3,
            3,
            139.0,
            35.0,
            0.001,
            "地表面,0 内水面,-2 海水底面,-30 データなし,-9999 海水面,-9999",
            "1 0",
            "fguuid:jgd2024.bl",
        );
        let g = parse(&text).unwrap();
        assert_eq!(g.mask, vec![0, 1, 2, 0, 0, 0, 0, 0, 0]);
        assert_eq!(g.values[1], 0.0);
        assert_eq!(g.values[2], -2.0);
    }

    #[test]
    fn 十m標高のその他だけを有効値として採用し欠損と水底を維持する() {
        let base = xml(
            3,
            3,
            139.0,
            35.0,
            1.0 / 9000.0,
            "その他,132.20 その他,-9999 その他,0 地表面,12 表層面,14 海水面,0 内水面,3 海水底面,5 データなし,7",
            "0 0",
            "fguuid:jgd2000.bl",
        );
        let legacy = base.replace("<DEM>", "<DEM><type>10mメッシュ（標高）</type>");
        let grid = parse(&legacy).unwrap();
        assert_eq!(grid.mask, [1, 0, 1, 1, 1, 2, 2, 0, 0]);
        assert_eq!(grid.values[0], 132.20_f32);
        assert_eq!(grid.values[1], 0.0);
        assert_eq!(grid.values[2], 0.0);
        for other in [
            base,
            legacy.replace("10mメッシュ（標高）", "5mメッシュ（標高）"),
            legacy.replace("10mメッシュ（標高）", "不明"),
        ] {
            assert_eq!(&parse(&other).unwrap().mask[..3], &[0, 0, 0]);
        }
        for invalid in ["NaN", "100001", "-15001"] {
            assert!(parse(&legacy.replace("132.20", invalid)).is_err());
        }
        assert!(parse(&legacy.replace("その他,132.20", "未知種別,132.20")).is_err());
    }

    #[test]
    #[ignore = "GEOCODE_DEM_SMOKE_INPUTで指定した実資料1～2件を読取専用で検証する"]
    fn 実標高zipのsdk取り込みで有効セルと等高線を保存する() {
        let input = PathBuf::from(std::env::var_os("GEOCODE_DEM_SMOKE_INPUT").unwrap());
        let connection = connection();
        let context = OperationContext::default();
        let inspection = inspect_input(&input, ElevationDatumPolicy::AllowJgd20002011, &context);
        assert!(inspection.allowed, "{:?}", inspection.error);
        assert!(
            inspection.input_grids <= 2,
            "実資料試験は2格子までに限定します"
        );
        let (_, summary) = import_into_with_policy(
            &connection,
            &input,
            ElevationDatumPolicy::AllowJgd20002011,
            &context,
        )
        .unwrap();
        assert!(summary["input_grids"].as_u64().unwrap() <= 2);
        assert!(summary["ground_cells"].as_u64().unwrap() > 0);
        assert!(summary["contour_features"].as_u64().unwrap() > 0);
        validate_stored_summary(&connection, &summary).unwrap();
        println!("{summary}");
    }

    #[test]
    fn 未知CRS走査方向過大セルと不正標高を拒否する() {
        let base = xml(
            2,
            2,
            139.0,
            35.0,
            0.001,
            "地表面,0",
            "0 0",
            "fguuid:jgd2024.bl",
        );
        for bad in [
            base.replace("jgd2024.bl", "jgd9999.bl"),
            base.replace("+x-y", "+y+x"),
            base.replace("地表面,0", "地表面,NaN"),
            base.replace("1 1</gml:high>", "99999 99999</gml:high>"),
            base.replace("地表面,0", "水深,12"),
        ] {
            assert!(parse(&bad).is_err());
        }
    }
    #[test]
    fn チャンクの圧縮往復と展開長マスク検査() {
        let mut c = Chunk::empty();
        c.values[17] = -0.5;
        c.mask[17] = 1;
        let b = c.encode().unwrap();
        let decoded = Chunk::decode(&b).unwrap();
        assert_eq!(decoded.mask[17], 1);
        assert_eq!(decoded.values[17], -0.5);
        assert!(Chunk::decode(&[0; 8]).is_err());
        c.mask[0] = 3;
        assert!(Chunk::decode(&c.encode().unwrap()).is_err());
    }
    #[test]
    fn 固定格子のチャンク境界で双線形標高が連続する() {
        let c = connection();
        let context = OperationContext::default();
        let mut grid = Grid {
            resolution: 1000,
            x0: 319100,
            y0: 54300,
            width: 132,
            height: 4,
            values: Vec::new(),
            mask: vec![1; 132 * 4],
            crs: ElevationCrs::Jgd2024,
        };
        for y in 0..4 {
            for x in 0..132 {
                grid.values.push((x + y * 2) as f32);
            }
        }
        let mut batch = WriteBatch::new(&c).unwrap();
        store_grid(&c, &grid, &context, &mut batch).unwrap();
        batch.finish().unwrap();
        let nw = project(139.10, 35.7).unwrap();
        let se = project(139.232, 35.696).unwrap();
        let sampler =
            Sampler::new(&c, Rect::new(nw.x, se.x, nw.y, se.y).unwrap(), 20, &context).unwrap();
        for x in [1.0, 3.5, 27.5, 28.0, 64.0, 129.0] {
            let p = project(
                (grid.x0 as f64 + x + 0.5) / 1000.0 - 180.0,
                90.0 - (grid.y0 as f64 + 1.5) / 1000.0,
            )
            .unwrap();
            assert!((sampler.sample(p).unwrap() - ((x + 2.0) as f32)).abs() < 0.001);
        }
    }
    #[test]
    fn 完成標高と等高線は元入力を削除しても利用できる() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dem.xml");
        let values = (0..64)
            .map(|i| format!("地表面,{}", i % 8 * 20 + i / 8 * 10))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            &path,
            xml(
                8,
                8,
                139.696,
                35.696,
                0.001,
                &values,
                "0 0",
                "fguuid:jgd2024.bl",
            ),
        )
        .unwrap();
        let c = connection();
        let (sources, summary) = import_into(&c, &path, &OperationContext::default()).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(summary["cells"], 64);
        assert!(summary["contour_features"].as_u64().unwrap() > 0);
        fs::remove_file(path).unwrap();
        let p = project(139.6995, 35.7005).unwrap();
        let sampler = Sampler::new(
            &c,
            Rect::from_points(&[p]).unwrap(),
            18,
            &OperationContext::default(),
        )
        .unwrap();
        assert!(sampler.sample(p).is_some());
    }
    #[test]
    fn XMLとZIPの格納名容器日時を変えても入力識別は同じ() {
        let dir = tempfile::tempdir().unwrap();
        let text = xml(
            2,
            2,
            139.0,
            35.0,
            0.001,
            "地表面,0 地表面,20 地表面,40 地表面,60",
            "0 0",
            "fguuid:jgd2024.bl",
        );
        let xml_path = dir.path().join("source.xml");
        let zip_path = dir.path().join("pack.zip");
        fs::write(&xml_path, &text).unwrap();
        fs::write(
            &zip_path,
            zipped(text.as_bytes(), "../名前を使わない.xml", true),
        )
        .unwrap();
        let c = connection();
        let (a, _) = import_into(&c, &xml_path, &OperationContext::default()).unwrap();
        let c = connection();
        let (b, _) = import_into(&c, &zip_path, &OperationContext::default()).unwrap();
        assert_eq!(a[0].sha256, b[0].sha256);
        let mut bytes = fs::read(&zip_path).unwrap();
        bytes[14] ^= 1;
        fs::write(&zip_path, bytes).unwrap();
        // ローカルCRCは中央索引と照合するため、改ざんされたローカルヘッダーも拒否する。
        assert!(zip_inputs(&zip_path, 0, &OperationContext::default()).is_err());
    }
    #[test]
    fn 面が全欠損か基準面が混在する入力は完成成功にしない() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("none.xml");
        fs::write(
            &path,
            xml(
                2,
                2,
                139.0,
                35.0,
                0.001,
                "データなし,-9999",
                "0 0",
                "fguuid:jgd2024.bl",
            ),
        )
        .unwrap();
        assert!(import_into(&connection(), &path, &OperationContext::default()).is_err());
        fs::write(
            &path,
            xml(
                2,
                2,
                139.0,
                35.0,
                0.001,
                "地表面,1",
                "0 0",
                "fguuid:jgd2024.bl",
            ),
        )
        .unwrap();
        fs::write(
            dir.path().join("legacy.xml"),
            xml(
                2,
                2,
                139.0,
                35.0,
                0.001,
                "地表面,1",
                "0 0",
                "fguuid:jgd2011.bl",
            ),
        )
        .unwrap();
        assert!(import_into(&connection(), dir.path(), &OperationContext::default()).is_err());
    }
    #[test]
    fn 内容順の重複選択と明示priorityが保存場所に依存しない() {
        let dir = tempfile::tempdir().unwrap();
        for (name, value) in [("a.xml", 3), ("b.xml", 9)] {
            fs::write(
                dir.path().join(name),
                xml(
                    2,
                    2,
                    139.0,
                    35.0,
                    0.001,
                    &format!("地表面,{value}"),
                    "0 0",
                    "fguuid:jgd2024.bl",
                ),
            )
            .unwrap();
        }
        let first = dir.path().join("first.json");
        let second = dir.path().join("second.json");
        let a = json!({"files":[{"path":"a.xml","priority":2},{"path":"b.xml","priority":1}]});
        let b = json!({"files":[{"path":"b.xml","priority":1},{"path":"a.xml","priority":2}]});
        fs::write(&first, a.to_string()).unwrap();
        fs::write(&second, b.to_string()).unwrap();
        let c = connection();
        let (s, _) = import_into(&c, &first, &OperationContext::default()).unwrap();
        let d = connection();
        let (t, _) = import_into(&d, &second, &OperationContext::default()).unwrap();
        assert_eq!(s[0].sha256, t[0].sha256);
        let p = project(139.0005, 35.0015).unwrap();
        assert_eq!(
            Sampler::new(
                &c,
                Rect::from_points(&[p]).unwrap(),
                20,
                &OperationContext::default()
            )
            .unwrap()
            .sample(p),
            Some(3.0)
        );
    }

    #[test]
    fn 入力一覧の不正な優先度を既定値へ黙って置き換えない() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("inputs.json");
        fs::write(
            &input,
            json!({"files":[{"path":"source.xml","priority":"最高"}]}).to_string(),
        )
        .unwrap();
        let error =
            collect_files(&input, 0, 0, &mut Vec::new(), &OperationContext::default()).unwrap_err();
        assert!(error.to_string().contains("priority"));
    }

    #[test]
    fn 事前検査は原資料の混在方針と全文検査の範囲を区別する() {
        let dir = tempfile::tempdir().unwrap();
        for (name, crs) in [("old.xml", "jgd2000"), ("new.xml", "jgd2011")] {
            let text = xml(
                2,
                2,
                139.0,
                35.0,
                0.001,
                "未読の標高",
                "0 0",
                &format!("fguuid:{crs}.bl"),
            );
            fs::write(dir.path().join(name), text).unwrap();
        }
        let context = OperationContext::default();
        let strict = inspect_input(dir.path(), ElevationDatumPolicy::Strict, &context);
        assert!(!strict.allowed);
        assert_eq!(strict.exit_code, 2);
        assert!(strict.validation_complete);
        let allowed = inspect_input(dir.path(), ElevationDatumPolicy::AllowJgd20002011, &context);
        assert!(allowed.allowed, "{:?}", allowed.error);
        assert_eq!(allowed.validation_scope, "header-only");
        assert_eq!(allowed.input_grids, 2);
        assert_eq!(allowed.coordinate_system_counts["fguuid:jgd2000.bl"], 1);
        assert_eq!(allowed.coordinate_system_counts["fguuid:jgd2011.bl"], 1);
        assert_eq!(allowed.warnings.len(), 1);
        allowed.verify_unchanged(&context).unwrap();
        let error = import_into_with_policy(
            &connection(),
            dir.path(),
            ElevationDatumPolicy::AllowJgd20002011,
            &context,
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("DEM構成点が種別,標高の形式ではありません"));
        fs::write(dir.path().join("added.xml"), "<Dataset/>").unwrap();
        assert!(allowed.verify_unchanged(&context).is_err());
    }

    #[test]
    fn 混在検査は新標高の混入と取消と読取失敗を区別する() {
        let dir = tempfile::tempdir().unwrap();
        let context = OperationContext::default();
        for (name, crs) in [("old.xml", "jgd2000"), ("new.xml", "jgd2024")] {
            fs::write(
                dir.path().join(name),
                xml(
                    2,
                    2,
                    139.0,
                    35.0,
                    0.001,
                    "地表面,0",
                    "0 0",
                    &format!("fguuid:{crs}.bl"),
                ),
            )
            .unwrap();
        }
        let result = inspect_input(dir.path(), ElevationDatumPolicy::AllowJgd20002011, &context);
        assert_eq!(result.exit_code, 2);
        assert!(result.error.unwrap().contains("JGD2024"));
        let missing = inspect_input(
            &dir.path().join("missing.xml"),
            ElevationDatumPolicy::Strict,
            &context,
        );
        assert_eq!(missing.exit_code, 1);
        assert!(missing.error.unwrap().contains("missing.xml"));
        let token = crate::tilegen::cancel::CancellationToken::new();
        token.cancel();
        let cancelled = inspect_input(
            dir.path(),
            ElevationDatumPolicy::Strict,
            &OperationContext::new(token),
        );
        assert_eq!(cancelled.exit_code, 130);
    }

    #[test]
    fn 単独入力は混在の許可だけで識別や格子を変えない() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.xml");
        fs::write(
            &input,
            xml(
                2,
                2,
                139.0,
                35.0,
                0.001,
                "地表面,0 地表面,20 地表面,40 地表面,60",
                "0 0",
                "fguuid:jgd2000.bl",
            ),
        )
        .unwrap();
        let context = OperationContext::default();
        let strict = connection();
        let allow = connection();
        let (a, summary) =
            import_into_with_policy(&strict, &input, ElevationDatumPolicy::Strict, &context)
                .unwrap();
        let (b, other) = import_into_with_policy(
            &allow,
            &input,
            ElevationDatumPolicy::AllowJgd20002011,
            &context,
        )
        .unwrap();
        assert_eq!(a[0].sha256, b[0].sha256);
        assert_eq!(
            summary["effective_datum_policy"],
            other["effective_datum_policy"]
        );
        validate_stored_summary(&strict, &summary).unwrap();
        let mut bad = summary;
        bad["cells"] = json!(5);
        assert!(validate_stored_summary(&strict, &bad).is_err());
    }

    #[test]
    fn 空の自己終了標高配列は事前検査と本読取で欠損格子として一致する() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.xml");
        let empty = xml(2, 2, 139.0, 35.0, 0.001, "", "0 0", "fguuid:jgd2000.bl")
            .replace("<gml:tupleList></gml:tupleList>", "<gml:tupleList/>");
        assert!(empty.contains("<gml:tupleList/>"));
        fs::write(&path, &empty).unwrap();
        let report = inspect_input(
            &path,
            ElevationDatumPolicy::Strict,
            &OperationContext::default(),
        );
        assert!(report.allowed, "{:?}", report.error);
        assert_eq!(report.input_grids, 1);
        let grid = parse(&empty).unwrap();
        assert_eq!(grid.mask, vec![0; 4]);
        let error = import_into(&connection(), &path, &OperationContext::default()).unwrap_err();
        assert!(format!("{error:#}").contains("有効な地表・表層の標高セルがありません"));
    }

    #[test]
    fn 長いzip格納名の診断は文字境界で制限し内容は展開しない() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long-name.zip");
        let entry = format!("{}.xml", "名前🌏".repeat(300));
        let text = xml(
            2,
            2,
            139.0,
            35.0,
            0.001,
            "地表面,0",
            "0 0",
            "fguuid:jgd9999.bl",
        );
        fs::write(&path, zipped(text.as_bytes(), &entry, true)).unwrap();
        let inputs = zip_inputs(&path, 0, &OperationContext::default()).unwrap();
        let label = inputs[0].entry_name.as_ref().unwrap();
        assert_eq!(label.chars().count(), MAX_DIAGNOSTIC_ENTRY_CHARS + 1);
        assert!(label.ends_with('…'));
        let report = inspect_input(
            &path,
            ElevationDatumPolicy::Strict,
            &OperationContext::default(),
        );
        assert_eq!(report.exit_code, 2);
        let error = report.error.unwrap();
        assert!(error.contains(label));
        assert!(error.contains("jgd9999.bl"));
        assert!(error.len() < 2048);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn 鞍点と同値セルの等高線は再現可能で欠損を補完しない() {
        let mut output = BTreeMap::new();
        cell_segments(319000, 55000, [0.0, 40.0, 0.0, 40.0], 1000, &mut output).unwrap();
        assert_eq!(output[&20].len(), 2);
        let mut flat = BTreeMap::new();
        cell_segments(319000, 55000, [20.0; 4], 1000, &mut flat).unwrap();
        assert!(flat.is_empty());
    }
}
