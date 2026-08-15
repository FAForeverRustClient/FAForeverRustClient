// Generate a Neroxis map: the Java client's `GenerateMapController`.
//
// FAF matchmaker maps are not files, they are recipes: a name encodes the
// generator version and seed, and every client rebuilds identical terrain. This
// dialog drives the other direction: choosing options to produce a fresh map
// you can then host.
//
// The option lists (styles, symmetries, etc.) are read out of the generator JAR
// itself, because they change between releases.

import { useEffect, useState } from "react";
import type { GenerationType, GeneratorOptions } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { MultiSelect } from "../../design-system/MultiSelect";
import { RangeSlider } from "../../design-system/RangeSlider";
import { ipc } from "../../ipc/client";
import { isGeneratedMap } from "../../shared/mapPresentation";
import { recordEntries } from "../../shared/records";
import { useAppStore } from "../../store/store";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import "./generate-map.css";

/** Map sizes the generator accepts, in 1.25 km increments (256 units = 5 km). */
const MAP_SIZES: { value: number; label: string }[] = [
  { value: 256, label: "5 km (256x256)" },
  { value: 320, label: "6.25 km (320x320)" },
  { value: 384, label: "7.5 km (384x384)" },
  { value: 448, label: "8.75 km (448x448)" },
  { value: 512, label: "10 km (512x512)" },
  { value: 640, label: "12.5 km (640x640)" },
  { value: 768, label: "15 km (768x768)" },
  { value: 1024, label: "20 km (1024x1024)" },
  { value: 2048, label: "40 km (2048x2048)" },
];

/** Labels from the Java client's `game.generateMap.*` strings. */
const GENERATION_TYPES = {
  casual: { label: "maps.generate.kind.casual", hint: "maps.generate.kind.casualHint" },
  tournament: { label: "maps.generate.kind.tournament", hint: "maps.generate.kind.tournamentHint" },
  blind: { label: "maps.generate.kind.blind", hint: "maps.generate.kind.blindHint" },
  unexplored: { label: "maps.generate.kind.unexplored", hint: "maps.generate.kind.unexploredHint" },
} as const satisfies Record<GenerationType, { label: MessageKey; hint: MessageKey }>;

const generate = (options: GeneratorOptions) =>
  ipc.send({ kind: "MapGenerator", command: { type: "generate", payload: { options } } });
const generateNamed = (mapName: string) =>
  ipc.send({ kind: "MapGenerator", command: { type: "generateNamed", payload: { mapName } } });
const loadOptions = (version?: string | null) =>
  ipc.send({
    kind: "MapGenerator",
    command: { type: "loadOptions", payload: { version: version ?? null } },
  });
const setOptions = (options: GeneratorOptions) =>
  ipc.send({ kind: "MapGenerator", command: { type: "setOptions", payload: { options } } });

interface Props {
  onClose: () => void;
  /** Called with the generated folder names, e.g. to host one straight away. */
  onGenerated?: (maps: string[]) => void;
}

