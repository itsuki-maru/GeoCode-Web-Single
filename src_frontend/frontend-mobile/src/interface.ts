interface LoginUser {
  username?: string;
  isAuthenticated: boolean;
}

interface MapObjectData {
  id: string;
  layer_id: string;
  marker_name: string;
  latitude: number;
  longitude: number;
  detail: string;
  update_at: string;
}

interface MapObjectQueryResponse {
  markers: Record<string, MapObjectData>;
  shape_ids: string[];
}

interface ShapeStyle {
  color?: string;
  weight?: number;
  dashArray?: string | null;
  arrowType?: "none" | "start" | "end" | "both";
  fillColor?: string;
  fillOpacity?: number;
}

interface ShapeGeoJson {
  type: "Feature";
  properties: Record<string, unknown> & {
    style?: ShapeStyle;
    memo?: string | null;
    radius?: number;
  };
  geometry: {
    type: "Point" | "LineString" | "Polygon";
    coordinates: unknown;
  };
}

interface ShapeData {
  id: string;
  user_id: string;
  layer_id: string;
  shape_type: "circle" | "polyline" | "polygon" | "rectangle";
  name: string | null;
  geojson: ShapeGeoJson;
  created_at: string;
  updated_at: string;
}

type MapObjectUpdatePayload =
  | {
      objectType: "marker";
      id: string;
      layerId: string;
      name: string;
      detail: string;
      latitude: number;
      longitude: number;
    }
  | {
      objectType: "shape";
      id: string;
      layerId: string;
      shapeType: ShapeData["shape_type"];
      name: string;
      geojson: ShapeGeoJson;
    };

interface LayersData {
  id: string;
  user_id: string;
  name: string;
  is_master: boolean;
  marker_icon_id: string | null;
  marker_icon_filename: string | null;
}

interface UpdateMapObjectData {
  id: string;
  name: string;
  other?: string;
}

interface InitGeoCode {
  latitude: number;
  longitude: number;
}

interface ImageData {
  id: string;
  filename: string;
  uuid_filename: string;
}
interface MarkerIconData {
  id: string;
  filename: string;
  uuid_filename: string;
}

interface QueryForm {
  query1: string;
  query2: string;
}

interface ShareLayerCheckList {
  id: string;
  layerName: string;
  checked: boolean;
}

// アプリケーションの起動時情報
interface ApplicationInit {
  appTitle: string;
  allowUserAccountCreate: boolean;
  allowUserUpdatePassword: boolean;
  allowOrigins: string; // ex) http://localhost:3000,www.example.com
}

interface UploadProgressState {
  isOpen: boolean;
  phase: "preparing" | "uploading" | "finalizing";
  percent: number | null;
  fileName: string;
  message: string;
  loadedBytes?: number;
  totalBytes?: number;
}

export type {
  LoginUser,
  LayersData,
  MapObjectData,
  MapObjectQueryResponse,
  UpdateMapObjectData,
  InitGeoCode,
  ImageData,
  QueryForm,
  MarkerIconData,
  ShareLayerCheckList,
  ApplicationInit,
  UploadProgressState,
  ShapeStyle,
  ShapeGeoJson,
  ShapeData,
  MapObjectUpdatePayload,
};
