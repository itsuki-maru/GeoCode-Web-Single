import { deflateSync } from 'node:zlib';

// 検証用データ・アイコン・手描き4文字には、自作の地図・フォント資材を使用する。
export const fixtureCenter = [35.68, 139.76];
const extent = 4096;
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
function varint(value) {
  const result = [];
  do { const part = value % 128; value = Math.floor(value / 128); result.push(part | (value ? 128 : 0)); } while (value);
  return Buffer.from(result);
}
const field = (tag, value) => Buffer.concat([varint(tag * 8 + 2), varint(bytes(value).length), bytes(value)]);
const integer = (tag, value) => Buffer.concat([varint(tag * 8), varint(value)]);
const zigzag = (value) => value < 0 ? -value * 2 - 1 : value * 2;
const packed = (tag, values) => field(tag, Buffer.concat(values.map(varint)));

function tilePoint([longitude, latitude], z, x, y) {
  const scale = 2 ** z;
  const sin = Math.sin(latitude * Math.PI / 180);
  return [
    Math.round(((longitude + 180) / 360 * scale - x) * extent),
    Math.round(((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale - y) * extent),
  ];
}

function geometry(coordinates, type, z, x, y) {
  const points = coordinates.map((point) => tilePoint(point, z, x, y));
  let previous = [0, 0];
  const delta = ([a, b]) => {
    const result = [zigzag(a - previous[0]), zigzag(b - previous[1])];
    previous = [a, b];
    return result;
  };
  const result = [9, ...delta(points[0])];
  if (points.length > 1) result.push(((points.length - 1) << 3) | 2, ...points.slice(1).flatMap(delta));
  if (type === 3) result.push(15);
  return result;
}

const features = [
  { kind: 'water', type: 3, points: [[139.783, 35.705], [139.82, 35.705], [139.82, 35.65], [139.783, 35.65]] },
  { kind: 'park', type: 3, points: [[139.761, 35.688], [139.774, 35.688], [139.774, 35.678], [139.761, 35.678]] },
  { kind: 'road', type: 2, points: [[139.72, 35.676], [139.748, 35.68], [139.8, 35.68]] },
  { kind: 'road', type: 2, points: [[139.75, 35.65], [139.754, 35.675], [139.756, 35.705]] },
  { kind: 'label', name: '東京', type: 1, points: [[139.748, 35.686]] },
  { kind: 'label', name: '公園', type: 1, points: [[139.767, 35.683]] },
  { kind: 'facility', type: 1, points: [[139.754, 35.678]] },
];

export function makeVectorTile(z, x, y) {
  const values = [...new Set(features.flatMap(({ kind, name }) => name ? [kind, name] : [kind]))];
  const encoded = features.map((feature, index) => {
    const tags = [0, values.indexOf(feature.kind)];
    if (feature.name) tags.push(1, values.indexOf(feature.name));
    return field(2, Buffer.concat([
      integer(1, index + 1), packed(2, tags), integer(3, feature.type),
      packed(4, geometry(feature.points, feature.type, z, x, y)),
    ]));
  });
  return field(3, Buffer.concat([
    field(1, 'basemap'), ...encoded, field(3, 'kind'), field(3, 'name'),
    ...values.map((value) => field(4, field(1, value))), integer(5, extent), integer(15, 2),
  ]));
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (name, data) => {
    const kind = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const raster = png(256, 256, (x, y) => {
  if (Math.abs(y - 128) < 8 || Math.abs(x - 128) < 6) return [255, 255, 255, 255];
  if ((x % 64) < 2 || (y % 64) < 2) return [192, 183, 160, 255];
  return [235, 227, 207, 255];
});
function sprite(scale = 1) {
  return png(24 * scale, 24 * scale, (px, py) => {
    const x = px / scale; const y = py / scale;
    if (Math.hypot(x - 11.5, y - 11.5) > 10.5) return [0, 0, 0, 0];
    if (Math.abs(x - 11.5) < 2 || Math.abs(y - 11.5) < 2) return [255, 255, 255, 255];
    return [20, 100, 180, 255];
  });
}

// 検証ラベル用に作成した、16×16グリッド上の線の座標。
const glyphStrokes = {
  '東': [[2,2,13,2],[7,0,7,15],[3,4,12,4],[3,4,3,10],[12,4,12,10],[3,7,12,7],[3,10,12,10],[7,10,0,15],[7,10,15,15]],
  '京': [[7,0,8,1],[1,3,14,3],[4,5,11,5],[4,5,4,9],[11,5,11,9],[4,9,11,9],[7,10,7,15],[4,11,1,14],[11,11,14,14]],
  '公': [[5,1,0,7],[10,1,15,7],[7,6,3,13],[3,13,13,13],[11,9,14,14]],
  '園': [[1,1,14,1],[1,1,1,15],[14,1,14,15],[1,15,14,15],[4,4,11,4],[7,2,7,6],[3,6,12,6],[4,8,11,8],[4,8,4,10],[11,8,11,10],[4,10,11,10],[7,10,4,13],[7,10,7,13],[7,13,10,12],[10,10,12,13]],
};
function glyphBitmap(character) {
  const dimension = 30;
  const points = glyphStrokes[character];
  const mask = new Uint8Array(dimension * dimension);
  const segmentDistance = (x, y, [x1, y1, x2, y2]) => {
    x1 = x1 * 1.35 + 4.5; x2 = x2 * 1.35 + 4.5;
    y1 = y1 * 1.35 + 4.5; y2 = y2 * 1.35 + 4.5;
    const distance = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    const factor = distance ? Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / distance)) : 0;
    return Math.hypot(x - x1 - factor * (x2 - x1), y - y1 - factor * (y2 - y1));
  };
  for (let y = 0; y < dimension; y++) for (let x = 0; x < dimension; x++) {
    mask[y * dimension + x] = points.some((stroke) => segmentDistance(x, y, stroke) < 0.85) ? 1 : 0;
  }
  const bitmap = Buffer.alloc(dimension * dimension);
  for (let y = 0; y < dimension; y++) for (let x = 0; x < dimension; x++) {
    const inside = mask[y * dimension + x];
    let distance = 8;
    for (let yy = Math.max(0, y - 8); yy < Math.min(dimension, y + 9); yy++) for (let xx = Math.max(0, x - 8); xx < Math.min(dimension, x + 9); xx++) {
      if (mask[yy * dimension + xx] !== inside) distance = Math.min(distance, Math.hypot(x - xx, y - yy) - 0.5);
    }
    bitmap[y * dimension + x] = Math.max(0, Math.min(255, Math.round(192 + (inside ? distance : -distance) * 32)));
  }
  return bitmap;
}
const glyphCache = new Map();
export function makeGlyphRange(range) {
  if (glyphCache.has(range)) return glyphCache.get(range);
  const [start, end] = range.split('-').map(Number);
  const glyphs = Object.keys(glyphStrokes).filter((c) => c.codePointAt(0) >= start && c.codePointAt(0) <= end).map((character) => field(3, Buffer.concat([
    integer(1, character.codePointAt(0)), field(2, glyphBitmap(character)), integer(3, 24), integer(4, 24),
    integer(5, zigzag(0)), integer(6, zigzag(22)), integer(7, 26),
  ])));
  const result = field(1, Buffer.concat([field(1, 'PoC CJK'), field(2, range), ...glyphs]));
  glyphCache.set(range, result);
  return result;
}

export function fixtureStyle(origin) {
  return {
    version: 8,
    name: 'GeoCode synthetic vector background',
    glyphs: `${origin}/fixtures/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/fixtures/sprite`,
    sources: {
      fixture: { type: 'vector', tiles: [`${origin}/fixtures/tiles/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 18, attribution: 'GeoCode-Web synthetic fixture' },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': '#eee6d5' } },
      { id: 'water', type: 'fill', source: 'fixture', 'source-layer': 'basemap', filter: ['==', 'kind', 'water'], paint: { 'fill-color': '#84c8ec' } },
      { id: 'park', type: 'fill', source: 'fixture', 'source-layer': 'basemap', filter: ['==', 'kind', 'park'], paint: { 'fill-color': '#99cf99', 'fill-outline-color': '#4f9957' } },
      { id: 'roads-case', type: 'line', source: 'fixture', 'source-layer': 'basemap', filter: ['==', 'kind', 'road'], paint: { 'line-color': '#baa877', 'line-width': 12 } },
      { id: 'roads', type: 'line', source: 'fixture', 'source-layer': 'basemap', filter: ['==', 'kind', 'road'], paint: { 'line-color': '#fffaf0', 'line-width': 8 } },
      { id: 'facility', type: 'symbol', source: 'fixture', 'source-layer': 'basemap', filter: ['==', 'kind', 'facility'], layout: { 'icon-image': 'facility', 'icon-allow-overlap': true } },
      { id: 'labels', type: 'symbol', source: 'fixture', 'source-layer': 'basemap', filter: ['==', 'kind', 'label'], layout: { 'text-field': '{name}', 'text-font': ['PoC CJK'], 'text-size': 24, 'text-allow-overlap': true }, paint: { 'text-color': '#173347', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } },
    ],
  };
}

export function fixtureResponse(pathname, origin) {
  if (pathname === '/fixtures/style.json') return { type: 'application/json', body: JSON.stringify(fixtureStyle(origin)) };
  if (pathname === '/fixtures/metadata.json') return { type: 'application/json', body: JSON.stringify({ center: fixtureCenter, labels: ['東京', '公園'], synthetic: true, glyphs: 'Four fixture-only hand-drawn SDF characters', sprite: 'facility' }) };
  const tile = /^\/fixtures\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(pathname);
  if (tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    if (z > 22 || x >= 2 ** z || y >= 2 ** z) return { status: 404, type: 'text/plain', body: 'Invalid tile' };
    return { type: 'application/vnd.mapbox-vector-tile', body: makeVectorTile(z, x, y) };
  }
  if (/^\/fixtures\/fonts\/[^/]+\/\d+-\d+\.pbf$/.test(pathname)) return { type: 'application/x-protobuf', body: makeGlyphRange(pathname.split('/').at(-1).replace('.pbf', '')) };
  if (/^\/fixtures\/raster(?:\/\d+\/\d+\/\d+)?\.png$/.test(pathname)) return { type: 'image/png', body: raster };
  if (pathname === '/fixtures/sprite.png') return { type: 'image/png', body: sprite() };
  if (pathname === '/fixtures/sprite@2x.png') return { type: 'image/png', body: sprite(2) };
  if (pathname === '/fixtures/sprite.json' || pathname === '/fixtures/sprite@2x.json') {
    const scale = pathname.includes('@2x') ? 2 : 1;
    return { type: 'application/json', body: JSON.stringify({ facility: { x: 0, y: 0, width: 24 * scale, height: 24 * scale, pixelRatio: scale } }) };
  }
  return null;
}
