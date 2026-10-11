import { GeneratorStyleOptions } from "./GeneratorStyleOptions";
import type { GeneratorDialogModel } from "./useGeneratorDialog";
import { Row } from "./GenerateMapControls";
import { Select } from "../../design-system/Select";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { MAX_PRESET_NAME } from "../../shared/generatorPresets";
import { GENERATION_TYPES, deletePreset, preflight, loadHelp } from "./generatorCommands";

export function GeneratorAdvancedOptions({ model }: {
  model: Pick<GeneratorDialogModel,
    | "t"
    | "form"
    | "set"
    | "reproducing"
    | "typeOverrides"
    | "styleOverrides"
    | "lists"
    | "presetOptions"
    | "presets"
    | "applyPreset"
    | "presetName"
    | "setPresetName"
    | "presetNameUsable"
    | "save"
    | "saved"
    | "existing"
    | "busy"
    | "state"
    | "showHelp"
    | "setShowHelp"
  >
}) {
  const { t, form, set, reproducing, typeOverrides, presetOptions, presets, applyPreset, presetName, setPresetName, presetNameUsable, save, saved, existing, busy, state, showHelp, setShowHelp } = model;
  return (
    <fieldset className="generate-map-fieldset" disabled={reproducing}>
      {typeOverrides && (
        <p className="generate-map-note">
          {t("maps.generate.typeOverridesNote", {
            type: t(GENERATION_TYPES[form.generationType].label),
          })}
        </p>
      )}

      <GeneratorStyleOptions model={model} />

      <hr className="generate-map-divider" />

      <div className="generate-map-grid-2col">
        <Row label={t("maps.generate.seed")}>
          <div className="generate-map-seed" title={t("maps.generate.seedHint")}>
            <input
              className="generate-map-control"
              value={form.seed}
              disabled={reproducing}
              placeholder={t("maps.generate.random")}
              aria-label={t("maps.generate.seed")}
              onChange={(e) => set("seed", e.target.value.replace(/[^\d-]/g, ""))}
            />
            <button
              type="button"
              className="generate-map-seed-btn"
              disabled={reproducing}
              aria-label={t("maps.generate.rerollSeed")}
              title={t("maps.generate.rerollSeed")}
              onClick={() =>
                set("seed", String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)))
              }
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>
        </Row>

        <Row label={t("maps.generate.outputPath")}>
          <input
            className="generate-map-control"
            value={form.outputPath}
            aria-label={t("maps.generate.outputPath")}
            placeholder={t("maps.generate.outputPathHint")}
            onChange={(e) => set("outputPath", e.target.value)}
          />
        </Row>

        <Row label={t("maps.generate.rawArguments")}>
          <input
            className="generate-map-control"
            value={form.commandLineArgs}
            aria-label={t("maps.generate.rawArguments")}
            placeholder={t("maps.generate.overridesEveryOption")}
            onChange={(e) => set("commandLineArgs", e.target.value)}
          />
        </Row>
      </div>

      <hr className="generate-map-divider" />

      {/* Top-aligned: the right cell carries a field with buttons
                      under it and the left one a single dropdown, and stretched
                      cells put those two on different lines. */}
      <div className="generate-map-grid-2col generate-map-grid-top">
        <Row label={t("maps.generate.presets")}>
          <Select
            label={t("maps.generate.presets")}
            value=""
            placeholder={
              presets.length === 0
                ? t("maps.generate.presetsEmpty")
                : t("maps.generate.presetsLoad")
            }
            options={presetOptions}
            onChange={applyPreset}
          />
        </Row>

        <Row label={t("maps.generate.presetName")} className="generate-map-row-tall">
          <div className="generate-map-preset-save-group">
            <input
              className="generate-map-control"
              value={presetName}
              maxLength={MAX_PRESET_NAME}
              aria-label={t("maps.generate.presetName")}
              placeholder={t("maps.generate.presetName")}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <div className="generate-map-preset-save-group-buttons">
              <Button type="button" disabled={!presetNameUsable} onClick={save}>
                {saved
                  ? t("maps.generate.settingsSaved")
                  : existing
                    ? t("maps.generate.presetReplace")
                    : t("maps.generate.presetSave")}
              </Button>
              {existing && (
                <Button type="button" onClick={() => void deletePreset(existing.name)}>
                  {t("maps.generate.presetDelete")}
                </Button>
              )}
            </div>
          </div>
        </Row>
      </div>

      <hr className="generate-map-divider" />

      <div className="generate-map-grid-2col">
        <Row label={t("maps.generate.diagnostics")}>
          <div className="generate-map-checks-group">
            <label className="generate-map-check">
              <input
                type="checkbox"
                checked={form.visualize}
                onChange={(e) => set("visualize", e.target.checked)}
              />
              <span title={t("maps.generate.visualizeHint")}>
                {t("maps.generate.visualize")}
              </span>
            </label>
            <label className="generate-map-check">
              <input
                type="checkbox"
                checked={form.debug}
                onChange={(e) => set("debug", e.target.checked)}
              />
              <span title={t("maps.generate.debugHint")}>{t("maps.generate.debug")}</span>
            </label>
          </div>
        </Row>

        <Row label={t("maps.generate.tools")}>
          <div className="generate-map-tools-group">
            <Button type="button" onClick={() => void preflight(form)} disabled={busy}>
              {t("maps.generate.checkOptions")}
            </Button>
            {/* What the press answered. The backend clears it on
                            the next edit, so it can never name the options
                            that are no longer on screen. */}
            {state.predictedName && !reproducing ? (
              <code className="generate-map-name-code">{state.predictedName}</code>
            ) : null}
            <Button
              type="button"
              onClick={() => {
                setShowHelp((open) => !open);
                if (!state.helpText) void loadHelp(form.version);
              }}
            >
              {showHelp ? t("maps.generate.hideHelp") : t("maps.generate.showHelp")}
            </Button>
          </div>
        </Row>
      </div>
    </fieldset>
  );
}
