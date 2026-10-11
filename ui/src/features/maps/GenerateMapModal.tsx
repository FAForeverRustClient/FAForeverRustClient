// Generate a Neroxis map.
//
// FAF matchmaker maps are not files, they are recipes: a name encodes the
// generator version, seed and options, and every client rebuilds identical
// terrain. This dialog drives both directions: choosing options to produce a
// fresh map, and rebuilding one from a name.
//
// Three things here go beyond both reference clients:
//
//   * Combinations the generator would refuse are caught before a JAR is
//     downloaded and a JVM started, and the worst of them are unreachable in
//     the controls at all (spawn counts are filtered to multiples of the team
//     count, the way the Java client does it).
//   * `--parse` resolves the options to the map name they would produce, so
//     the name is shown, and confirmed valid, before anything is generated.
//   * A pasted map name is decoded locally into what it actually is.
//
// The option lists (styles, symmetries, etc.) are read out of the generator JAR
// itself, because they change between releases.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { summariseDecodedName } from "../../shared/generatorPresentation";
import { ZoomableImage } from "../../shared/components/MapPreviewZoom";
import { cancel } from "./generatorCommands";
import { Row } from "./GenerateMapControls";
import { GeneratorBasicOptions } from "./GeneratorBasicOptions";
import { GeneratorAdvancedOptions } from "./GeneratorAdvancedOptions";
import { GeneratedMapResults } from "./GeneratedMapResults";
import { useGeneratorDialog } from "./useGeneratorDialog";
import "./generate-map.css";

interface Props {
  onClose: () => void;
  /** Called with the generated folder names, e.g. to host one straight away. */
  onGenerated?: (maps: string[]) => void;
}

export function GenerateMapModal({ onClose, onGenerated }: Props) {
  const model = useGeneratorDialog(onClose, onGenerated);
  const { t, reproduceName, setReproduceName, reproducing, reproduceValid, decoded,
    showHelp, state, busy, submittable, submit, zoomed, setZoomed, currentPreviewUrl, currentMap } = model;

  return (
    // While the preview is zoomed, Escape and a backdrop click belong to the
    // zoom. The dialog owns the only close handler the modal has, so it hands
    // that handler over rather than racing a second Escape listener with it.
    <Modal onClose={zoomed ? () => setZoomed(false) : onClose} className="generate-map-modal" ariaLabel={t("maps.generate.title")}>
      <div className="generate-map-head">
        <h2 className="generate-map-title">{t("maps.generate.title")}</h2>
        <p className="generate-map-subtitle">{t("maps.generate.subtitle")}</p>
      </div>

      <div className="generate-map-unified-layout">
        {/* Left Column: Generator Form & Controls */}
        <div className="generate-map-form-pane">
          <form className="generate-map" onSubmit={submit}>
            {/* Outside every `<fieldset disabled={reproducing}>` below, and it
                has to stay outside: `disabled` on a fieldset is inherited by
                its descendants and a nested fieldset cannot take it back, so a
                name typed into a field *inside* one disabled itself on the
                first keystroke. The only way back out was closing the dialog. */}
            <div className="generate-map-reproduce">
              <Row label={t("maps.generate.reproduceTitle")}>
                <div className="generate-map-seed">
                  <input
                    className="generate-map-control"
                    value={reproduceName}
                    aria-invalid={reproducing && !reproduceValid}
                    aria-label={t("maps.generate.mapNameSeed")}
                    placeholder={t("maps.generate.mapNameSeedPlaceholder")}
                    onChange={(e) => setReproduceName(e.target.value)}
                  />
                  <button
                    type="button"
                    className="generate-map-seed-btn"
                    disabled={!reproducing}
                    aria-label={t("maps.generate.reproduceClear")}
                    title={t("maps.generate.reproduceClear")}
                    onClick={() => setReproduceName("")}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </Row>
            </div>

            {reproducing && (
              <div className="generate-map-banner">
                <strong>{t("maps.generate.rebuildingBanner")}</strong>
                <span>
                  {reproduceValid
                    ? t("maps.generate.rebuildingHint")
                    : t("maps.generate.notAGeneratedName")}
                </span>
                {decoded && (
                  <ul className="generate-map-facts">
                    {summariseDecodedName(decoded, t).map((fact) => (
                      <li key={fact} className="generate-map-fact">
                        {fact}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <GeneratorBasicOptions model={model} />

            <hr className="generate-map-divider" />

            <GeneratorAdvancedOptions model={model} />

            {showHelp && (
              <pre className="generate-map-help">
                {state.helpText || t("maps.generate.loadingHelp")}
              </pre>
            )}

            <div className="generate-map-actions">
              <Button type="button" onClick={onClose}>
                {t("maps.generate.close")}
              </Button>
              {busy && (
                <Button type="button" onClick={() => void cancel()}>
                  {t("maps.generate.cancel")}
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={busy || (reproducing ? !reproduceValid : !submittable)}
              >
                {busy
                  ? t("maps.generate.working")
                  : reproducing
                    ? t("maps.generate.reproduce")
                    : t("maps.generate.generate")}
              </Button>
            </div>
          </form>
        </div>

        {/* Right Column: Live Map Preview & Generation Output */}
        <GeneratedMapResults model={model} onClose={onClose} />
      </div>

      {zoomed && currentPreviewUrl && (
        <div
          className="generate-map-zoom-overlay"
          role="dialog"
          aria-label={t("maps.generate.enlargePreview")}
          onClick={() => setZoomed(false)}
        >
          {/* The stage swallows the click that closes the overlay. Dragging to
              pan starts with a press on the picture, and an overlay that closes
              on any click inside it would take the map away mid-drag. */}
          <div className="generate-map-zoom-stage" onClick={(event) => event.stopPropagation()}>
            <ZoomableImage label={currentMap ?? ""}>
              <img
                className="generate-map-zoom-img"
                src={currentPreviewUrl}
                alt={currentMap ?? ""}
                decoding="async"
              />
            </ZoomableImage>
          </div>
          <span className="generate-map-zoom-hint muted">{t("maps.generate.closePreview")}</span>
        </div>
      )}
    </Modal>
  );
}
