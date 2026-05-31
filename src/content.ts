import { MESSAGE_TYPE, TELEMETRY_TYPE, VIDEO_CLOCK_TYPE, VIDEO_SYNC_TYPE, type MessagePayload, type VideoClockPayload, type VideoSyncPayload } from "./types";
import { extractLapRows, extractTelemetryLapSamples, extractTelemetryQueryWindow } from "./parse";
import { resetRuntimeState, rows, setDisplayClockOffset, setTelemetryQueryWindow, setVideoClockAnchor, setVideoPlaybackState, setVideoSyncOffset, toDisplayClockTime, updateState, updateTelemetrySamples } from "./state";
import { startOverlay } from "./overlay";

const VIDEO_JUMP_RESET_THRESHOLD_SEC = 3;
let lastVideoClock: VideoClockPayload | null = null;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { type?: string; payload?: MessagePayload };
  if (!data?.payload) return;

  if (data.type === VIDEO_CLOCK_TYPE) {
    applyVideoClock(data.payload as unknown as VideoClockPayload);
    return;
  }

  if (data.type === VIDEO_SYNC_TYPE) {
    const { videoSyncOffset } = data.payload as unknown as VideoSyncPayload;
    setVideoSyncOffset(videoSyncOffset);
    return;
  }

  const { error, responseText = "", requestBody, capturedAt } = data.payload;
  if (error) return;

  if (data.type === TELEMETRY_TYPE) {
    applyTelemetrySync(responseText, requestBody, capturedAt, data.payload.videoCurrentTime);
    return;
  }

  if (data.type !== MESSAGE_TYPE) return;

  // テレメトリが timing として誤分類されてきた場合の保険
  if (applyTelemetrySync(responseText, requestBody, capturedAt, data.payload.videoCurrentTime)) return;

  const lapRows = extractLapRows(responseText, requestBody);
  const batchCreatedAt = lapRows[0]?.createdAt ?? 0;
  if (batchCreatedAt > 0) {
    setDisplayClockOffset(batchCreatedAt - capturedAt);
    if (data.payload.videoCurrentTime !== undefined) {
      setVideoClockAnchor(batchCreatedAt, data.payload.videoCurrentTime);
    }
  }
  for (const row of lapRows) {
    rows.set(row.key, row);
    updateState(row, toDisplayClockTime(capturedAt));
  }
});

function applyVideoClock(clock: VideoClockPayload): void {
  if (shouldResetForVideoJump(clock)) {
    resetRuntimeState();
  }
  lastVideoClock = clock;
  setVideoPlaybackState(clock);
}

function shouldResetForVideoJump(clock: VideoClockPayload): boolean {
  if (!Number.isFinite(clock.currentTime) || !Number.isFinite(clock.capturedAt)) return false;
  if (!lastVideoClock) return false;

  const elapsedSec = Math.max(0, (clock.capturedAt - lastVideoClock.capturedAt) / 1000);
  const expectedTime = lastVideoClock.paused
    ? lastVideoClock.currentTime
    : lastVideoClock.currentTime + elapsedSec * lastVideoClock.playbackRate;
  return Math.abs(clock.currentTime - expectedTime) > VIDEO_JUMP_RESET_THRESHOLD_SEC;
}

function applyTelemetrySync(responseText: string, requestBody: string, capturedAt: number, videoCurrentTime: number | undefined): boolean {
  const samples = extractTelemetryLapSamples(responseText);
  if (samples.length === 0) return false;

  updateTelemetrySamples(samples);

  const queryWindow = extractTelemetryQueryWindow(requestBody);
  if (queryWindow && videoCurrentTime !== undefined && videoCurrentTime >= 0)
    setTelemetryQueryWindow(queryWindow, videoCurrentTime, capturedAt);

  return true;
}

startOverlay();

const script = document.createElement("script");
script.src = chrome.runtime.getURL("page-hook.js");
script.onload = () => script.remove();
(document.documentElement ?? document.head).appendChild(script);
