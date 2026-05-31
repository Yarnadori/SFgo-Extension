export const MESSAGE_TYPE      = "sfgo-live-timing:dynamodb-response" as const;
export const VIDEO_SYNC_TYPE   = "sfgo-live-timing:video-sync"         as const;
export const VIDEO_CLOCK_TYPE  = "sfgo-live-timing:video-clock"        as const;
export const TELEMETRY_TYPE    = "sfgo-live-timing:telemetry-response" as const;

export interface DynamoString  { S: string }
export interface DynamoNumber  { N: string }
export interface DynamoBool    { BOOL: boolean }
export interface DynamoNull    { NULL: true }
export interface DynamoMap     { M: Record<string, DynamoValue> }
export interface DynamoList    { L: DynamoValue[] }
export interface DynamoSS      { SS: string[] }
export interface DynamoNS      { NS: string[] }

export type DynamoValue =
  | DynamoString
  | DynamoNumber
  | DynamoBool
  | DynamoNull
  | DynamoMap
  | DynamoList
  | DynamoSS
  | DynamoNS;

export type Scalar = string | number | boolean | null;
export type Expanded = Scalar | Expanded[] | { [k: string]: Expanded };

export interface TimingItem {
  CARNO:       string;
  DRIVER_J:    string;
  POS:         string;
  LAPS:        string;
  LAP_DISP:    string;
  LAST_DISP:   string;
  BEST_DISP:   string;
  BEST_TIME:   string;
  BEST_LAPS:   string;
  SEC1_DISP:   string;
  SEC2_DISP:   string;
  SEC3_DISP:   string;
  DIFF:         string;
  PIT_IN_COUNT: string;
  [key: string]: string;
}

export interface VideoSyncPayload {
  videoSyncOffset: number;  // ms: wallClock = videoSyncOffset + video.currentTime * 1000
  wallClockOffset: number;  // ms: current playback wallClock = Date.now() + wallClockOffset
}

export interface VideoClockPayload {
  currentTime:  number;
  capturedAt:   number;
  paused:       boolean;
  playbackRate: number;
}

export interface MessagePayload {
  transport:    "fetch" | "xhr";
  url:          string;
  requestBody:  string;
  responseText?: string;
  error?:       string;
  capturedAt:   number;
  videoCurrentTime?: number;
}
