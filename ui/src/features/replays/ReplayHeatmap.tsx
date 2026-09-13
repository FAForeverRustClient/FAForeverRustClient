// Where on the map the orders were given.
//
// The Python client's "Heatmap" tab (`heatmap.py` in FAForever/client): every
// order that named a position, binned over the map and blurred, with filters
// for who gave it and what kind of order it was, and a slider for the stretch
// of the game to count.
//
// Drawn on a canvas rather than as an image the way that client does it, and
// blurred with a repeated box rather than with a Gaussian kernel: the two look
// the same at this size and one of them does not need a numerics library.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReplayAnalysis, ReplayPoint } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { analysedPlayers, blurBins, commandName, formatGameTime, heatmapBins } from "./replayAnalysis";

/** Cells on a side. Fine enough for a big map, cheap enough to redraw live. */
const GRID = 192;
/** How the canvas is drawn, in device pixels. */
const CANVAS_SIZE = 512;

/**
 * The colours a count is drawn in, coldest first.
 *
 * The same ramp the Python client's colour bar uses: black through blue and
 * magenta to yellow, which keeps a busy cell readable over a map preview.
 */
const RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [12, 12, 60],
  [40, 40, 200],
  [150, 40, 220],
  [240, 60, 140],
  [255, 200, 40],
  [255, 255, 220],
];

function rampAt(share: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, share));
  const scaled = clamped * (RAMP.length - 1);
  const low = Math.floor(scaled);
  const high = Math.min(RAMP.length - 1, low + 1);
  const blend = scaled - low;
  return [
    Math.round(RAMP[low][0] + (RAMP[high][0] - RAMP[low][0]) * blend),
    Math.round(RAMP[low][1] + (RAMP[high][1] - RAMP[low][1]) * blend),
    Math.round(RAMP[low][2] + (RAMP[high][2] - RAMP[low][2]) * blend),
  ];
}

export function ReplayHeatmap({
  analysis,
  mapPreviewUrl,
}: {
  analysis: ReplayAnalysis;
  /** The map under the heat, where this client has a preview of it. */
  mapPreviewUrl?: string;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const players = useMemo(() => analysedPlayers(analysis), [analysis]);
  const [hiddenPlayers, setHiddenPlayers] = useState<ReadonlySet<number>>(new Set());
  const [command, setCommand] = useState(-1);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(analysis.ticks);
  const [smoothing, setSmoothing] = useState(2);
  const [showMap, setShowMap] = useState(true);

  // The kinds of order that actually appear in this replay, so the filter
  // offers what is there rather than the whole enum.
  const commands = useMemo(() => {
    const seen = new Set<number>();
    for (const point of analysis.points) seen.add(point.command);
    return [...seen].sort((left, right) => left - right);
  }, [analysis.points]);

  useEffect(() => setTo(analysis.ticks), [analysis.ticks]);

  const bins = useMemo(() => {
    const include = (point: ReplayPoint) =>
      point.tick >= from
      && point.tick <= to
      && !hiddenPlayers.has(point.source)
      && (command < 0 || point.command === command);
    const raw = heatmapBins(
      analysis.points,
      analysis.scenario.width,
      analysis.scenario.height,
      GRID,
      include,
    );
    return blurBins(raw, smoothing);
  }, [analysis.points, analysis.scenario.height, analysis.scenario.width, command, from, hiddenPlayers, smoothing, to]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = context.createImageData(GRID, GRID);
    for (let index = 0; index < bins.cells.length; index += 1) {
      const share = bins.peak > 0 ? bins.cells[index] / bins.peak : 0;
      const [red, green, blue] = rampAt(share);
      const offset = index * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      // Transparent where nothing happened, so the map shows through.
      image.data[offset + 3] = Math.round(Math.min(1, share * 2.2) * 235);
    }
    // Painted at grid size and scaled up by the canvas itself, which is what
    // gives the cells their soft edges.
    const scratch = document.createElement("canvas");
    scratch.width = GRID;
    scratch.height = GRID;
    scratch.getContext("2d")?.putImageData(image, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  }, [bins]);

  if (analysis.points.length === 0) {
    return <p className="replay-detail-empty muted">{t("replays.insights.noPoints")}</p>;
  }

  return (
    <div className="replay-heatmap">
      <div className="replay-heatmap-figure">
        {showMap && mapPreviewUrl && (
          <img className="replay-heatmap-map" src={mapPreviewUrl} alt="" aria-hidden />
        )}
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="replay-heatmap-canvas"
          aria-label={t("replays.insights.heatmapAria")}
          role="img"
        />
      </div>

      <div className="replay-heatmap-controls">
        <label className="replay-insights-filter">
          <span className="muted">{t("replays.insights.commandKind")}</span>
          <select
            className="vault-input"
            value={command}
            onChange={(event) => setCommand(Number(event.target.value))}
          >
            <option value={-1}>{t("replays.insights.allCommands")}</option>
            {commands.map((kind) => (
              <option key={kind} value={kind}>{commandName(kind)}</option>
            ))}
          </select>
        </label>

        <label className="replay-insights-filter">
          <span className="muted">{t("replays.insights.smoothing")}</span>
          <input
            type="range"
            min={0}
            max={6}
            value={smoothing}
            onChange={(event) => setSmoothing(Number(event.target.value))}
          />
        </label>

        {/* Two handles would be a control this client does not have, so the
            stretch of the game is set by its two ends. */}
        <label className="replay-insights-filter">
          <span className="muted">{t("replays.insights.fromTime", { time: formatGameTime(from) })}</span>
          <input
            type="range"
            min={0}
            max={analysis.ticks}
            value={from}
            onChange={(event) => setFrom(Math.min(Number(event.target.value), to))}
          />
        </label>
        <label className="replay-insights-filter">
          <span className="muted">{t("replays.insights.toTime", { time: formatGameTime(to) })}</span>
          <input
            type="range"
            min={0}
            max={analysis.ticks}
            value={to}
            onChange={(event) => setTo(Math.max(Number(event.target.value), from))}
          />
        </label>

        {mapPreviewUrl && (
          <label className="option-check">
            <input
              type="checkbox"
              checked={showMap}
              onChange={(event) => setShowMap(event.target.checked)}
            />
            {t("replays.insights.showMap")}
          </label>
        )}

        <div className="replay-chart-legend">
          {players.map((player) => (
            <button
              key={`${player.source}-${player.name}`}
              type="button"
              className={hiddenPlayers.has(player.source)
                ? "replay-chart-legend-item is-off"
                : "replay-chart-legend-item"}
              aria-pressed={!hiddenPlayers.has(player.source)}
              onClick={() => setHiddenPlayers((current) => {
                const next = new Set(current);
                if (next.has(player.source)) next.delete(player.source);
                else next.add(player.source);
                return next;
              })}
            >
              <span className="replay-activity-swatch" style={{ background: player.color }} aria-hidden />
              <span>{player.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
