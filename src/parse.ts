import { type Expanded, type TimingItem } from "./types";

export interface LapRow {
  key:        string;
  carNo:      string;
  position:   string;
  lap:        string;
  lapTime:    string;
  lastTime:   string;
  bestTime:   string;
  sector1:    string;
  sector2:    string;
  sector3:    string;
  currentSec: string;
  isFastest:  boolean;
  createdAt:  number;
  sessionStartAt: number;
}

export interface TelemetryLapSample {
  carNo:     string;
  lap:       string;
  lapTimeMs: number;
  createdAt: number;
  speedKmh:  number | null;
}

export interface TelemetryQueryWindow {
  fromDate: number;
  toDate:   number;
  carNo:    string;
}

export function extractLapRows(responseText: string, requestBody: string): LapRow[] {
  const parsed = tryParseJson(responseText);
  if (!parsed) return [];
  const queryDate = (tryParseJson(requestBody) as { ExpressionAttributeValues?: { ":date"?: { S?: string } } } | null)
    ?.ExpressionAttributeValues?.[":date"]?.S ?? "";
  const { timings, lapBestTime, createdAt, sessionStartAt } = latestLiveTimings(expandJsonStrings(fromDynamoValue(parsed)));
  return timings.map((item) => toLapRow(item, queryDate, lapBestTime, createdAt, sessionStartAt)).filter((r): r is LapRow => r !== null);
}

export function extractTelemetryLapSamples(responseText: string): TelemetryLapSample[] {
  const parsed = tryParseJson(responseText);
  if (!parsed) return [];

  const value = expandJsonStrings(fromDynamoValue(parsed)) as { Items?: Expanded[] };
  if (!Array.isArray(value.Items)) return [];

  const samples = value.Items
    .map((item) => flattenObject(item as Record<string, Expanded>))
    .map((item): TelemetryLapSample | null => {
      const createdAt = Number(item.createdDate ?? 0);
      const lapTimeMs = Number(item.laptime ?? 0);
      const carNo = normalizeCarNo(String(item.carNo ?? item.carNumber ?? ""));
      if (!carNo || !createdAt || !lapTimeMs) return null;
      return {
        carNo,
        lap: String(item.lapctr ?? ""),
        lapTimeMs,
        createdAt,
        speedKmh: Number.isFinite(Number(item.Car_Speed)) ? Number(item.Car_Speed) : null,
      };
    })
    .filter((sample): sample is TelemetryLapSample => sample !== null)
    .sort((a, b) => a.createdAt - b.createdAt);

  return samples;
}

export function extractTelemetryQueryWindow(requestBody: string): TelemetryQueryWindow | null {
  const parsed = tryParseJson(requestBody) as {
    ExpressionAttributeValues?: {
      ":date_carNo"?: { S?: string };
      ":fromDate"?: { N?: string };
      ":toDate"?: { N?: string };
    };
  } | null;
  const values = parsed?.ExpressionAttributeValues;
  const fromDate = Number(values?.[":fromDate"]?.N ?? 0);
  const toDate = Number(values?.[":toDate"]?.N ?? 0);
  if (!fromDate || !toDate || toDate <= fromDate) return null;
  const dateCarNo = values?.[":date_carNo"]?.S ?? "";
  return {
    fromDate,
    toDate,
    carNo: normalizeCarNo(dateCarNo.split("_").at(-1) ?? ""),
  };
}

