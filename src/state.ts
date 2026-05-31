import { formatTime, normalizeTimeSec, type LapRow, type TelemetryLapSample, type TelemetryQueryWindow } from "./parse";

interface CarState {
  lapNum:   string;
  lastSec:  string;
  bestTime: string;
  sector1:  string;
  sector2:  string;
  sector3:  string;
}

interface VideoClockAnchor {
  telemetryTime: number;
  videoTime:     number;
}

interface VideoPlaybackState {
  currentTime:  number;
  capturedAt:   number;
  paused:       boolean;
  playbackRate: number;
}

interface Flash {
  time:           string;
  isFastest:      boolean;
  isPersonalBest: boolean;
  kind:           "sector" | "lap";
  startAt:        number;
  endAt:          number;
  sectorNum?:     1 | 2 | 3;
  sectorTimeSec?: number;
}

interface PendingFlash {
  kind:           "sector" | "lap";
  time:           string;
  isFastest:      boolean;
  isPersonalBest: boolean;
  delta:          number | null;
  sectorNum?:     1 | 2 | 3;
  sectorTimeSec?: number;
  lap:            string;
  nextLap:        string;
  triggerSec:     number;
  createdAt:      number;
}

interface DeltaV {
  value: number;
  endAt: number;
}

interface TelemetryLapState {
  lapTimeSec:      number;
  speedKmh:        number | null;
  lap:             string;
  sampleCreatedAt: number;
  targetCreatedAt: number;
  rawTargetCreatedAt: number;
  source:          "interpolated" | "live" | "future";
}

interface TelemetryWindowAnchor {
  fromDate:   number;
  toDate:     number;
  videoTime:  number;
  capturedAt: number;
  carNo:      string;
}

export const rows       = new Map<string, LapRow>();
const carStates         = new Map<string, CarState>();
const flashes           = new Map<string, Flash>();
const pendingFlashes    = new Map<string, PendingFlash[]>();
const deltaStates       = new Map<string, DeltaV>();
const telemetrySamples  = new Map<string, TelemetryLapSample[]>();
let videoClockAnchor: VideoClockAnchor | null = null;
const telemetryWindowAnchors = new Map<string, TelemetryWindowAnchor>();
let videoPlaybackState: VideoPlaybackState | null = null;
let videoSyncOffset: number | null = null;
let displayClockOffset  = 0;
const MAX_TELEMETRY_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_TELEMETRY_SAMPLES_PER_CAR = 60_000;
const LIVE_EXTRAPOLATE_MS = 120_000;
const FLASH_DURATION_MS = 2_000;

