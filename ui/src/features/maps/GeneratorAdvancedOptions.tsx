import { useEffect, useState } from "react";
import { GeneratorStyleOptions } from "./GeneratorStyleOptions";
import type { GeneratorDialogModel } from "./useGeneratorDialog";
import { Row } from "./GenerateMapControls";
import { Select } from "../../design-system/Select";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { isUsablePresetName, MAX_PRESET_NAME } from "../../shared/generatorPresets";
import { GENERATION_TYPES, deletePreset, preflight, loadHelp } from "./generatorCommands";

type PresetsModel = Pick<GeneratorDialogModel,
  | "t"
  | "reproducing"
  | "presetOptions"
  | "selectedPresetName"
  | "presets"
  | "applyPreset"
  | "rename"
  | "presetName"
  | "setPresetName"
  | "presetNameUsable"
  | "save"
  | "saved"
  | "existing"
>;

export function GeneratorAdvancedOptions({ model }: {
  model: Pick<GeneratorDialogModel,
    | "t"
    | "form"
    | "set"
    | "reproducing"
    | "typeOverrides"
    | "styleOverrides"
    | "lists"
    | "busy"
    | "state"
    | "showHelp"
    | "setShowHelp"
  >
}) {
  const { t, form, set, reproducing, typeOverrides, busy, state, showHelp, setShowHelp } = model;
  // The resolved name answers "Check options" and nothing else. Generating
  // resolves one too, as its own preflight, and that one is no answer to a
  // question anybody here asked: it is the run's business, so a run hides it.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (busy) setChecked(false);
  }, [busy]);
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
        <Row label={t("maps.generate.seed")} hint={t("maps.generate.seedHint")}>
          <div className="generate-map-seed">
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

        <Row
          label={t("maps.generate.rawArguments")}
          hint={t("maps.generate.rawArgumentsHint")}
        >
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
            <Button
              type="button"
              onClick={() => {
                setChecked(true);
                void preflight(form);
              }}
              disabled={busy}
            >
              {t("maps.generate.checkOptions")}
            </Button>
            {/* What the press answered. The backend clears it on
                the next edit, so it can never name the options
                that are no longer on screen. */}
            {checked && state.predictedName && !reproducing ? (
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
      {showHelp && (
        <pre className="generate-map-help">
          {state.helpText || t("maps.generate.loadingHelp")}
        </pre>
      )}
    </fieldset>
  );
}

export function GeneratorPresets({ model }: { model: PresetsModel }) {
  const { t, presetOptions, presets, applyPreset, rename, presetName, setPresetName,
    presetNameUsable, save, saved, existing } = model;

  return (
    <fieldset className="generate-map-fieldset" disabled={model.reproducing}>
      <div className="generate-map-presets">
        <div className="generate-map-grid-2col generate-map-grid-top">
          <Row label={t("maps.generate.presets")}>
            <Select
              label={t("maps.generate.presets")}
              value={model.selectedPresetName}
              placeholder={
                presets.length === 0
                  ? t("maps.generate.presetsEmpty")
                  : t("maps.generate.presetsLoad")
              }
              options={presetOptions}
              onChange={applyPreset}
              placement="top"
              optionAction={{
                icon: "trash",
                label: (option) => `${t("maps.generate.presetDelete")}: ${option.label}`,
                onSelect: (option) => void deletePreset(option.value),
                danger: true,
              }}
              optionRename={{
                label: (option) => `${t("maps.generate.presetRename")}: ${option.label}`,
                placeholder: (option) => option.label,
                confirmLabel: () => t("maps.generate.presetSave"),
                cancelLabel: () => t("maps.generate.cancel"),
                onRename: (option, name) => rename(option.value, name),
                isValid: (option, name) => {
                  const trimmed = name.trim();
                  return isUsablePresetName(trimmed)
                    && !presets.some((preset) =>
                      preset.name.toLowerCase() === trimmed.toLowerCase()
                      && preset.name !== option.value,
                    );
                },
              }}
            />
          </Row>

          <Row
            label={t("maps.generate.presetCreateName")}
            className="generate-map-row-tall generate-map-preset-create-row"
          >
            <div className="generate-map-preset-save-group">
              <div className="generate-map-preset-name-field">
                <input
                  className="generate-map-control"
                  value={presetName}
                  maxLength={MAX_PRESET_NAME}
                  aria-label={t("maps.generate.presetNamePlaceholder")}
                  placeholder={t("maps.generate.presetNamePlaceholder")}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <Button
                  type="button"
                  className="generate-map-preset-save-button"
                  disabled={!presetNameUsable}
                  onClick={save}
                >
                  {saved
                    ? t("maps.generate.settingsSaved")
                    : existing
                      ? t("maps.generate.presetReplace")
                      : t("maps.generate.presetSave")}
                </Button>
              </div>
            </div>
          </Row>
        </div>
      </div>
    </fieldset>
  );
}
