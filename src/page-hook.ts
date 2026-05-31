import { MESSAGE_TYPE, TELEMETRY_TYPE, VIDEO_CLOCK_TYPE, VIDEO_SYNC_TYPE, type MessagePayload, type VideoClockPayload } from "./types";

const TARGET_HOST      = "dynamodb.ap-northeast-1.amazonaws.com";
const TARGET_TABLE     = "sfprod1-live-timing-data";
const TARGET_TELEMETRY = "sfprod1-telemetry-data";

type RequestKind = "timing" | "telemetry" | null;

function classifyRequest(url: string, body: string): RequestKind {
  if (!url.includes(TARGET_HOST)) return null;
  if (body.includes(TARGET_TELEMETRY)) return "telemetry";
  if (body.includes(TARGET_TABLE) || !body) return "timing";
  return null;
}

function publish(type: string, payload: MessagePayload): void {
  window.postMessage({ type, payload }, window.location.origin);
}

type VideoJsPlayer = {
  currentTime?: () => number;
  paused?: () => boolean;
  playbackRate?: () => number;
  on?: (events: string | string[], handler: () => void) => void;
};

function getVideoJsPlayer(): VideoJsPlayer | null {
  const w = window as typeof window & { videojs?: ((idOrEl?: string | Element) => VideoJsPlayer) & { getAllPlayers?: () => VideoJsPlayer[] } };
  const players = w.videojs?.getAllPlayers?.();
  if (players?.[0]) return players[0];

  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || !w.videojs) return null;
  try { return w.videojs(video); } catch { return null; }
}

function readVideoCurrentTime(): number | undefined {
  const playerTime = getVideoJsPlayer()?.currentTime?.();
  if (Number.isFinite(playerTime)) return playerTime;

  const video = document.querySelector<HTMLVideoElement>("video");
  return video && Number.isFinite(video.currentTime) ? video.currentTime : undefined;
}

function readVideoClock(): VideoClockPayload | null {
  const player = getVideoJsPlayer();
  const video = document.querySelector<HTMLVideoElement>("video");
  const currentTime = player?.currentTime?.() ?? video?.currentTime;
  if (!Number.isFinite(currentTime)) return null;
  const currentTimeValue = Number(currentTime);

  return {
    currentTime:  currentTimeValue,
    capturedAt:   Date.now(),
    paused:       player?.paused?.() ?? video?.paused ?? false,
    playbackRate: player?.playbackRate?.() ?? video?.playbackRate ?? 1,
  };
}

let lastVideoClockPublish = 0;
function publishVideoClock(force = false): void {
  const now = Date.now();
  if (!force && now - lastVideoClockPublish < 250) return;
  const payload = readVideoClock();
  if (!payload) return;
  lastVideoClockPublish = now;
  window.postMessage({ type: VIDEO_CLOCK_TYPE, payload }, window.location.origin);
}

function installVideoClockPublisher(): void {
  const publish = () => publishVideoClock(true);
  const player = getVideoJsPlayer();
  if (player?.on) player.on(["timeupdate", "seeking", "seeked", "play", "pause", "ratechange", "loadedmetadata"], publish);

  const video = document.querySelector<HTMLVideoElement>("video");
  for (const event of ["timeupdate", "seeking", "seeked", "play", "pause", "ratechange", "loadedmetadata"]) {
    video?.addEventListener(event, publish);
  }

  const loop = () => {
    publishVideoClock();
    window.setTimeout(loop, 250);
  };
  loop();
}

// --- HLS #EXT-X-PROGRAM-DATE-TIME を使って動画と壁時計を同期 ---
function tryPublishVideoSync(text: string): void {
  if (!text.includes("#EXTINF")) return;

  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || video.seekable.length === 0) return;

  let pdtMs = 0;
  let durationAfterPdt = 0;
  let foundPdt = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      pdtMs = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      foundPdt = true;
      durationAfterPdt = 0;
    } else if (foundPdt && line.startsWith("#EXTINF:")) {
      durationAfterPdt += parseFloat(line.slice("#EXTINF:".length));
    }
  }

  if (!foundPdt || !pdtMs || isNaN(pdtMs)) return;

  const liveEdgeMs       = pdtMs + durationAfterPdt * 1000;
  const liveEdgeVideoTime = video.seekable.end(video.seekable.length - 1);
  const videoSyncOffset  = liveEdgeMs - liveEdgeVideoTime * 1000;
  const wallClockOffset  = videoSyncOffset + video.currentTime * 1000 - Date.now();

  window.postMessage({ type: VIDEO_SYNC_TYPE, payload: { videoSyncOffset, wallClockOffset } }, window.location.origin);
}

function readRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return String(input);
}

function readRequestBody(input: RequestInfo | URL, init?: RequestInit): string {
  const body = init?.body ?? (input instanceof Request ? input.body : null);
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBufferView as Uint8Array);
  return "";
}

// --- fetch intercept ---
const originalFetch = window.fetch;
window.fetch = async function sfgoFetchHook(input, init) {
  const requestUrl  = readRequestUrl(input);
  const videoCurrentTime = readVideoCurrentTime();

  // ReadableStream bodies are consumed by originalFetch — clone before awaiting
  let requestBody = readRequestBody(input, init);
  let cloneBodyPromise: Promise<string> | null = null;
  if (!requestBody && input instanceof Request && !input.bodyUsed && input.body instanceof ReadableStream) {
    try { cloneBodyPromise = input.clone().text(); } catch { /* stream locked */ }
  }

  const response = await originalFetch.apply(this, [input, init]);
  if (cloneBodyPromise) requestBody = await cloneBodyPromise;

  const kind   = classifyRequest(requestUrl, requestBody);
  const isM3u8 = requestUrl.includes(".m3u8");

  if (kind || isM3u8) {
    response
      .clone()
      .text()
      .then((responseText) => {
        if (kind === "timing") {
          publish(MESSAGE_TYPE,   { transport: "fetch", url: requestUrl, requestBody, responseText, capturedAt: Date.now(), videoCurrentTime });
        } else if (kind === "telemetry") {
          publish(TELEMETRY_TYPE, { transport: "fetch", url: requestUrl, requestBody, responseText, capturedAt: Date.now(), videoCurrentTime });
        }
        if (isM3u8) tryPublishVideoSync(responseText);
      })
      .catch((error: unknown) => {
        if (kind === "timing") {
          publish(MESSAGE_TYPE, { transport: "fetch", url: requestUrl, requestBody, error: String(error), capturedAt: Date.now(), videoCurrentTime });
        }
      });
  }

  return response;
};

// --- XHR intercept ---
const OriginalXHR = window.XMLHttpRequest;

window.XMLHttpRequest = function SFGoXMLHttpRequest(this: XMLHttpRequest) {
  const xhr = new OriginalXHR();
  let requestUrl  = "";
  let requestBody = "";
  let videoCurrentTime: number | undefined;

  const originalOpen = xhr.open.bind(xhr);
  (xhr as XMLHttpRequest).open = function open(
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null,
  ) {
    requestUrl = String(url);
    return async !== undefined
      ? originalOpen(method, url as string, async, user ?? null, password ?? null)
      : originalOpen(method, url as string);
  };

  const originalSend = xhr.send.bind(xhr);
  (xhr as XMLHttpRequest).send = function send(body?: Document | XMLHttpRequestBodyInit | null) {
    if (!body) requestBody = "";
    else if (typeof body === "string") requestBody = body;
    else if (body instanceof ArrayBuffer) requestBody = new TextDecoder().decode(body);
    else if (ArrayBuffer.isView(body)) requestBody = new TextDecoder().decode(body as Uint8Array);
    else requestBody = "";
    videoCurrentTime = readVideoCurrentTime();

    const kind   = classifyRequest(requestUrl, requestBody);
    const isM3u8 = requestUrl.includes(".m3u8");

    if (kind || isM3u8) {
      xhr.addEventListener("load", () => {
        const responseText =
          xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : "";
        if (kind === "timing") {
          publish(MESSAGE_TYPE,   { transport: "xhr", url: requestUrl, requestBody, responseText, capturedAt: Date.now(), videoCurrentTime });
        } else if (kind === "telemetry") {
          publish(TELEMETRY_TYPE, { transport: "xhr", url: requestUrl, requestBody, responseText, capturedAt: Date.now(), videoCurrentTime });
        }
        if (isM3u8) tryPublishVideoSync(responseText);
      });
    }

    return originalSend(body ?? null);
  };

  return xhr;
} as unknown as typeof XMLHttpRequest;

Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);
Object.setPrototypeOf(window.XMLHttpRequest.prototype, OriginalXHR.prototype);

installVideoClockPublisher();