export function getFlash(carNo: string): Flash | undefined {
  activatePendingFlash(carNo);

  const flash = flashes.get(carNo);
  if (!flash) return undefined;

  const now = getTelemetryClockTime(carNo);
  if (now >= flash.startAt && now < flash.endAt) return flash;
  if (now >= flash.endAt) flashes.delete(carNo);
  return undefined;
}
export function getDelta(carNo: string): DeltaV | undefined {
  const d = deltaStates.get(carNo);
  if (!d) return undefined;
  if (getTelemetryClockTime(carNo) >= d.endAt) { deltaStates.delete(carNo); return undefined; }
  return d;
}
export function resetRuntimeState(): void {
  rows.clear();
  carStates.clear();
  flashes.clear();
  pendingFlashes.clear();
  deltaStates.clear();
  telemetrySamples.clear();
  telemetryWindowAnchors.clear();
  videoClockAnchor = null;
  displayClockOffset = 0;
}
export function setDisplayClockOffset(offsetMs: number): void {
  if (!Number.isFinite(offsetMs)) return;
  displayClockOffset = offsetMs;
}
export function setVideoClockAnchor(telemetryTime: number, videoTime: number): void {
  if (!Number.isFinite(telemetryTime) || !Number.isFinite(videoTime)) return;
  videoClockAnchor = { telemetryTime, videoTime };
}
export function setTelemetryQueryWindow(window: TelemetryQueryWindow, videoTime: number, capturedAt: number): void {
  if (!window.carNo || !Number.isFinite(videoTime) || !Number.isFinite(capturedAt)) return;
  telemetryWindowAnchors.set(window.carNo, { ...window, videoTime, capturedAt });
}
export function setVideoPlaybackState(state: VideoPlaybackState): void {
  if (!Number.isFinite(state.currentTime) || !Number.isFinite(state.capturedAt)) return;
  videoPlaybackState = state;
}
export function setVideoSyncOffset(offset: number): void {
  if (!Number.isFinite(offset)) return;
  videoSyncOffset = offset;
}
export function toDisplayClockTime(timeMs: number): number {
  return timeMs + displayClockOffset;
}
export function updateTelemetrySamples(samples: TelemetryLapSample[]): void {
  if (samples.length === 0) return;

  for (const sample of samples) {
    if (!sample.carNo || !Number.isFinite(sample.createdAt) || !Number.isFinite(sample.lapTimeMs)) continue;

    const current = telemetrySamples.get(sample.carNo) ?? [];
    const existingIndex = current.findIndex((item) => item.createdAt === sample.createdAt);
    if (existingIndex >= 0) {
      current[existingIndex] = sample;
    } else {
      current.push(sample);
    }

    current.sort((a, b) => a.createdAt - b.createdAt);
    const newest = current.at(-1)?.createdAt ?? sample.createdAt;
    const retained = current
      .filter((item) => newest - item.createdAt <= MAX_TELEMETRY_AGE_MS)
      .slice(-MAX_TELEMETRY_SAMPLES_PER_CAR);
    telemetrySamples.set(sample.carNo, retained);
  }
}

export function updateState(row: LapRow, capturedAt = Date.now()): void {
  const st = carStates.get(row.carNo);
  const lapChanged = !st || st.lapNum !== row.lap;

  if (lapChanged) {
    const last = normalizeTimeSec(row.lastTime);
    if (last > 0) {
      const prev = st ? normalizeTimeSec(st.bestTime) : 0;
      const delta = prev > 0 ? last - prev : null;
      const isPersonalBest = prev <= 0 || last < prev;
      const isThisLapBest = isPersonalBest && Math.abs(last - normalizeTimeSec(row.bestTime)) < 0.002;
      scheduleFlash(row.carNo, {
        kind: "lap",
        time: formatTime(last),
        isFastest: row.isFastest && isThisLapBest,
        isPersonalBest,
        delta,
        lap: st?.lapNum ?? "",
        nextLap: row.lap,
        triggerSec: last,
        createdAt: getTelemetryClockTime(row.carNo),
      });
    }
    carStates.set(row.carNo, {
      lapNum:   row.lap,
      lastSec:  row.currentSec,
      bestTime: row.bestTime,
      sector1:  row.sector1,
      sector2:  row.sector2,
      sector3:  row.sector3,
    });
    return;
  }

  scheduleSectorFlashIfChanged(row, st);
  carStates.set(row.carNo, {
    lapNum:   row.lap,
    lastSec:  row.currentSec,
    bestTime: row.bestTime,
    sector1:  row.sector1,
    sector2:  row.sector2,
    sector3:  row.sector3,
  });
}

function scheduleSectorFlashIfChanged(row: LapRow, st: CarState): void {
  const s1 = normalizeTimeSec(row.sector1);
  const s2 = normalizeTimeSec(row.sector2);
  const s3 = normalizeTimeSec(row.sector3);

  if (row.sector1 !== st.sector1 && s1 > 0) {
    scheduleSectorFlash(row, 1, s1, s1);
  }
  if (row.sector2 !== st.sector2 && s1 > 0 && s2 > 0) {
    scheduleSectorFlash(row, 2, s2, s1 + s2);
  }
  if (row.sector3 !== st.sector3 && s1 > 0 && s2 > 0 && s3 > 0) {
    scheduleSectorFlash(row, 3, s3, s1 + s2 + s3);
  }
}

