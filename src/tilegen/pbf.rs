//! フレーム構造を明示的に検証し、使用量に上限を設けてOSM PBFを順次復号する。

use anyhow::{Context, Result, bail, ensure};
use flate2::{Decompress, FlushDecompress, Status};
use osmpbfreader::{fileformat, osmformat};
use protobuf::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_RAW_BYTES: usize = 32 * 1024 * 1024;
// 直列化したBlobには、圧縮形式とprotobufの付加情報も含まれる。
const MAX_ENCODED_BYTES: usize = MAX_RAW_BYTES + 64 * 1024;
const MAX_WAY_NODES: usize = 1_000_000;
const MAX_RELATION_MEMBERS: usize = 100_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: i64,
    pub lon: f64,
    pub lat: f64,
}

/// 名称対応の走査だけで実体化する、必要なタグを持つ独立Node。
#[derive(Debug, Clone, PartialEq)]
pub struct TaggedNode {
    pub node: Node,
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Way {
    pub id: i64,
    pub nodes: Vec<i64>,
    pub tags: BTreeMap<String, String>,
}

/// 面の構築に必要なRelationの参照種別。道路専用走査では実体化しない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemberKind {
    Node,
    Way,
    Relation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub id: i64,
    pub kind: MemberKind,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relation {
    pub id: i64,
    pub members: Vec<Member>,
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Object {
    Node(Node),
    TaggedNode(TaggedNode),
    Way(Way),
    Relation(Relation),
}

#[derive(Debug, Clone)]
pub struct ScanReport {
    pub source_sha256: String,
    pub bytes: u64,
    /// PBFヘッダーに含まれる場合の、Unix秒で表した複製タイムスタンプ。
    pub timestamp: Option<String>,
}

/// PBF全体ではなく、先頭のOSMHeaderフレームから取得して検証したメタデータ。
#[derive(Debug, Clone, Serialize)]
pub struct HeaderProbe {
    pub scope: &'static str,
    pub file_bytes: u64,
    pub header_bytes_read: u64,
    pub header_sha256: String,
    pub required_features: Vec<String>,
    pub optional_features: Vec<String>,
    pub replication_timestamp_unix: Option<i64>,
    pub writing_program: Option<String>,
    pub source: Option<String>,
    pub build_id: &'static str,
}

struct Frame {
    kind: String,
    payload: Vec<u8>,
    encoded_bytes: u64,
}

/// [`scan`]とフレーム構造・展開・対応機能の検査を共用し、先頭フレームだけを読む。
/// 後続フレームは読み取らず、検証もしない。
/// 全体走査とは異なり、この事前検査ではOSMHeaderが先頭フレームであることを要求する。
pub fn probe_header(path: &Path) -> Result<HeaderProbe> {
    let file = File::open(path).with_context(|| format!("opening PBF {}", path.display()))?;
    let file_bytes = file.metadata()?.len();
    // OSMDataまで先読みする可能性があるため、このFileをBufReaderで包まない。
    let mut reader = HashedReader {
        inner: file,
        hash: Sha256::new(),
        bytes: 0,
    };
    let frame =
        read_frame(&mut reader, 1)?.context("PBF does not contain a first OSMHeader frame")?;
    ensure!(
        frame.kind == "OSMHeader",
        "first PBF frame is {}; expected OSMHeader",
        frame.kind
    );
    let header = validate_header(&frame.payload)?;
    Ok(HeaderProbe {
        scope: "first_osm_header_only",
        file_bytes,
        header_bytes_read: frame.encoded_bytes,
        header_sha256: format!("{:x}", reader.hash.finalize()),
        required_features: header.required_features,
        optional_features: header.optional_features,
        replication_timestamp_unix: header.osmosis_replication_timestamp,
        writing_program: header.writingprogram,
        source: header.source,
        build_id: env!("TILEGEN_BUILD_ID"),
    })
}

struct HashedReader<R> {
    inner: R,
    hash: Sha256,
    bytes: u64,
}

impl<R: Read> Read for HashedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.hash.update(&buffer[..count]);
        self.bytes = self.bytes.checked_add(count as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "input length overflow")
        })?;
        Ok(count)
    }
}

