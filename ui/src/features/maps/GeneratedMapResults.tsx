import type { GeneratorDialogModel } from "./useGeneratorDialog";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { GeneratePreviewImg } from "./GenerateMapControls";
import { GeneratorFailure } from "../../shared/components/GeneratorFailure";
import { GeneratorProgress } from "./GeneratorProgress";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";
import { formatMapSize, summariseDecodedName } from "../../shared/generatorPresentation";

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
  return (
    <div className="generate-map-preview-pane">
      {!busy && failure && <GeneratorFailure reason={failure} onRetry={retry} className="generate-map-failure" />}

      {busy ? (
        <div className="generate-map-preview-loading">
          <div className="generate-map-preview-spinner" />
          <GeneratorProgress />
        </div>
      ) : currentMap ? (
        <div className="generate-map-preview-content">
          {results && results.length > 1 && (
            <div className="generate-map-multiselect-row">
              {results.map((map, idx) => (
                <button
                  key={map}
                  type="button"
                  className={`generate-map-thumb-btn${selectedMapIndex === idx ? " is-active" : ""}`}
                  onClick={() => setSelectedMapIndex(idx)}
                  title={map}
                >
                  <GeneratePreviewImg
                    url={previews[map]}
                    alt={map}
                    className="generate-map-thumb-img"
                    placeholderClassName="generate-map-thumb-placeholder"
                    iconSize={20}
                  />
                  <span className="generate-map-thumb-index">#{idx + 1}</span>
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

          <div className="generate-map-name-row">
            <div className="generate-map-name-wrap">
              <span className="generate-map-name-label">
                {t("maps.generate.reproduceTitle")}
              </span>
              <code className="generate-map-name-code" title={currentMap}>
                {currentMap}
              </code>
            </div>
            <Button onClick={() => copyCurrentName(currentMap)} title={t("maps.generate.copyName")}>
              <Icon name={copied ? "check" : "copy"} size={14} />
              {copied ? t("maps.generate.copied") : t("maps.generate.copy")}
            </Button>
          </div>

          <dl className="generate-map-specs-grid">
            <div>
              <dt>{t("maps.generate.mapSize")}</dt>
              <dd>{currentFacts ? formatMapSize(currentFacts.mapSize) : t("common.notAvailable")}</dd>
            </div>
            <div>
              <dt>{t("maps.generate.spawns")}</dt>
              <dd>
                {currentFacts
                  ? t("maps.generate.spawnCount", { count: currentFacts.spawnCount })
                  : t("common.notAvailable")}
              </dd>
            </div>
            <div>
              <dt>{t("maps.generate.teams")}</dt>
              <dd>
                {currentFacts
                  ? currentFacts.numTeams === 0
                    ? t("maps.generate.asymmetric")
                    : t("maps.generate.teamCount", { count: currentFacts.numTeams })
                  : t("common.notAvailable")}
              </dd>
            </div>
            <div>
              <dt>{t("maps.generate.symmetry")}</dt>
              <dd>{currentFacts?.symmetry || t("maps.generate.any")}</dd>
            </div>
            <div>
              <dt>{t("maps.generate.generatorVersion")}</dt>
              <dd>{currentFacts ? t("common.version", { version: currentFacts.version }) : t("common.notAvailable")}</dd>
            </div>
            <div>
              <dt>{t("maps.generate.seed")}</dt>
              <dd className="generate-map-spec-seed" title={currentFacts?.seed}>
                {currentFacts?.seed || t("common.notAvailable")}
              </dd>
            </div>
          </dl>

          {currentFacts && (
            <div className="generate-map-tags">
              {summariseDecodedName(currentFacts, t).map((fact) => (
                <span key={fact} className="generate-map-tag">
                  {fact}
                </span>
              ))}
            </div>
          )}

          <div className="generate-map-ready-badge">
            <Icon name="check" size={15} />
            <span>{t("maps.generate.installedReady")}</span>
          </div>

          <div className="generate-map-preview-actions">
            <Button
              type="button"
              className="generate-map-delete-btn"
              onClick={() => handleDeleteMap(currentMap)}
              title={t("maps.vault.uninstall")}
            >
              <Icon name="trash" size={14} />
              <span>{t("maps.generate.presetDelete")}</span>
            </Button>
            <Button
              type="button"
              variant="primary"
              className="generate-map-use-btn"
              onClick={() => {
                if (pickable) {
                  pick(currentMap);
                } else {
                  onClose();
                }
              }}
            >
              {pickable ? t("maps.generate.useMap") : t("maps.generate.close")}
            </Button>
          </div>
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
          <div className="generate-map-preview-empty-meta">
            <p className="generate-map-empty-hint">
              {reproducing
                ? t("maps.generate.rebuildingHint")
                : t("maps.generate.subtitle")}
            </p>
          </div>
          <div className="generate-map-preview-empty-footer">
            <span className="muted">
              {t("maps.generate.singleResultSubtitle")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
