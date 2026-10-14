import { useEffect, useRef } from "react";
import type { GeneratorDialogModel } from "./useGeneratorDialog";
import type { DecodedMapName } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { GeneratePreviewImg } from "./GenerateMapControls";
import { GeneratorFailure } from "../../shared/components/GeneratorFailure";
import { GeneratorProgress } from "./GeneratorProgress";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";
import { GeneratorFactsStrip } from "../../shared/components/GeneratorFactsStrip";
import { generatorParameters } from "../../shared/generatorPresentation";
import { useGeneratedMapArt } from "../../shared/markedMapPreview";

/// One of several maps from a run, as a thumbnail: with FAF's icons on it,
/// as the large picture beside it has them.
function GeneratedResultThumb({ mapName, fallbackUrl }: { mapName: string; fallbackUrl: string | undefined }) {
  const url = useGeneratedMapArt(mapName) ?? fallbackUrl;
  return (
    <GeneratePreviewImg
      url={url}
      alt={mapName}
      className="generate-map-thumb-img"
    />
  );
}

/// What the pane shows under the picture for one map: its name with the copy
/// icon, every setting the name carries, and what to do with it.
function ResultDetails({ t, map, facts, copied, onCopy, onDelete, onUse, useLabel }: {
  t: GeneratorDialogModel["t"];
  map: string;
  facts: DecodedMapName | undefined;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onUse: () => void;
  useLabel: string;
}) {
  return (
    <>
      {/* The name is the map: anyone given it rebuilds the same terrain.
          So it reads as text, whole, with only the copy icon beside it. */}
      <div className="generate-map-name-row">
        <span className="generate-map-name-label">
          {t("maps.generate.reproduceTitle")}
        </span>
        <div className="generate-map-name-line">
          <span className="generate-map-name-text">{map}</span>
          <button
            type="button"
            className="generate-map-name-copy"
            onClick={onCopy}
            title={copied ? t("maps.generate.copied") : t("maps.generate.copyName")}
            aria-label={t("maps.generate.copyName")}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
        </div>
      </div>

      {/* Every setting the name carries, labelled, in the facts grid the
          detail panels share. Until the name has been decoded there is
          nothing honest to put in it. */}
      {facts && (
        <GeneratorFactsStrip
          className="generate-map-facts-strip"
          rows={generatorParameters(facts, t)}
          label={t("maps.generate.reproduceTitle")}
        />
      )}

      <div className="generate-map-preview-actions">
        <Button
          type="button"
          className="generate-map-delete-btn"
          onClick={onDelete}
          title={t("maps.vault.uninstall")}
        >
          <Icon name="trash" size={14} />
          <span>{t("maps.generate.presetDelete")}</span>
        </Button>
        <Button type="button" variant="primary" className="generate-map-use-btn" onClick={onUse}>
          {useLabel}
        </Button>
      </div>
    </>
  );
}

/// The stand-in that sizes the pane: a custom style, so every setting has a
/// row and the facts grid is at its fullest, and a name longer than a real
/// one, so a real name never wraps onto a line the stand-in did not hold.
const GHOST_MAP =
  "neroxis_map_generator_1.22.2_22fujwnfvalrk_cahaebahbuaaa5c6_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GHOST_FACTS: DecodedMapName = {
  version: "1.22.2",
  seed: "-4410288813345762171",
  spawnCount: 6,
  mapSize: 512,
  numTeams: 2,
  symmetry: "POINT2",
  style: {
    kind: "custom",
    terrainStyle: "MOUNTAIN_RANGE",
    textureStyle: "TEMPERATE",
    resourceStyle: "BASIC",
    propStyle: "ENEMY_CIV",
    reclaimDensity: 3,
    resourceDensity: 5,
  },
  visibility: null,
  generatedAt: null,
  options: null,
};

const noop = () => {};