/// データセット全体をメモリへ保持せず、NodeとWayを順に処理する。
///
/// この走査では入力の全バイトをハッシュへ反映する。未知のブロック種別は、
/// フレーム構造と圧縮形式の検証後に無視する。Relationは実体化しない。
/// 各圧縮ブロックは一度だけ展開する。
pub fn scan(path: &Path, visitor: impl FnMut(Object) -> Result<()>) -> Result<ScanReport> {
    scan_with_check(path, visitor, || Ok(()))
}

/// 操作単位の取り込みに使う、検査付きの走査。
/// protobufの解析と上限付きの展開呼び出しは途中で中断できないため、各呼び出しの前後で検査する。
pub(crate) fn scan_with_check(
    path: &Path,
    visitor: impl FnMut(Object) -> Result<()>,
    check: impl FnMut() -> Result<()>,
) -> Result<ScanReport> {
    scan_selected(path, visitor, check, false, false)
}

/// 新形式だけが使用する、Relationを含む上限付き走査。
pub(crate) fn scan_all_with_check(
    path: &Path,
    visitor: impl FnMut(Object) -> Result<()>,
    check: impl FnMut() -> Result<()>,
) -> Result<ScanReport> {
    scan_selected(path, visitor, check, true, false)
}

/// 旧走査のNode型や割当量を変えず、名称に必要なNodeタグだけを追加取得する。
pub(crate) fn scan_with_node_tags_with_check(
    path: &Path,
    visitor: impl FnMut(Object) -> Result<()>,
    check: impl FnMut() -> Result<()>,
) -> Result<ScanReport> {
    scan_selected(path, visitor, check, false, true)
}

fn scan_selected(
    path: &Path,
    mut visitor: impl FnMut(Object) -> Result<()>,
    mut check: impl FnMut() -> Result<()>,
    relations: bool,
    node_tags: bool,
) -> Result<ScanReport> {
    check()?;
    let file = File::open(path).with_context(|| format!("opening PBF {}", path.display()))?;
    let mut reader = HashedReader {
        inner: BufReader::new(file),
        hash: Sha256::new(),
        bytes: 0,
    };
    let mut seen_header = false;
    let mut dense_enabled = false;
    let mut timestamp = None;
    let mut frame = 0_u64;

    while let Some(decoded) = read_frame_with_check(&mut reader, frame + 1, &mut check)? {
        check()?;
        frame += 1;
        match decoded.kind.as_str() {
            "OSMHeader" => {
                ensure!(!seen_header, "PBF contains more than one OSMHeader");
                let header = validate_header(&decoded.payload)?;
                dense_enabled = header.required_features.iter().any(|s| s == "DenseNodes");
                timestamp = header
                    .osmosis_replication_timestamp
                    .map(|value| value.to_string());
                seen_header = true;
            },
            "OSMData" => {
                ensure!(seen_header, "OSMData appeared before OSMHeader");
                let block = osmformat::PrimitiveBlock::parse_from_bytes(&decoded.payload)
                    .with_context(|| format!("PBF frame {frame}: malformed PrimitiveBlock"))?;
                check()?;
                visit_block_selected_with_tags(
                    &block,
                    dense_enabled,
                    &mut visitor,
                    &mut check,
                    relations,
                    node_tags,
                )
                .with_context(|| format!("PBF frame {frame}: invalid OSMData"))?;
            },
            _ => {},
        }
    }
    ensure!(seen_header, "PBF does not contain an OSMHeader");
    check()?;
    Ok(ScanReport {
        source_sha256: format!("{:x}", reader.hash.finalize()),
        bytes: reader.bytes,
        timestamp,
    })
}