export function GenerateMapModal({ onClose, onGenerated }: Props) {
  const { t } = useTranslation();
  const state = useAppStore((s) => s.state.mapGenerator);
  const [form, setForm] = useState<GeneratorOptions>(state.options);
  const [advanced, setAdvanced] = useState(false);

  // The option lists come from the generator itself, so they need a round trip
  // (and possibly a JAR download) before the pickers mean anything.
  useEffect(() => {
    if (useAppStore.getState().state.mapGenerator.optionLists.styles.length === 0) {
      void loadOptions();
    }
  }, []);

  // Hand the finished maps back when a run this dialog started completes.
  const [started, setStarted] = useState(false);
  const [choices, setChoices] = useState<string[]>([]);
  useEffect(() => {
    if (started && state.status.type === "generated") {
      setStarted(false);
      const maps = state.status.payload.maps;
      if (maps.length > 1) setChoices(maps);
      else onGenerated?.(maps);
    }
  }, [started, state.status, onGenerated]);

  const choose = (map: string) => {
    setChoices([]);
    onGenerated?.([map]);
  };

  const set = <K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const busy =
    state.status.type === "resolvingVersion" ||
    state.status.type === "downloading" ||
    state.status.type === "generating";

  const [reproduceName, setReproduceName] = useState("");
  const reproducing = reproduceName.trim() !== "";
  const reproduceError =
    reproducing && !isGeneratedMap(reproduceName.trim())
      ? "That is not a generated map name. They look like neroxis_map_generator_1.7.7_<seed>."
      : "";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (reproducing) {
      if (reproduceError) return;
      setStarted(true);
      void generateNamed(reproduceName.trim());
      return;
    }
    setStarted(true);
    void generate(form);
  };

  const seedPinsOneMap = form.seed.trim() !== "";

  const lists = state.optionLists;
  const availableVersions = state.availableVersions ?? [];
  const previews = state.previews ?? {};

  const styleOverrides = (form.styles?.length ?? 0) > 0 || Boolean(form.style);
  const typeOverrides = form.generationType !== "casual";

  if (choices.length > 0) {
    return (
      <Modal onClose={onClose}>
        <h2 className="generate-map-title">{t("maps.generate.chooseMap")}</h2>
        <p className="muted generate-map-note">
          {t("maps.generate.choicesNote", { count: choices.length })}
        </p>
        <div className="generate-map-choices-grid">
          {choices.map((map) => {
            const previewUrl = previews[map];
            return (
              <button
                key={map}
                type="button"
                className="generate-map-card"
                onClick={() => choose(map)}
              >
                <div className="generate-map-card-thumb">
                  {previewUrl ? (
                    <img src={previewUrl} alt={map} className="generate-map-card-img" />
                  ) : (
                    <div className="generate-map-card-placeholder">
                      <Icon name="maps" size={32} />
                    </div>
                  )}
                </div>
                <div className="generate-map-card-meta">
                  <span className="generate-map-card-name" title={map}>
                    {map}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        <div className="generate-map-actions">
          <Button type="button" onClick={() => setChoices([])}>
            {t("maps.generate.backToOptions")}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} className="generate-map-modal">
      <div className="generate-map-head">
        <h2 className="generate-map-title">{t("maps.generate.title")}</h2>
        <p className="generate-map-subtitle">Configure Neroxis procedural map generator options or rebuild an exact recipe.</p>
      </div>

      <form className="generate-map" onSubmit={submit}>
        <div className="generate-map-reproduce-section">
          <div className="generate-map-reproduce-header">
            <label htmlFor="reproduce-name" className="generate-map-label">
              {t("maps.generate.reproduceTitle")}
            </label>
            <span className="generate-map-hint">{t("maps.generate.reproduceHint")}</span>
          </div>
          <input
            id="reproduce-name"
            className="generate-map-control generate-map-reproduce-input"
            value={reproduceName}
            placeholder="neroxis_map_generator_1.7.7_..."
            aria-invalid={Boolean(reproduceError)}
            onChange={(e) => setReproduceName(e.target.value)}
          />
          {reproduceError && <small className="generate-map-error">{reproduceError}</small>}
        </div>

        <fieldset className="generate-map-fieldset" disabled={reproducing}>
          <div className="generate-map-primary-grid">
            <label className="generate-map-field">
              <span className="generate-map-label">{t("maps.generate.generatorVersion")}</span>
              <div className="generate-map-select-wrap">
                <select
                  className="generate-map-control generate-map-select"
                  value={form.version ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    set("version", v);
                    void loadOptions(v);
                  }}
                >
                  <option value="">
                    Latest ({state.latestVersion ? state.latestVersion : "auto"})
                  </option>
                  {availableVersions
                    .filter((v) => v !== state.latestVersion)
                    .map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                </select>
                <Icon name="chevronDown" size={13} className="generate-map-select-arrow" />
              </div>
            </label>

            <label className="generate-map-field">
              <span className="generate-map-label">{t("maps.generate.mapSize")}</span>
              <div className="generate-map-select-wrap">
                <select
                  className="generate-map-control generate-map-select"
                  value={form.mapSize ?? 512}
                  onChange={(e) => set("mapSize", Number(e.target.value))}
                >
                  {MAP_SIZES.map((size) => (
                    <option key={size.value} value={size.value}>
                      {size.label}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={13} className="generate-map-select-arrow" />
              </div>
            </label>

            <label className="generate-map-field">
              <span className="generate-map-label">{t("maps.generate.spawns")}</span>
              <input
                type="number"
                className="generate-map-control"
                min={2}
                max={16}
                value={form.spawnCount ?? 6}
                onChange={(e) => set("spawnCount", Number(e.target.value))}
              />
            </label>

            <label className="generate-map-field">
              <span className="generate-map-label">{t("maps.generate.teams")}</span>
              <input
                type="number"
                className="generate-map-control"
                min={2}
                max={8}
                value={form.numTeams ?? 2}
                onChange={(e) => set("numTeams", Number(e.target.value))}
              />
            </label>

            <label className="generate-map-field">
              <span className="generate-map-label">{t("maps.generate.count")}</span>
              <input
                type="number"
                className="generate-map-control"
                min={1}
                max={10}
                disabled={seedPinsOneMap}
                value={seedPinsOneMap ? 1 : form.numToGenerate ?? 1}
                onChange={(e) => set("numToGenerate", Number(e.target.value))}
              />
              {seedPinsOneMap && <small className="generate-map-field-hint">{t("maps.generate.seedPinsOneMap")}</small>}
            </label>
          </div>

          <div className="generate-map-styles-group">
            <span className="generate-map-label">{t("maps.generate.styleOfGame")}</span>
            <div className="generate-map-styles-grid" role="radiogroup">
              {recordEntries(GENERATION_TYPES).map(([value, generationType]) => {
                const active = form.generationType === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`generate-map-style-card${active ? " active" : ""}`}
                    onClick={() => set("generationType", value)}
                  >
                    <div className="generate-map-style-card-header">
                      <span className="generate-map-style-title">{t(generationType.label)}</span>
                    </div>
                    <span className="generate-map-style-hint">{t(generationType.hint)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            className="generate-map-advanced-toggle"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            <Icon name="chevronDown" size={13} className="generate-map-toggle-icon" />
            <span>{advanced ? t("maps.generate.fewerOptions") : t("maps.generate.moreOptions")}</span>
          </button>

          {advanced && (
            <div className="generate-map-advanced">
              {typeOverrides && (
                <p className="generate-map-note">
                  {t("maps.generate.typeOverridesNote", { type: t(GENERATION_TYPES[form.generationType].label) })}
                </p>
              )}

              <div className="generate-map-advanced-grid-3">
                <label className="generate-map-field">
                  <span className="generate-map-label">{t("maps.generate.seed")}</span>
                  <span className="generate-map-seed">
                    <input
                      className="generate-map-control"
                      value={form.seed}
                      placeholder={t("maps.generate.random")}
                      onChange={(e) => set("seed", e.target.value)}
                    />
                    <button
                      type="button"
                      className="generate-map-seed-btn"
                      aria-label={t("maps.generate.rerollSeed")}
                      title={t("maps.generate.rerollSeed")}
                      onClick={() =>
                        set("seed", String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)))
                      }
                    >
                      <Icon name="refresh" size={13} />
                    </button>
                  </span>
                </label>

                <MultiSelect
                  label={t("maps.generate.symmetries")}
                  options={lists.symmetries.map((s) => ({ value: s, label: s }))}
                  selected={form.symmetries ?? []}
                  onChange={(symmetries) => set("symmetries", symmetries)}
                  anyLabel={t("maps.generate.randomAny")}
                />

                <MultiSelect
                  label={t("maps.generate.mapStyles")}
                  options={lists.styles.map((s) => ({ value: s, label: s }))}
                  selected={form.styles ?? []}
                  onChange={(styles) => set("styles", styles)}
                  anyLabel={t("maps.generate.randomAny")}
                />
              </div>

              {styleOverrides && (
                <p className="generate-map-note">
                  {t("maps.generate.mapStyleHint")}
                </p>
              )}

              <div className="generate-map-advanced-grid-4">
                <MultiSelect
                  label={t("maps.generate.terrainStyles")}
                  options={lists.terrainStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.terrainStyles ?? []}
                  onChange={(terrainStyles) => set("terrainStyles", terrainStyles)}
                  anyLabel={t("maps.generate.randomAny")}
                />
                <MultiSelect
                  label={t("maps.generate.textureStyles")}
                  options={lists.textureStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.textureStyles ?? []}
                  onChange={(textureStyles) => set("textureStyles", textureStyles)}
                  anyLabel={t("maps.generate.randomAny")}
                />
                <MultiSelect
                  label={t("maps.generate.resourceStyles")}
                  options={lists.resourceStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.resourceStyles ?? []}
                  onChange={(resourceStyles) => set("resourceStyles", resourceStyles)}
                  anyLabel={t("maps.generate.randomAny")}
                />
                <MultiSelect
                  label={t("maps.generate.propStyles")}
                  options={lists.propStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.propStyles ?? []}
                  onChange={(propStyles) => set("propStyles", propStyles)}
                  anyLabel={t("maps.generate.randomAny")}
                />
              </div>

              <div className="generate-map-sliders">
                <RangeSlider
                  label={t("maps.generate.reclaimDensity")}
                  min={0}
                  max={127}
                  low={form.reclaimDensityMin ?? null}
                  high={form.reclaimDensityMax ?? null}
                  onChange={(low, high) => {
                    set("reclaimDensityMin", low);
                    set("reclaimDensityMax", high);
                  }}
                />
                <RangeSlider
                  label={t("maps.generate.resourceDensity")}
                  min={0}
                  max={127}
                  low={form.resourceDensityMin ?? null}
                  high={form.resourceDensityMax ?? null}
                  onChange={(low, high) => {
                    set("resourceDensityMin", low);
                    set("resourceDensityMax", high);
                  }}
                />
              </div>

              <label className="generate-map-field">
                <span className="generate-map-label">{t("maps.generate.rawArguments")}</span>
                <input
                  className="generate-map-control"
                  value={form.commandLineArgs}
                  placeholder={t("maps.generate.overridesEveryOption")}
                  onChange={(e) => set("commandLineArgs", e.target.value)}
                />
              </label>
            </div>
          )}
        </fieldset>

        <GeneratorProgress />

        <div className="generate-map-actions">
          <Button type="button" onClick={onClose}>
            {t("maps.generate.close")}
          </Button>
          <Button
            type="button"
            disabled={reproducing}
            onClick={() => {
              void setOptions(form);
            }}
          >
            {t("maps.generate.saveSettings")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || Boolean(reproduceError)}>
            {busy ? t("maps.generate.working") : reproducing ? t("maps.generate.reproduce") : t("maps.generate.generate")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The three slow stages, narrated. Generation routinely takes 30-120 seconds. */
export function GeneratorProgress() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.state.mapGenerator.status);

  switch (status.type) {
    case "idle":
      return null;
    case "resolvingVersion":
      return <p className="muted generate-map-progress">{t("maps.generate.lookingUp")}</p>;
    case "downloading": {
      const { downloadedBytes, totalBytes, version } = status.payload;
      const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
      return (
        <p className="muted generate-map-progress">
          {percent === null
            ? t("maps.generate.downloading", { version })
            : t("maps.generate.downloadingPercent", { version, percent })}
        </p>
      );
    }
    case "generating":
      return (
        <p className="muted generate-map-progress">
          {t("maps.generate.generatingWith", { version: status.payload.version, detail: status.payload.detail })}
        </p>
      );
    case "generated":
      return (
        <p className="generate-map-progress is-ok">
          {t("maps.generate.ready", { maps: status.payload.maps.join(", ") })}
        </p>
      );
    case "failed":
      return <p className="generate-map-progress is-error">{status.payload.reason}</p>;
  }
}