function scheduleSectorFlash(row: LapRow, sectorNum: 1 | 2 | 3, sectorTimeSec: number, cumSec: number): void {
  scheduleFlash(row.carNo, {
    kind: "sector",
    time: formatTime(cumSec),
    isFastest: false,
    isPersonalBest: false,
    delta: null,
    sectorNum,
    sectorTimeSec,
    lap: row.lap,
    nextLap: "",
    triggerSec: cumSec,
    createdAt: getTelemetryClockTime(row.carNo),
  });
}

export function getLiveLapTime(row: LapRow): number {
  const telemetryTargetTime = getTelemetryClockTime(row.carNo);
  const telemetry = readTelemetryLapState(row.carNo, telemetryTargetTime);
  if (telemetry === null) return normalizeTimeSec(row.lapTime);
  return telemetry.lapTimeSec;
}

function readTelemetryLapState(carNo: string, targetCreatedAt: number): TelemetryLapState | null {
  const samples = telemetrySamples.get(carNo);
  if (!samples?.length || !Number.isFinite(targetCreatedAt)) return null;

  const rawTargetCreatedAt = targetCreatedAt;
  const bufferedTargetCreatedAt = targetCreatedAt;

  let nextIndex = samples.findIndex((sample) => sample.createdAt >= bufferedTargetCreatedAt);
  if (nextIndex === -1) nextIndex = samples.length;

  const prev = samples[nextIndex - 1] ?? null;
  const next = samples[nextIndex] ?? null;

  if (prev && next && prev.lap === next.lap && next.createdAt > prev.createdAt) {
    const ratio = (bufferedTargetCreatedAt - prev.createdAt) / (next.createdAt - prev.createdAt);
    return {
      lapTimeSec: (prev.lapTimeMs + (next.lapTimeMs - prev.lapTimeMs) * ratio) / 1000,
      speedKmh: interpolateNullable(prev.speedKmh, next.speedKmh, ratio),
      lap: prev.lap,
      sampleCreatedAt: prev.createdAt,
      targetCreatedAt: bufferedTargetCreatedAt,
      rawTargetCreatedAt,
      source: "interpolated",
    };
  }

  if (prev) {
    const age = bufferedTargetCreatedAt - prev.createdAt;
    return {
      lapTimeSec: age >= 0 && age <= LIVE_EXTRAPOLATE_MS ? (prev.lapTimeMs + age) / 1000 : prev.lapTimeMs / 1000,
      speedKmh: prev.speedKmh,
      lap: prev.lap,
      sampleCreatedAt: prev.createdAt,
      targetCreatedAt: bufferedTargetCreatedAt,
      rawTargetCreatedAt,
      source: "live",
    };
  }

  if (next && next.createdAt - bufferedTargetCreatedAt <= LIVE_EXTRAPOLATE_MS) {
    return {
      lapTimeSec: Math.max(0, next.lapTimeMs - (next.createdAt - bufferedTargetCreatedAt)) / 1000,
      speedKmh: next.speedKmh,
      lap: next.lap,
      sampleCreatedAt: next.createdAt,
      targetCreatedAt: bufferedTargetCreatedAt,
      rawTargetCreatedAt,
      source: "future",
    };
  }

  return null;
}

function interpolateNullable(a: number | null, b: number | null, ratio: number): number | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * ratio;
}

function getDisplayClockTime(): number {
  const videoTime = readVideoCurrentTime();
  if (videoClockAnchor && videoTime !== null) {
    return videoClockAnchor.telemetryTime + (videoTime - videoClockAnchor.videoTime) * 1000;
  }
  if (videoSyncOffset !== null && videoTime !== null) {
    return videoSyncOffset + videoTime * 1000;
  }
  return Date.now() + displayClockOffset;
}

function getTelemetryClockTime(carNo: string): number {
  const videoTime = readVideoCurrentTime();
  const anchor = telemetryWindowAnchors.get(carNo);
  if (anchor && videoTime !== null) {
    return anchor.fromDate + (videoTime - anchor.videoTime) * 1000;
  }
  return getDisplayClockTime();
}