fn validate_header(payload: &[u8]) -> Result<osmformat::HeaderBlock> {
    let header =
        osmformat::HeaderBlock::parse_from_bytes(payload).context("malformed OSMHeader")?;
    ensure!(
        header
            .required_features
            .iter()
            .any(|s| s == "OsmSchema-V0.6"),
        "PBF is missing the OsmSchema-V0.6 required feature"
    );
    for feature in &header.required_features {
        match feature.as_str() {
            "OsmSchema-V0.6" | "DenseNodes" => {},
            "HistoricalInformation" => bail!("historical PBF input is not supported"),
            other => bail!("unsupported required PBF feature: {other}"),
        }
    }
    Ok(header)
}

fn read_frame(reader: &mut impl Read, frame: u64) -> Result<Option<Frame>> {
    read_frame_with_check(reader, frame, &mut || Ok(()))
}

fn read_frame_with_check(
    reader: &mut impl Read,
    frame: u64,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Option<Frame>> {
    check()?;
    let Some(length) = read_header_length(reader)
        .with_context(|| format!("reading PBF frame length at frame {frame}"))?
    else {
        return Ok(None);
    };
    let length = length as usize;
    ensure!(
        length > 0 && length < MAX_HEADER_BYTES,
        "PBF frame {frame}: invalid BlobHeader length {length}"
    );
    let mut header_bytes = vec![0; length];
    read_exact_checked(reader, &mut header_bytes, check)
        .with_context(|| format!("PBF frame {frame}: truncated BlobHeader"))?;
    let header = fileformat::BlobHeader::parse_from_bytes(&header_bytes)
        .with_context(|| format!("PBF frame {frame}: malformed BlobHeader"))?;
    let size = header.datasize();
    ensure!(
        size > 0 && size as usize <= MAX_ENCODED_BYTES,
        "PBF frame {frame}: invalid Blob length {size}"
    );
    let mut bytes = vec![0; size as usize];
    read_exact_checked(reader, &mut bytes, check)
        .with_context(|| format!("PBF frame {frame}: truncated Blob"))?;
    let blob = fileformat::Blob::parse_from_bytes(&bytes)
        .with_context(|| format!("PBF frame {frame}: malformed Blob"))?;
    check()?;
    let payload = expand_blob(&blob)
        .with_context(|| format!("PBF frame {frame}: decoding {}", header.type_()))?;
    check()?;
    Ok(Some(Frame {
        kind: header.type_().to_owned(),
        payload,
        encoded_bytes: 4 + length as u64 + size as u64,
    }))
}

fn read_exact_checked(
    reader: &mut impl Read,
    bytes: &mut [u8],
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    for chunk in bytes.chunks_mut(64 * 1024) {
        check()?;
        reader.read_exact(chunk)?;
    }
    check()
}

fn read_header_length(reader: &mut impl Read) -> Result<Option<u32>> {
    let mut bytes = [0_u8; 4];
    let mut filled = 0;
    while filled < bytes.len() {
        match reader.read(&mut bytes[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => bail!("truncated PBF frame length: {filled} of 4 bytes"),
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(Some(u32::from_be_bytes(bytes)))
}

fn expand_blob(blob: &fileformat::Blob) -> Result<Vec<u8>> {
    let unsupported = blob.lzma_data.is_some()
        || blob.OBSOLETE_bzip2_data.is_some()
        || blob
            .special_fields
            .unknown_fields()
            .iter()
            .any(|(field, _)| matches!(field, 6 | 7));
    ensure!(
        !unsupported,
        "unsupported Blob compression (only raw/zlib are supported)"
    );
    ensure!(
        usize::from(blob.raw.is_some()) + usize::from(blob.zlib_data.is_some()) == 1,
        "Blob must contain exactly one raw or zlib payload"
    );
    if let Some(raw) = &blob.raw {
        ensure!(
            raw.len() < MAX_RAW_BYTES,
            "raw Blob exceeds the 32 MiB limit"
        );
        if let Some(expected) = blob.raw_size {
            ensure!(
                expected >= 0 && expected as usize == raw.len(),
                "raw_size mismatch"
            );
        }
        return Ok(raw.clone());
    }
    let expected = blob.raw_size.context("zlib Blob is missing raw_size")?;
    ensure!(
        expected >= 0 && (expected as usize) < MAX_RAW_BYTES,
        "invalid zlib raw_size {expected}"
    );
    let compressed = blob.zlib_data.as_deref().context("missing zlib payload")?;
    let mut decoder = Decompress::new(true);
    // 宣言サイズより1バイト多く読むことで、任意の巨大な圧縮ストリームを
    // 展開しきることなく、不正なraw_sizeを検出する。
    let mut raw = Vec::with_capacity(expected as usize + 1);
    let status = decoder
        .decompress_vec(compressed, &mut raw, FlushDecompress::Finish)
        .context("invalid zlib stream")?;
    ensure!(
        status == Status::StreamEnd,
        "truncated zlib stream or raw_size too small"
    );
    ensure!(
        raw.len() < MAX_RAW_BYTES,
        "expanded Blob exceeds the 32 MiB limit"
    );
    ensure!(raw.len() == expected as usize, "zlib raw_size mismatch");
    ensure!(
        decoder.total_in() as usize == compressed.len(),
        "trailing bytes in zlib payload"
    );
    Ok(raw)
}

#[cfg(test)]
fn visit_block(
    block: &osmformat::PrimitiveBlock,
    dense_enabled: bool,
    visitor: &mut impl FnMut(Object) -> Result<()>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    visit_block_selected(block, dense_enabled, visitor, check, false)
}

#[cfg(test)]
fn visit_block_selected(
    block: &osmformat::PrimitiveBlock,
    dense_enabled: bool,
    visitor: &mut impl FnMut(Object) -> Result<()>,
    check: &mut impl FnMut() -> Result<()>,
    relations: bool,
) -> Result<()> {
    visit_block_selected_with_tags(block, dense_enabled, visitor, check, relations, false)
}

fn selected_node_tag(key: &str) -> bool {
    matches!(
        key,
        "name"
            | "name:ja"
            | "name:en"
            | "int_name"
            | "short_name"
            | "place"
            | "population"
            | "capital"
            | "admin_level"
            | "natural"
            | "ele"
            | "railway"
            | "aeroway"
            | "amenity"
            | "leisure"
            | "tourism"
            | "historic"
            | "waterway"
            | "water"
            | "boundary"
    )
}

fn visit_block_selected_with_tags(
    block: &osmformat::PrimitiveBlock,
    dense_enabled: bool,
    visitor: &mut impl FnMut(Object) -> Result<()>,
    check: &mut impl FnMut() -> Result<()>,
    relations: bool,
    node_tags: bool,
) -> Result<()> {
    check()?;
    ensure!(block.granularity() > 0, "invalid coordinate granularity");
    let strings = &block
        .stringtable
        .as_ref()
        .context("missing string table")?
        .s;
    ensure!(
        strings.first().is_some_and(Vec::is_empty),
        "string table entry 0 must be empty"
    );
    for group in &block.primitivegroup {
        check()?;
        for node in &group.nodes {
            check()?;
            validate_tags(&node.keys, &node.vals, strings, check)?;
            ensure!(
                node.info
                    .as_ref()
                    .is_none_or(|info| info.visible.is_none_or(|visible| visible)),
                "deleted Node {} in snapshot",
                node.id()
            );
            let node_value = Node {
                id: node.id(),
                lon: coordinate(node.lon(), block.lon_offset(), block.granularity(), 180.0)?,
                lat: coordinate(node.lat(), block.lat_offset(), block.granularity(), 90.0)?,
            };
            if node_tags {
                let mut tags = BTreeMap::new();
                for (key, value) in node.keys.iter().zip(&node.vals) {
                    let key = string(strings, *key)?;
                    if selected_node_tag(key) {
                        let value = string(strings, *value)?;
                        let value = if value.len() <= 4096 { value } else { "\u{7f}" };
                        ensure!(
                            tags.insert(key.to_owned(), value.to_owned()).is_none(),
                            "Nodeの選択タグが重複しています"
                        );
                    }
                }
                visitor(Object::TaggedNode(TaggedNode {
                    node: node_value,
                    tags,
                }))?;
            } else {
                visitor(Object::Node(node_value))?;
            }
        }
        if let Some(dense) = group.dense.as_ref() {
            ensure!(
                dense_enabled,
                "DenseNodes data is missing the required feature declaration"
            );
            ensure!(
                dense.id.len() == dense.lat.len() && dense.id.len() == dense.lon.len(),
                "DenseNodes array lengths differ"
            );
            if let Some(info) = dense.denseinfo.as_ref() {
                ensure!(
                    info.visible.is_empty() || info.visible.len() == dense.id.len(),
                    "DenseInfo visibility length differs"
                );
                ensure!(
                    info.visible.iter().all(|visible| *visible),
                    "deleted DenseNode in snapshot"
                );
            }
            let mut id = 0_i64;
            let mut lon = 0_i64;
            let mut lat = 0_i64;
            let mut tag_offset = 0_usize;
            for (index, ((delta_id, delta_lon), delta_lat)) in
                dense.id.iter().zip(&dense.lon).zip(&dense.lat).enumerate()
            {
                if index.is_multiple_of(1024) {
                    check()?;
                }
                id = id.checked_add(*delta_id).context("DenseNode ID overflow")?;
                lon = lon
                    .checked_add(*delta_lon)
                    .context("DenseNode longitude overflow")?;
                lat = lat
                    .checked_add(*delta_lat)
                    .context("DenseNode latitude overflow")?;
                let mut tags = BTreeMap::new();
                if !dense.keys_vals.is_empty() {
                    loop {
                        if tag_offset.is_multiple_of(1024) {
                            check()?;
                        }
                        let key = *dense
                            .keys_vals
                            .get(tag_offset)
                            .context("missing DenseNode tag terminator")?;
                        tag_offset += 1;
                        if key == 0 {
                            break;
                        }
                        let value = *dense
                            .keys_vals
                            .get(tag_offset)
                            .context("missing DenseNode tag value")?;
                        tag_offset += 1;
                        ensure!(key > 0 && value >= 0, "negative DenseNode string index");
                        let key = string(strings, key as u32)?;
                        let value = string(strings, value as u32)?;
                        if node_tags && selected_node_tag(key) {
                            let value = if value.len() <= 4096 { value } else { "\u{7f}" };
                            ensure!(
                                tags.insert(key.to_owned(), value.to_owned()).is_none(),
                                "DenseNodeの選択タグが重複しています"
                            );
                        }
                    }
                }
                let node_value = Node {
                    id,
                    lon: coordinate(lon, block.lon_offset(), block.granularity(), 180.0)?,
                    lat: coordinate(lat, block.lat_offset(), block.granularity(), 90.0)?,
                };
                if node_tags {
                    visitor(Object::TaggedNode(TaggedNode {
                        node: node_value,
                        tags,
                    }))?;
                } else {
                    visitor(Object::Node(node_value))?;
                }
            }
            ensure!(
                tag_offset == dense.keys_vals.len(),
                "extra DenseNode tag data"
            );
        }
        for way in &group.ways {
            check()?;
            ensure!(
                way.refs.len() <= MAX_WAY_NODES,
                "Way {} exceeds the Node reference limit",
                way.id()
            );
            ensure!(
                way.info
                    .as_ref()
                    .is_none_or(|info| info.visible.is_none_or(|visible| visible)),
                "deleted Way {} in snapshot",
                way.id()
            );
            validate_tags(&way.keys, &way.vals, strings, check)?;
            let mut tags = BTreeMap::new();
            for (index, (key, value)) in way.keys.iter().zip(&way.vals).enumerate() {
                if index.is_multiple_of(1024) {
                    check()?;
                }
                let key = string(strings, *key)?.to_owned();
                ensure!(
                    tags.insert(key, string(strings, *value)?.to_owned())
                        .is_none(),
                    "duplicate tag key on Way {}",
                    way.id()
                );
            }
            let mut id = 0_i64;
            let mut nodes = Vec::with_capacity(way.refs.len());
            for (index, delta) in way.refs.iter().enumerate() {
                if index.is_multiple_of(1024) {
                    check()?;
                }
                id = id
                    .checked_add(*delta)
                    .context("Way Node reference overflow")?;
                nodes.push(id);
            }
            visitor(Object::Way(Way {
                id: way.id(),
                nodes,
                tags,
            }))?;
        }
        if relations {
            for relation in &group.relations {
                check()?;
                let count = relation.memids.len();
                ensure!(
                    count <= MAX_RELATION_MEMBERS,
                    "Relationのmember数が上限を超えました"
                );
                ensure!(
                    count == relation.roles_sid.len() && count == relation.types.len(),
                    "Relationのmember配列長が一致しません"
                );
                ensure!(
                    relation
                        .info
                        .as_ref()
                        .is_none_or(|info| info.visible.is_none_or(|visible| visible)),
                    "削除済みRelationを含むPBFには対応していません"
                );
                validate_tags(&relation.keys, &relation.vals, strings, check)?;
                let mut tags = BTreeMap::new();
                for (key, value) in relation.keys.iter().zip(&relation.vals) {
                    ensure!(
                        tags.insert(
                            string(strings, *key)?.to_owned(),
                            string(strings, *value)?.to_owned()
                        )
                        .is_none(),
                        "Relationのタグが重複しています"
                    );
                }
                let mut id = 0_i64;
                let mut members = Vec::with_capacity(count);
                for (index, ((delta, role), kind)) in relation
                    .memids
                    .iter()
                    .zip(&relation.roles_sid)
                    .zip(&relation.types)
                    .enumerate()
                {
                    if index.is_multiple_of(1024) {
                        check()?;
                    }
                    id = id
                        .checked_add(*delta)
                        .context("Relationの参照IDが桁あふれしました")?;
                    ensure!(*role >= 0, "Relationのrole参照が不正です");
                    let role = string(strings, *role as u32)?;
                    ensure!(role.len() <= 256, "Relationのroleが上限を超えました");
                    let kind = match kind.value() {
                        0 => MemberKind::Node,
                        1 => MemberKind::Way,
                        2 => MemberKind::Relation,
                        _ => bail!("未知のRelation参照種別です"),
                    };
                    members.push(Member {
                        id,
                        kind,
                        role: role.to_owned(),
                    });
                }
                visitor(Object::Relation(Relation {
                    id: relation.id(),
                    members,
                    tags,
                }))?;
            }
        }
    }
    check()
}

fn string(strings: &[Vec<u8>], index: u32) -> Result<&str> {
    let value = strings
        .get(index as usize)
        .with_context(|| format!("invalid string index {index}"))?;
    std::str::from_utf8(value).context("invalid UTF-8 in OSM tag")
}

fn validate_tags(
    keys: &[u32],
    values: &[u32],
    strings: &[Vec<u8>],
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    ensure!(keys.len() == values.len(), "tag key/value lengths differ");
    for (index, (key, value)) in keys.iter().zip(values).enumerate() {
        if index.is_multiple_of(1024) {
            check()?;
        }
        string(strings, *key)?;
        string(strings, *value)?;
    }
    Ok(())
}

fn coordinate(value: i64, offset: i64, granularity: i32, limit: f64) -> Result<f64> {
    let nanodegrees = i128::from(offset) + i128::from(granularity) * i128::from(value);
    let degrees = nanodegrees as f64 * 1e-9;
    ensure!(
        degrees.is_finite() && degrees.abs() <= limit,
        "invalid OSM coordinate {degrees}"
    );
    Ok(degrees)
}

#[cfg(test)]
mod checked_tests {
    use super::*;

    #[test]
    fn 通常と密なnodeの選択タグを旧走査から分離する() -> Result<()> {
        for dense in [false, true] {
            let mut fixture = crate::tilegen::test_support::Fixture::sample();
            fixture.dense = dense;
            fixture.node_tags.insert(
                1,
                BTreeMap::from([
                    ("place".into(), "town".into()),
                    ("name:ja".into(), "東の町".into()),
                    ("unused".into(), "保持しない".into()),
                ]),
            );
            let directory = tempfile::tempdir()?;
            let path = directory.path().join("tagged.pbf");
            fixture.write(&path);
            let mut old = Vec::new();
            let before = scan(&path, |object| {
                old.push(object);
                Ok(())
            })?;
            assert!(
                !old.iter()
                    .any(|object| matches!(object, Object::TaggedNode(_)))
            );
            let mut tagged = Vec::new();
            let after = scan_with_node_tags_with_check(
                &path,
                |object| {
                    if let Object::TaggedNode(node) = object {
                        tagged.push(node);
                    }
                    Ok(())
                },
                || Ok(()),
            )?;
            assert_eq!(before.source_sha256, after.source_sha256);
            assert_eq!(
                tagged[0].tags.get("name:ja").map(String::as_str),
                Some("東の町")
            );
            assert!(!tagged[0].tags.contains_key("unused"));
            assert_eq!(tagged[0].node, fixture.nodes[0]);
        }
        Ok(())
    }

    #[test]
    fn 関係の走査は新形式でだけ有効にし逆順圧縮入力も読める() -> Result<()> {
        for compressed in [false, true] {
            for relations_first in [false, true] {
                let mut fixture = crate::tilegen::test_support::Fixture::sample();
                fixture.zlib = compressed;
                fixture.dense = compressed;
                fixture.relations_first = relations_first;
                fixture.relations.push(Relation {
                    id: 70,
                    tags: BTreeMap::from([
                        ("type".into(), "multipolygon".into()),
                        ("building".into(), "yes".into()),
                    ]),
                    members: vec![
                        Member {
                            id: 10,
                            kind: MemberKind::Way,
                            role: "outer".into(),
                        },
                        Member {
                            id: 9,
                            kind: MemberKind::Way,
                            role: "inner".into(),
                        },
                    ],
                });
                let directory = tempfile::tempdir()?;
                let path = directory.path().join("relation.pbf");
                fixture.write(&path);
                let mut old = Vec::new();
                let a = scan(&path, |o| {
                    old.push(o);
                    Ok(())
                })?;
                assert!(old.iter().all(|o| !matches!(o, Object::Relation(_))));
                let mut new = Vec::new();
                let b = scan_all_with_check(
                    &path,
                    |o| {
                        new.push(o);
                        Ok(())
                    },
                    || Ok(()),
                )?;
                assert_eq!(a.source_sha256, b.source_sha256);
                let relations: Vec<_> = new
                    .into_iter()
                    .filter_map(|o| {
                        if let Object::Relation(r) = o {
                            Some(r)
                        } else {
                            None
                        }
                    })
                    .collect();
                assert_eq!(relations, fixture.relations);
            }
        }
        Ok(())
    }

    #[test]
    fn long_way_references_can_stop_before_visiting_the_materialized_way() -> Result<()> {
        let mut fixture = crate::tilegen::test_support::Fixture::sample();
        fixture.ways_first = true;
        fixture.ways[0].nodes = vec![1; 20_000];
        let bytes = fixture.bytes();
        let mut reader = bytes.as_slice();
        read_frame(&mut reader, 1)?.context("fixture header")?;
        let data = read_frame(&mut reader, 2)?.context("fixture data")?;
        let block = osmformat::PrimitiveBlock::parse_from_bytes(&data.payload)?;
        let mut visited = 0;
        let mut checks = 0;
        let error = visit_block(
            &block,
            true,
            &mut |_| {
                visited += 1;
                Ok(())
            },
            &mut || {
                checks += 1;
                if checks == 10 {
                    bail!(crate::tilegen::cancel::Interrupted);
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error));
        assert_eq!(visited, 0);
        Ok(())
    }
}