export function GeneratedMapResults({ model, onClose }: {
  onClose: () => void; model: Pick<GeneratorDialogModel,
    | "failure"
    | "retry"
    | "t"
    | "busy"
    | "results"
    | "currentMap"
    | "selectedMapIndex"
    | "setSelectedMapIndex"
    | "previews"
    | "currentPreviewUrl"
    | "setZoomed"
    | "currentFacts"
    | "copied"
    | "copyCurrentName"
    | "handleDeleteMap"
    | "pickable"
    | "pick"
    | "reproducing"
  >
}) {
  const { failure, retry, t, busy, results, currentMap, selectedMapIndex, setSelectedMapIndex, previews, currentPreviewUrl, setZoomed, currentFacts, copied, copyCurrentName, handleDeleteMap, pickable, pick, reproducing } = model;

  // The arrow keys step through the run (see `useGeneratorDialog`). Focus
  // follows the step when it is in the strip: left on the thumbnail that was
  // clicked, it drew its focus ring there while the outline moved on, and two
  // thumbnails looked selected. And the shown one is scrolled into view, for a
  // run longer than the strip is wide.
  const thumbsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = thumbsRef.current;
    const shown = strip?.querySelectorAll<HTMLButtonElement>(".generate-map-thumb")[selectedMapIndex];
    if (!strip || !shown) return;
    if (strip.contains(document.activeElement) && document.activeElement !== shown) shown.focus();
    // The strip alone, sideways: `scrollIntoView` would also scroll the pane
    // and the dialog around it.
    const stripBox = strip.getBoundingClientRect();
    const shownBox = shown.getBoundingClientRect();
    if (shownBox.left < stripBox.left) strip.scrollLeft -= stripBox.left - shownBox.left;
    else if (shownBox.right > stripBox.right) strip.scrollLeft += shownBox.right - stripBox.right;
  }, [selectedMapIndex]);
  const useLabel = pickable ? t("maps.generate.useMap") : t("maps.generate.close");
  return (
    <div className="generate-map-preview-pane">
      {/* The pane is always as tall as it is with one generated map in it, so
          the dialog does not change size when the first result arrives. An
          invisible one-map result shares the cell with what is really shown
          and holds that height: built from the real parts, so it stays right
          in every language and at every width. */}
      <div className="generate-map-preview-stack">
        <div className="generate-map-preview-ghost" aria-hidden="true">
          {/* The thumbnail row a run of several maps adds, held for every run:
              otherwise asking for two maps grew the dialog by a row. */}
          <div className="generate-map-thumbs">
            <span className="generate-map-thumb">
              <span className="generate-map-thumb-img" />
              <span className="generate-map-thumb-index">1</span>
            </span>
          </div>
          <div className="generate-map-preview-img-wrap" />
          <ResultDetails
            t={t}
            map={GHOST_MAP}
            facts={GHOST_FACTS}
            copied={false}
            onCopy={noop}
            onDelete={noop}
            onUse={noop}
            useLabel={useLabel}
          />
        </div>

        <div className="generate-map-preview-live">
          {!busy && failure && <GeneratorFailure reason={failure} onRetry={retry} className="generate-map-failure" />}

          {busy ? (
            <div className="generate-map-preview-loading">
              <div className="generate-map-preview-spinner" />
              <GeneratorProgress />
            </div>
          ) : currentMap ? (
            <div className="generate-map-preview-content">
              {results && results.length > 1 && (
                // The run's maps as a strip of their pictures, each numbered
                // under it; only the shown one is outlined.
                <div className="generate-map-thumbs" ref={thumbsRef}>
                  {results.map((map, idx) => (
                    <button
                      key={map}
                      type="button"
                      className={`generate-map-thumb${selectedMapIndex === idx ? " is-active" : ""}`}
                      aria-pressed={selectedMapIndex === idx}
                      onClick={() => setSelectedMapIndex(idx)}
                      title={map}
                    >
                      <GeneratedResultThumb mapName={map} fallbackUrl={previews[map]} />
                      <span className="generate-map-thumb-index">{idx + 1}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* The preview is small enough that spawn positions and
                  plateaus are guesswork, so it opens full size. Only when
                  there is a real preview: the placeholder has nothing to
                  enlarge. */}
              <button
                type="button"
                className="generate-map-preview-img-wrap generate-map-preview-zoom"
                onClick={() => currentPreviewUrl && setZoomed(true)}
                disabled={!currentPreviewUrl}
                title={t("maps.generate.enlargePreview")}
                aria-label={t("maps.generate.enlargePreview")}
              >
                <GeneratePreviewImg
                  url={currentPreviewUrl}
                  alt={currentMap}
                  className="generate-map-preview-img"
                  placeholderClassName="generate-map-preview-placeholder"
                  iconSize={48}
                />
              </button>

              <ResultDetails
                t={t}
                map={currentMap}
                facts={currentFacts}
                copied={copied}
                onCopy={() => copyCurrentName(currentMap)}
                onDelete={() => handleDeleteMap(currentMap)}
                onUse={() => {
                  if (pickable) {
                    pick(currentMap);
                  } else {
                    onClose();
                  }
                }}
                useLabel={useLabel}
              />
            </div>
          ) : (
            <div className="generate-map-preview-empty">
              <div className="generate-map-preview-img-wrap">
                <img
                  src={GENERATED_MAP_PLACEHOLDER_URL}
                  alt={t("maps.generate.title")}
                  className="generate-map-preview-img"
                />
              </div>
              {/* No predicted name here. It stood in this panel unprompted,
                      showing the name resolved for whatever the options were when
                      a preflight last ran, and it did not move when they were
                      edited: a map name presented as fact, for a map nobody had
                      asked for, which the options on screen would not produce. It
                      is the answer to "Check options" now, beside that button. */}
              {reproducing && (
                <div className="generate-map-preview-empty-meta">
                  <p className="generate-map-empty-hint">{t("maps.generate.rebuildingHint")}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
