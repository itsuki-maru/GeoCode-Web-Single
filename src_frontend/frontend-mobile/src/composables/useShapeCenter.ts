import type { ShapeData } from "@/interface";

export interface ShapeCenter {
  latitude: number;
  longitude: number;
}

const isPosition = (value: unknown): value is [number, number, ...unknown[]] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === "number" &&
  Number.isFinite(value[0]) &&
  typeof value[1] === "number" &&
  Number.isFinite(value[1]);

export const getShapeCenter = (shape: ShapeData): ShapeCenter | null => {
  const coordinates = shape.geojson.geometry.coordinates;
  let positions: [number, number, ...unknown[]][] = [];

  if (shape.geojson.geometry.type === "Point" && isPosition(coordinates)) {
    positions = [coordinates];
  } else if (shape.geojson.geometry.type === "LineString" && Array.isArray(coordinates)) {
    positions = coordinates.filter(isPosition);
  } else if (shape.geojson.geometry.type === "Polygon" && Array.isArray(coordinates)) {
    const exteriorRing = coordinates[0];
    if (Array.isArray(exteriorRing)) positions = exteriorRing.filter(isPosition);
    if (
      positions.length > 1 &&
      positions[0]?.[0] === positions[positions.length - 1]?.[0] &&
      positions[0]?.[1] === positions[positions.length - 1]?.[1]
    ) {
      positions = positions.slice(0, -1);
    }
  }

  if (positions.length === 0) return null;
  const total = positions.reduce(
    (result, position) => ({
      longitude: result.longitude + position[0],
      latitude: result.latitude + position[1],
    }),
    { latitude: 0, longitude: 0 },
  );
  return {
    latitude: total.latitude / positions.length,
    longitude: total.longitude / positions.length,
  };
};