function activatePendingFlash(carNo: string): void {
  const pending = pendingFlashes.get(carNo);
  if (!pending?.length) return;

  const telemetryTime = getTelemetryClockTime(carNo);
  const telemetry = readTelemetryLapState(carNo, telemetryTime);
  if (!telemetry) return;

  const index = pending.findIndex((flash) => shouldActivatePendingFlash(flash, telemetry, false));
  if (index === -1) {
    const stillUseful = pending.filter((flash) => !isStalePendingFlash(flash, telemetry));
    if (stillUseful.length === pending.length) return;
    if (stillUseful.length > 0) pendingFlashes.set(carNo, stillUseful);
    else pendingFlashes.delete(carNo);
    return;
  }

  const [flash] = pending.splice(index, 1);
  if (pending.length > 0) pendingFlashes.set(carNo, pending);
  else pendingFlashes.delete(carNo);
  triggerFlash(carNo, flash, telemetry.targetCreatedAt);
}

function readVideoCurrentTime(): number | null {
  if (videoPlaybackState) {
    if (videoPlaybackState.paused) return videoPlaybackState.currentTime;
    return videoPlaybackState.currentTime + (Date.now() - videoPlaybackState.capturedAt) / 1000 * videoPlaybackState.playbackRate;
  }

  const video = document.querySelector<HTMLVideoElement>("video");
  return video && Number.isFinite(video.currentTime) ? video.currentTime : null;
}


function scheduleFlash(carNo: string, flash: PendingFlash): void {
  if (!Number.isFinite(flash.triggerSec) || flash.triggerSec <= 0) return;

  const telemetry = readTelemetryLapState(carNo, getTelemetryClockTime(carNo));
  if (telemetry && shouldActivatePendingFlash(flash, telemetry, true)) {
    triggerFlash(carNo, flash, telemetry.targetCreatedAt);
    return;
  }

  const current = pendingFlashes.get(carNo) ?? [];
  const duplicate = current.some((item) => item.kind === flash.kind && item.time === flash.time && item.lap === flash.lap);
  if (!duplicate) current.push(flash);
  current.sort((a, b) => a.triggerSec - b.triggerSec);
  pendingFlashes.set(carNo, current.slice(-6));
}

function shouldActivatePendingFlash(flash: PendingFlash, telemetry: TelemetryLapState, allowLate: boolean): boolean {
  const reachedTime = telemetry.lapTimeSec >= flash.triggerSec - 0.05;
  if (flash.kind === "sector")
    return reachedTime && (allowLate || telemetry.lapTimeSec < flash.triggerSec + 8);

  const movedToNextLap = flash.nextLap !== "" && telemetry.lap === flash.nextLap;
  const lapResetAfterEvent = telemetry.lapTimeSec < 5 && telemetry.targetCreatedAt >= flash.createdAt;
  return reachedTime || movedToNextLap || lapResetAfterEvent;
}

function isStalePendingFlash(flash: PendingFlash, telemetry: TelemetryLapState): boolean {
  if (telemetry.targetCreatedAt - flash.createdAt > 30_000) return true;
  if (flash.kind === "sector") return telemetry.lapTimeSec > flash.triggerSec + 12;
  return false;
}

function triggerFlash(carNo: string, flash: PendingFlash, eventAt: number): void {
  const startAt = Number.isFinite(eventAt) && eventAt > 0 ? eventAt : getTelemetryClockTime(carNo);
  flashes.set(carNo, {
    time: flash.time,
    isFastest: flash.isFastest,
    isPersonalBest: flash.isPersonalBest,
    kind: flash.kind,
    startAt,
    endAt: startAt + FLASH_DURATION_MS,
    sectorNum: flash.sectorNum,
    sectorTimeSec: flash.sectorTimeSec,
  });
  if (flash.kind === "lap" && flash.delta !== null) triggerDelta(carNo, flash.delta);
}

function triggerDelta(carNo: string, value: number): void {
  deltaStates.set(carNo, { value, endAt: getTelemetryClockTime(carNo) + FLASH_DURATION_MS });
}
