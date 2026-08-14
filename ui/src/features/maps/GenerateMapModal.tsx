// Generate a Neroxis map: the Java client's `GenerateMapController`.
//
// FAF matchmaker maps are not files, they are *recipes*: a name encodes the
// generator version and seed, and every client rebuilds identical terrain. This
// dialog drives the other direction: choosing options to produce a fresh map
// you can then host.
//
// The option lists (styles, symmetries, …) are not hardcoded: they are read out
// of the generator JAR itself, because they change between releases. Until
// they load, the corresponding pickers stay disabled rather than offering
// values that might not exist in the installed generator.

import { useEffect, useState } from "react";
import type { GenerationType, GeneratorOptions } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { recordEntries } from "../../shared/records";
import { useAppStore } from "../../store/store";
import "./generate-map.css";
import { useTranslation } from "../../i18n/useTranslation";

/** Map sizes the generator accepts, as the km figure players think in. */
const MAP_SIZES: { value: number; label: string }[] = [
  { value: 256, label: "5 km" },
  { value: 512, label: "10 km" },
  { value: 1024, label: "20 km" },
  { value: 2048, label: "40 km" },
];

/** Labels from the Java client's `game.generateMap.*` strings. */
const GENERATION_TYPES: Record<GenerationType, { label: string; hint: string }> = {
  casual: { label: "maps.generate.kind.casual", hint: "maps.generate.kind.casualHint" },
  tournament: { label: "maps.generate.kind.tournament", hint: "maps.generate.kind.tournamentHint" },
  blind: { label: "maps.generate.kind.blind", hint: "maps.generate.kind.blindHint" },
  unexplored: { label: "maps.generate.kind.unexplored", hint: "maps.generate.kind.unexploredHint" },
};

const generate = (options: GeneratorOptions) =>
  ipc.send({ kind: "MapGenerator", command: { type: "generate", payload: { options } } });