function normalizeCarNo(value: string): string {
  return value.replace(/^#/, "");
}

function latestLiveTimings(value: Expanded): { timings: Expanded[]; lapBestTime: string; createdAt: number; sessionStartAt: number } {
  const obj = value as { Items?: { createdDate?: number; sessionStartDate?: number; liveTimings?: Expanded[]; LAP_BEST_TIME?: string }[] };
  if (Array.isArray(obj?.Items)) {
    const latest = obj.Items.slice().sort((a, b) => Number(b?.createdDate ?? 0) - Number(a?.createdDate ?? 0))[0];
    if (Array.isArray(latest?.liveTimings))
      return {
        timings: latest.liveTimings,
        lapBestTime: String(latest.LAP_BEST_TIME ?? ""),
        createdAt: Number(latest.createdDate ?? 0),
        sessionStartAt: Number(latest.sessionStartDate ?? 0),
      };
  }
  const top = value as { createdDate?: number; sessionStartDate?: number; liveTimings?: Expanded[]; LAP_BEST_TIME?: string };
  if (Array.isArray(top?.liveTimings))
    return {
      timings: top.liveTimings,
      lapBestTime: String(top.LAP_BEST_TIME ?? ""),
      createdAt: Number(top.createdDate ?? 0),
      sessionStartAt: Number(top.sessionStartDate ?? 0),
    };
  const results: Expanded[] = [];
  collectObjects(value, results);
  return { timings: results, lapBestTime: "", createdAt: 0, sessionStartAt: 0 };
}

function toLapRow(value: Expanded, queryDate: string, lapBestTime: string, createdAt: number, sessionStartAt: number): LapRow | null {
  const flat = flattenObject(value as Record<string, Expanded>);
  const item = flat as unknown as Partial<TimingItem>;
  const lapTime = item.LAP_DISP || item.LAST_DISP || "";
  const lap     = item.LAPS ?? "";
  if (!looksLikeLapTime(lapTime) && !(lapTime && lap)) return null;
  const carNo = item.CARNO ?? "?";
  return {
    key: [queryDate, carNo].join("|"),
    carNo:      String(carNo),
    position:   String(item.POS ?? ""),
    lap:        String(lap),
    lapTime:    String(lapTime),
    lastTime:   item.LAST_TIME   ?? "",
    bestTime:   item.BEST_TIME   ?? "",
    sector1:    item.SEC1_DISP   ?? "",
    sector2:    item.SEC2_DISP   ?? "",
    sector3:    item.SEC3_DISP   ?? "",
    currentSec: item.CURRENT_SEC ?? "",
    isFastest:  !!lapBestTime && !!item.BEST_TIME && item.BEST_TIME === lapBestTime,
    createdAt,
    sessionStartAt,
  };
}

export function normalizeTimeSec(raw: string): number {
  if (!raw) return 0;
  const s = parseSeconds(raw);
  return s > 600 ? s / 1000 : s;
}

export function parseSeconds(value: string): number {
  if (!value) return 0;
  const i = value.indexOf(":");
  return i !== -1
    ? parseInt(value.slice(0, i)) * 60 + parseFloat(value.slice(i + 1))
    : parseFloat(value) || 0;
}

export function formatTime(s: number): string {
  const m   = Math.floor(s / 60);
  const rem = (s % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${rem}` : rem;
}

function fromDynamoValue(value: unknown): Expanded {
  if (Array.isArray(value)) return value.map(fromDynamoValue);
  if (!value || typeof value !== "object") return value as Expanded;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length === 1) {
    if ("S"    in v) return v.S as string;
    if ("N"    in v) return Number(v.N);
    if ("BOOL" in v) return v.BOOL as boolean;
    if ("NULL" in v) return null;
    if ("M"    in v) return fromDynamoValue(v.M);
    if ("L"    in v) return (v.L as unknown[]).map(fromDynamoValue);
    if ("SS"   in v) return v.SS as string[];
    if ("NS"   in v) return (v.NS as string[]).map(Number);
  }
  const result: Record<string, Expanded> = {};
  for (const [k, child] of Object.entries(v)) result[k] = fromDynamoValue(child);
  return result;
}

function expandJsonStrings(value: Expanded): Expanded {
  if (Array.isArray(value)) return value.map(expandJsonStrings);
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))
      return expandJsonStrings((tryParseJson(t) ?? value) as Expanded);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, Expanded> = {};
  for (const [k, child] of Object.entries(value as Record<string, Expanded>)) result[k] = expandJsonStrings(child);
  return result;
}

function collectObjects(value: Expanded, result: Expanded[]): void {
  if (Array.isArray(value)) { value.forEach((v) => collectObjects(v, result)); return; }
  if (!value || typeof value !== "object") return;
  result.push(value);
  Object.values(value as Record<string, Expanded>).forEach((v) => collectObjects(v, result));
}

function flattenObject(value: Record<string, Expanded>, prefix = "", result: Record<string, Expanded> = {}): Record<string, Expanded> {
  for (const [k, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (child && typeof child === "object" && !Array.isArray(child))
      flattenObject(child as Record<string, Expanded>, path, result);
    else { result[path] = child; result[k] = child; }
  }
  return result;
}

function looksLikeLapTime(value: unknown): boolean {
  if (typeof value === "number") return value > 0;
  if (typeof value !== "string") return false;
  return /^\d{1,2}:\d{2}\.\d{3}$/.test(value) || /^\d{1,3}\.\d{3}$/.test(value);
}

export function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}
