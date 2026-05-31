import { formatTime, type LapRow } from "./parse";
import { rows, getFlash, getDelta, getLiveLapTime } from "./state";

let elWrapper: HTMLElement | null = null;
let elDelta:   HTMLElement | null = null;
let elTime:    HTMLElement | null = null;
let elPosition: HTMLElement | null = null;
let elLaps: HTMLElement | null = null;

const FONT_FAMILY =
  '"Saira Expanded", "Noto Sans JP", "ヒラギノ角ゴ ProN W3", "Hiragino Kaku Gothic ProN", メイリオ, meiryo, osaka, "ＭＳ Ｐゴシック", "MS PGothic", sans-serif';

function applyFontStyle(el: HTMLElement): void {
  el.style.setProperty("font-family", FONT_FAMILY, "important");
  el.style.setProperty("font-feature-settings", '"palt"', "important");
  el.style.setProperty("font-kerning", "normal", "important");
}

function getSelectedCarNo(): string {
  const el = document.querySelector(".player-card-parts__data__name");
  const m  = (el?.textContent ?? "").match(/#(\d+)/);
  return m ? m[1] : "";
}

function ensureElements(fuelEl: HTMLElement): boolean {
  if (elWrapper?.parentElement === fuelEl && elWrapper.isConnected && elDelta && elTime) return true;

  elWrapper?.remove();
  document.getElementById("sf-lap-telemetry")?.remove();

  for (const child of fuelEl.children) {
    (child as HTMLElement).style.display = "none";
  }

  elWrapper = document.createElement("div");
  elWrapper.id = "sf-lap-telemetry";
  Object.assign(elWrapper.style, {
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    justifyContent: "center",
    width:          "100%",
    minHeight:       "42px",
    paddingTop:     "0",
    transform:      "translateY(-4px)",
    pointerEvents:  "none",
    color:          "white",
  });
  applyFontStyle(elWrapper);

  elDelta = document.createElement("div");
  Object.assign(elDelta.style, {
    fontSize:           "13px",
    fontWeight:         "400",
    height:             "16px",
    lineHeight:         "16px",
    fontVariantNumeric: "tabular-nums",
    visibility:         "hidden",
  });
  applyFontStyle(elDelta);

  elTime = document.createElement("div");
  Object.assign(elTime.style, {
    fontSize:           "16px",
    fontWeight:         "400",
    height:             "20px",
    lineHeight:         "20px",
    fontVariantNumeric: "tabular-nums",
  });
  applyFontStyle(elTime);

  elWrapper.appendChild(elDelta);
  elWrapper.appendChild(elTime);
  fuelEl.appendChild(elWrapper);
  return true;
}

function ensureSteeringElements(steeringEl: HTMLElement): boolean {
  if (elPosition?.parentElement === steeringEl && elLaps?.parentElement === steeringEl && elPosition.isConnected && elLaps.isConnected) return true;

  elPosition?.remove();
  elLaps?.remove();
  document.getElementById("sf-selected-position")?.remove();
  document.getElementById("sf-selected-laps")?.remove();

  if (getComputedStyle(steeringEl).position === "static") {
    steeringEl.style.position = "relative";
  }

  elPosition = createSteeringStat("sf-selected-position", "left");
  elLaps = createSteeringStat("sf-selected-laps", "right");
  steeringEl.appendChild(elPosition);
  steeringEl.appendChild(elLaps);
  return true;
}

function createSteeringStat(id: string, side: "left" | "right"): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  Object.assign(el.style, {
    position:          "absolute",
    top:               "71%",
    [side]:            "-42px",
    transform:         "translateY(-50%)",
    minWidth:          "42px",
    textAlign:         "center",
    color:             "white",
    fontSize:          "18px",
    fontWeight:        "400",
    lineHeight:        "20px",
    fontVariantNumeric:"tabular-nums",
    textShadow:        "0 1px 4px rgba(0,0,0,0.75)",
    pointerEvents:     "none",
    zIndex:            "3",
  });
  applyFontStyle(el);
  return el;
}

function findSelectedRow(carNo: string): LapRow | undefined {
  let row: LapRow | undefined;
  for (const r of rows.values()) {
    if (r.carNo === carNo) row = r;
  }
  return row;
}

function rafLoop(): void {
  requestAnimationFrame(rafLoop);

  const carNo  = getSelectedCarNo();
  const fuelEl = document.querySelector<HTMLElement>(".telemetry-fuel-used-parts");
  const steeringEl = document.querySelector<HTMLElement>(".telemetry-steering-angle-parts");
  if (!fuelEl || !ensureElements(fuelEl) || !elDelta || !elTime) return;
  if (steeringEl) ensureSteeringElements(steeringEl);

  const row = findSelectedRow(carNo);

  if (!row || !carNo) {
    elTime.textContent    = "";
    elDelta.style.visibility = "hidden";
    if (elPosition) elPosition.textContent = "";
    if (elLaps) elLaps.textContent = "";
    return;
  }

  if (elPosition) elPosition.textContent = row.position ? `P${row.position}` : "";
  if (elLaps) elLaps.textContent = row.lap ? `L${row.lap}` : "";

  const flash = getFlash(carNo);
  elTime.textContent = flash ? flash.time : formatTime(getLiveLapTime(row));
  elTime.style.color =
    flash?.isFastest ? "#c084fc" :
    flash?.kind === "lap" && flash.isPersonalBest ? "#4ade80" :
    flash?.kind === "lap" ? "#facc15" :
    "white";

  const ds = getDelta(carNo);
  if (ds) {
    const sign = ds.value >= 0 ? "+" : "-";
    elDelta.style.visibility = "visible";
    elDelta.style.color      = ds.value > 0 ? "#f87171" : "#4ade80";
    elDelta.textContent      = `${sign}${Math.abs(ds.value).toFixed(3)}`;
  } else if (flash?.kind === "sector" && flash.sectorNum != null && flash.sectorTimeSec != null) {
    elDelta.style.visibility = "visible";
    elDelta.style.color      = "white";
    elDelta.textContent      = `S${flash.sectorNum}: ${formatTime(flash.sectorTimeSec)}`;
  } else {
    elDelta.style.visibility = "hidden";
  }
}

export function startOverlay(): void {
  requestAnimationFrame(rafLoop);
}