const loadOptions = () =>
  ipc.send({ kind: "MapGenerator", command: { type: "loadOptions" } });
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

  // Hand the finished maps back when a run *this dialog started* completes.
  //
  // The guard matters: `status` is global and survives the dialog closing, so
  // without it re-opening the dialog would immediately report the previous
  // run's maps as if they were fresh: silently re-selecting a stale map in
  // the host form.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started && state.status.type === "generated") {
      setStarted(false);
      onGenerated?.(state.status.payload.maps);
    }
  }, [started, state.status, onGenerated]);

  const set = <K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const busy =
    state.status.type === "resolvingVersion" ||
    state.status.type === "downloading" ||
    state.status.type === "generating";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setStarted(true);
    void generate(form);
  };

  const lists = state.optionLists;
  const listsReady = lists.styles.length > 0;

  // A whole-map style overrides the component styles, so the generator ignores
  // them: say so rather than letting the user set contradictory options.
  const styleOverrides = form.style !== "";
  // A non-casual generation type overrides everything below it.
  const typeOverrides = form.generationType !== "casual";

  return (
    <Modal onClose={onClose}>
      <h2 className="generate-map-title">{t("maps.generate.title")}</h2>
      <form className="generate-map" onSubmit={submit}>
        <div className="generate-map-grid">
          <label className="field">
            <span>{t("maps.generate.mapSize")}</span>
            <select
              value={form.mapSize ?? 512}
              onChange={(e) => set("mapSize", Number(e.target.value))}
            >
              {MAP_SIZES.map((size) => (
                <option key={size.value} value={size.value}>
                  {size.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t("maps.generate.spawns")}</span>
            <input
              type="number"
              min={2}
              max={16}
              value={form.spawnCount ?? 6}
              onChange={(e) => set("spawnCount", Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>{t("maps.generate.teams")}</span>
            <input
              type="number"
              min={2}
              max={8}
              value={form.numTeams ?? 2}
              onChange={(e) => set("numTeams", Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>{t("maps.generate.count")}</span>
            <input
              type="number"
              min={1}
              max={10}
              value={form.numToGenerate ?? 1}
              onChange={(e) => set("numToGenerate", Number(e.target.value))}
            />
          </label>
        </div>

        <fieldset className="generate-map-types surface">
          <legend>{t("maps.generate.styleOfGame")}</legend>
          {recordEntries(GENERATION_TYPES).map(([value, generationType]) => (
            <label key={value} className="generate-map-type">
              <input
                type="radio"
                name="generation-type"
                checked={form.generationType === value}
                onChange={() => set("generationType", value)}
              />
              <span>
                <strong>{generationType.label}</strong>
                <small className="muted">{generationType.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <button
          type="button"
          className="generate-map-advanced-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
        >
          {t(advanced ? "maps.generate.fewerOptions" : "maps.generate.moreOptions")}
        </button>

        {advanced && (
          <div className="generate-map-advanced">
            {typeOverrides && (
              <p className="muted generate-map-note">
                “{GENERATION_TYPES[form.generationType].label}” sets the
                whole map: the options below are ignored while it is selected.
              </p>
            )}

            <div className="generate-map-grid">
              <label className="field">
                <span>{t("maps.generate.seed")}</span>
                <input
                  value={form.seed}
                  placeholder={t("maps.generate.random")}
                  onChange={(e) => set("seed", e.target.value)}
                />
              </label>

              <label className="field">
                <span>{t("maps.generate.symmetry")}</span>
                <select
                  value={form.symmetry}
                  disabled={!listsReady}
                  onChange={(e) => set("symmetry", e.target.value)}
                >
                  <option value="">{t("maps.generate.any")}</option>
                  {lists.symmetries.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>{t("maps.generate.mapStyle")}</span>
                <select
                  value={form.style}
                  disabled={!listsReady}
                  onChange={(e) => set("style", e.target.value)}
                >
                  <option value="">{t("maps.generate.any")}</option>
                  {lists.styles.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {styleOverrides && (
              <p className="muted generate-map-note">
                {t("maps.generate.mapStyleHint")}
              </p>
            )}

            <div className="generate-map-grid">
              {(
                [
                  [t("maps.generate.terrain"), "terrainStyle", lists.terrainStyles],
                  [t("maps.generate.texture"), "textureStyle", lists.textureStyles],
                  [t("maps.generate.resources"), "resourceStyle", lists.resourceStyles],
                  [t("maps.generate.props"), "propStyle", lists.propStyles],
                ] as const
              ).map(([label, key, values]) => (
                <label key={key} className="field">
                  <span>{label}</span>
                  <select
                    value={form[key]}
                    disabled={!listsReady || styleOverrides}
                    onChange={(e) => set(key, e.target.value)}
                  >
                    <option value="">{t("maps.generate.any")}</option>
                    {values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="generate-map-sliders">
              <DensitySlider
                label={t("maps.generate.reclaimDensity")}
                value={form.reclaimDensity}
                onChange={(value) => set("reclaimDensity", value)}
              />
              <DensitySlider
                label={t("maps.generate.resourceDensity")}
                value={form.resourceDensity}
                onChange={(value) => set("resourceDensity", value)}
              />
            </div>

            <label className="field">
              <span>{t("maps.generate.rawArguments")}</span>
              <input
                value={form.commandLineArgs}
                placeholder={t("maps.generate.overridesEveryOption")}
                onChange={(e) => set("commandLineArgs", e.target.value)}
              />
            </label>
          </div>
        )}

        <GeneratorProgress />

        <div className="generate-map-actions">
          <Button type="button" onClick={onClose}>
            {t("maps.generate.close")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              void setOptions(form);
            }}
          >
            {t("maps.generate.saveSettings")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t(busy ? "maps.generate.working" : "maps.generate.generate")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A single 0–127 density, in the generator's own units.
 *
 * `null` means "let the generator choose", which is not the same as 0: so the
 * control has an explicit Auto state rather than treating the low end as unset.
 */
function DensitySlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="density-slider">
      <div className="density-slider-head">
        <span>{label}</span>
        <span className="muted">{value === null ? t("maps.generate.auto") : value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={127}
        step={1}
        value={value ?? 0}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <button type="button" disabled={value === null} onClick={() => onChange(null)}>
        {t("maps.generate.auto")}
      </button>
    </div>
  );
}

/** The three slow stages, narrated. Generation routinely takes 30–120 seconds. */
export function GeneratorProgress() {
  const status = useAppStore((s) => s.state.mapGenerator.status);

  switch (status.type) {
    case "idle":
      return null;
    case "resolvingVersion":
      return <p className="muted generate-map-progress">Looking up the newest map generator…</p>;
    case "downloading": {
      const { downloadedBytes, totalBytes, version } = status.payload;
      const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
      return (
        <p className="muted generate-map-progress">
          Downloading map generator {version}
          {percent === null ? "…" : `: ${percent}%`}
        </p>
      );
    }
    case "generating":
      return (
        <p className="muted generate-map-progress">
          Generating with {status.payload.version}… {status.payload.detail}
        </p>
      );
    case "generated":
      return (
        <p className="generate-map-progress is-ok">
          Ready: {status.payload.maps.join(", ")}
        </p>
      );
    case "failed":
      return <p className="generate-map-progress is-error">{status.payload.reason}</p>;
  }
}
