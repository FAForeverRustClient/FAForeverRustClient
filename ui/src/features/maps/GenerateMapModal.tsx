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
import { generatorParameters, summariseDecodedName } from "../../shared/generatorPresentation";
import { GeneratorFactsStrip } from "../../shared/components/GeneratorFactsStrip";
import { MapPreviewDialog } from "../../shared/components/MapPreviewZoom";
import { cancel } from "./generatorCommands";
import { Row } from "./GenerateMapControls";
import { GeneratorBasicOptions } from "./GeneratorBasicOptions";
import { GeneratorAdvancedOptions, GeneratorPresets } from "./GeneratorAdvancedOptions";
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
    busy, submittable, submit, zoomed, setZoomed, currentMap, currentFacts } = model;

  return (
    // The enlarged preview is a dialog of its own on top of this one, and the
    // overlay stack hands Escape to whichever is topmost.
    <Modal onClose={onClose} className="generate-map-modal" ariaLabel={t("maps.generate.title")}>
      <div className="generate-map-head">
        <h2 className="generate-map-title">{t("maps.generate.title")}</h2>
      </div>

      <div className="generate-map-unified-layout">
        {/* Left Column: Generator Form & Controls */}
        <div className="generate-map-form-pane">
          <form className="generate-map" onSubmit={submit}>
            <div className="generate-map-scroll-content">
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
            </div>

            <GeneratorPresets model={model} />

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

      {/* The map at full size in the dialog every other tab opens a map in:
          its frame, its title with the copy button, the zoom and the star,
          and the map's settings under the picture as the result pane has
          them. */}
      {zoomed && currentMap && (
        <MapPreviewDialog
          map={{ folderName: currentMap, displayName: currentMap }}
          footer={currentFacts && (
            <GeneratorFactsStrip
              rows={generatorParameters(currentFacts, t)}
              label={t("maps.generate.reproduceTitle")}
              columns={4}
              dense
            />
          )}
          onClose={() => setZoomed(false)}
        />
      )}
    </Modal>
  );
}
