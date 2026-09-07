// Where the recorded build order happened: the map's own preview, with the
// resource points on it and each unit's route drawn over the top.
//
// Ported from the BO recorder's analyser, with one deliberate change. That one
// carries its own rendered previews in a public folder; this one uses the map's
// real vault preview, resolved the same way every other map picture in the
// client is. No coordinate transform is needed either way: recorded positions
// are already on the heightmap scale, so the map's dimensions are the viewBox
// and world x/z land straight on SVG x/y.
//
// Markers are drawn rather than imported as art. The recorder's front end ships
// PNGs for them; three shapes in SVG cost nothing, scale without blurring, and
// keep this feature from adding binary assets to the client.

import { useMemo, useState } from "react";

import { useTranslation } from "../../i18n/useTranslation";
import { catColor, markerPaths, mmss, RECLAIM_COLOR, type Envelope } from "./recording";

interface Props {
  env: Envelope;
  previewUrl: string;
  hovered: string | null;
  onHover: (id: string | null) => void;
}

/** Engineers are what a build order's routing is about; the rest starts off. */
const DEFAULT_CATS = ["engie"];

export function RunMap({ env, previewUrl, hovered, onHover }: Props) {
  const { t } = useTranslation();
  const { sizeX, sizeZ, playable } = env.meta.map;

  // The ACU is dropped: it barely moves, and its route only clutters the view.
  const paths = useMemo(() => markerPaths(env).filter((p) => p.cat !== "acu"), [env]);
  const cats = useMemo(() => [...new Set(paths.map((p) => p.cat))].sort(), [paths]);
  const [active, setActive] = useState<string[]>(() =>
    cats.filter((c) => DEFAULT_CATS.includes(c)),
  );

  if (!sizeX || !sizeZ) {
    // A run recorded before the map line existed. Its positions are real and
    // there is nothing to place them on, which is worth saying rather than
    // drawing an empty square.
    return <p className="muted training-run-problem">{t("training.run.noMapSize")}</p>;
  }

  const toggle = (cat: string) =>
    setActive((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));

  const shown = paths.filter((p) => active.includes(p.cat));
  const mass = env.markers.filter((m) => m.type === "Mass");
  const hydro = env.markers.filter((m) => m.type === "Hydrocarbon");
  const spawns = env.markers.filter((m) => m.type === "Blank Marker" || m.type === "Spawn");

  // Sized off the map, so marker art keeps the same apparent size on a 5 km map
  // and a 20 km one instead of shrinking to nothing on the large ones.
  const unit = sizeX / 42;
  const stroke = sizeX / 330;

  return (
    <div className="training-run-map">
      <div className="training-run-legend">
        {cats.map((cat) => (
          <label key={cat}>
            <input type="checkbox" checked={active.includes(cat)} onChange={() => toggle(cat)} />
            <span className="training-run-swatch" style={{ background: catColor(cat) }} />
            {cat}
            <span className="muted">{paths.filter((p) => p.cat === cat).length}</span>
          </label>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${sizeX} ${sizeZ}`}
        className="training-run-canvas"
        onMouseLeave={() => onHover(null)}
      >
        {previewUrl && (
          <image
            href={previewUrl}
            x={0}
            y={0}
            width={sizeX}
            height={sizeZ}
            preserveAspectRatio="none"
          />
        )}

        {/* The declared map can be larger than what is played on. Drawing the
            playable rect makes which of the two you are looking at plain. */}
        {playable &&
          (playable.x1 - playable.x0 !== sizeX || playable.z1 - playable.z0 !== sizeZ) && (
            <rect
              x={playable.x0}
              y={playable.z0}
              width={playable.x1 - playable.x0}
              height={playable.z1 - playable.z0}
              fill="none"
              stroke="#93c5fd"
              strokeWidth={sizeX / 300}
              strokeDasharray={`${sizeX / 90}`}
              opacity={0.7}
            />
          )}

        {mass.map((m) => (
          <circle
            key={m.name}
            cx={m.x}
            cy={m.z}
            r={unit * 0.28}
            fill="none"
            stroke="#e8e8e8"
            strokeWidth={stroke}
            opacity={0.85}
          />
        ))}
        {hydro.map((m) => (
          <rect
            key={m.name}
            x={m.x - unit * 0.3}
            y={m.z - unit * 0.3}
            width={unit * 0.6}
            height={unit * 0.6}
            fill="none"
            stroke="#ffd54f"
            strokeWidth={stroke}
            opacity={0.85}
          />
        ))}
        {spawns.map((m) => (
          // The army number lives in the tooltip rather than on the map: on a
          // four-player map numbered rings were the loudest thing on screen
          // while being the least looked at.
          <circle key={m.name} cx={m.x} cy={m.z} r={unit * 0.22} fill="#ffffff" opacity={0.6}>
            <title>{m.name}</title>
          </circle>
        ))}

        {shown.map((p) => {
          const hot = hovered === p.id;
          const dimmed = hovered !== null && !hot;
          const points = p.points.map((q) => `${q.x},${q.z}`).join(" ");
          return (
            <g key={p.id}>
              {/* A transparent fat stroke under the visible one: a hairline is
                  nearly impossible to hit with a mouse, and pointing at one is
                  the point. */}
              <polyline
                points={points}
                fill="none"
                stroke="transparent"
                strokeWidth={sizeX / 60}
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onMouseEnter={() => onHover(p.id)}
              />
              <polyline
                points={points}
                fill="none"
                stroke="#000000"
                strokeWidth={sizeX / 150}
                opacity={dimmed ? 0.12 : 0.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ pointerEvents: "none" }}
              />
              {/* Segment by segment rather than one polyline, so the actual
                  reclaiming can be painted while the rest keeps the unit's
                  colour. Only a leg between two reclaim stops counts: the
                  approach and the departure are travel. */}
              {p.points.slice(1).map((q, i) => {
                const prev = p.points[i];
                const reclaiming = q.reclaim && prev.reclaim;
                return (
                  <line
                    key={i}
                    x1={prev.x}
                    y1={prev.z}
                    x2={q.x}
                    y2={q.z}
                    stroke={reclaiming ? RECLAIM_COLOR : catColor(p.cat)}
                    strokeWidth={hot ? sizeX / 190 : stroke}
                    strokeLinecap="round"
                    opacity={dimmed ? 0.25 : 1}
                    style={{ pointerEvents: "none" }}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      <p className="muted training-run-caption">
        {(() => {
          const p = paths.find((x) => x.id === hovered);
          if (!p) {
            return t("training.run.mapSummary", {
              map: env.meta.map.name,
              size: `${sizeX}x${sizeZ}`,
              mass: mass.length,
              hydro: hydro.length,
            });
          }
          return t("training.run.pathSummary", {
            name: p.name,
            ordinal: p.ordinal,
            from: mmss(p.birth),
          });
        })()}
      </p>
    </div>
  );
}
