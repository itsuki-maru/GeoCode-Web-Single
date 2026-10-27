export interface TileServerRecord {
  attribution: string;
  id: number;
  include_foreign_tiles: boolean;
  label: string;
  layer_name: string;
  max_zoom: number | null;
  min_zoom: number | null;
  url: string;
}

export interface LayerRecord {
  id: string;
  is_master: boolean;
  layer_name: string;
  marker_icon_filename: string | null;
  marker_icon_id: string | null;
  user_id: string;
}

export interface MarkerRecord {
  detail: string;
  id: string;
  latitude: number;
  layer_id: string | null;
  longitude: number;
  marker_name: string;
  update_at?: string;
}

export interface ShapeRecord {
  created_at?: string;
  geojson: Record<string, unknown>;
  id: string;
  layer_id: string;
  name: string | null;
  shape_type: string;
  updated_at?: string;
  user_id: string;
}

export interface InitialMapView {
  latitude: number;
  longitude: number;
  zoom: number;
}

interface MapBootstrapBase {
  popupBodies?: import("./common/popup-content").PopupBodies;
  popupAnalysis?: Record<string, string>;
  tileOverlays?: import("./common/tile-overlays").TileOverlayRecord[];
  layers: Record<string, LayerRecord>;
  markers: Record<string, MarkerRecord>;
  tileServers: Record<string, TileServerRecord>;
}

export interface EditableMapBootstrap extends MapBootstrapBase {
  tileVisibilityAccountId?: string;
  initialView: InitialMapView;
  isMaster: boolean;
  markerId: string;
  page: "map" | "map-mobile";
  selectedLayer: string;
  shapes: ShapeRecord[];
}

export interface AnotherMapBootstrap extends MapBootstrapBase {
  answerPreview?:
    | {
        answerCount: number;
        targetCount: number;
        parentOrigin: string;
        requestId: string;
        initialView?: InitialMapView;
        analysis?: import("./answer-analysis").AnswerAnalysis;
        query?: Record<string, unknown>;
        targets?: string[];
      }
    | false;
  tileVisibilityAccountId?: string;
  initialView: InitialMapView;
  isCluster: boolean;
  page: "map-anather";
  shapes: ShapeRecord[];
}

export interface TemporaryMapBootstrap extends MapBootstrapBase {
  initialView: InitialMapView;
  isChecked: boolean;
  isOverlayTile?: boolean;
  isMapUiHidden: boolean;
  isMaster: false;
  page: "temporary-map" | "temporary-map-mobile";
  shapes: Record<string, ShapeRecord>;
}

export interface FormAnswerMapBootstrap
  extends Omit<AnotherMapBootstrap, "page" | "answerPreview"> {
  page: "form-answer-map";
  answerPreview: Exclude<AnotherMapBootstrap["answerPreview"], false | undefined>;
}

export type MapBootstrap =
  | AnotherMapBootstrap
  | FormAnswerMapBootstrap
  | EditableMapBootstrap
  | TemporaryMapBootstrap;
