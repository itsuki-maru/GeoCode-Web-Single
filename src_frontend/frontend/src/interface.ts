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
}

interface MapObjectQueryResponse {
  markers: Record<string, MapObjectData>;
  shape_ids: string[];
}

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
};
