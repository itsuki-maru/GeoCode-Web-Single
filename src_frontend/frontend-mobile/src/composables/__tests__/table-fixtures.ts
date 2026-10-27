import type { MapObjectData, ShapeData } from "@/interface";
export const marker = (id: string, name = id): MapObjectData => ({
  id,
  marker_name: name,
  layer_id: "a",
  latitude: 35,
  longitude: 139,
  detail: "",
  update_at: "2026-01-01 00:00:00",
});
export const shape = (id: string, name: string | null = id, vertices = 2): ShapeData => ({
  id,
  name,
  layer_id: "a",
  user_id: "user",
  shape_type: "polyline",
  created_at: "",
  updated_at: "2026-01-01 00:00:00",
  geojson: {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: Array.from({ length: vertices }, (_, i) => [139 + i / 1000, 35 + i / 1000]),
    },
  },
});
