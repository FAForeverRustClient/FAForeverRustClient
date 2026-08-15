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
const GENERATION_TYPES: Record<GenerationType, { label: string; hint: string }> = {
  casual: { label: "Casual", hint: "Honours every style option below." },
  tournament: { label: "Tournament", hint: "No preview until the game starts." },
  blind: { label: "Blind", hint: "No preview at all." },
  unexplored: { label: "Unexplored", hint: "The map starts under fog." },
};

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
        <h2 className="generate-map-title">Choose a map</h2>
        <p className="muted generate-map-note">
          {choices.length} maps were generated. They are all installed; pick the one to use now.
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
            Back to options
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="generate-map-title">Generate a map</h2>
      <form className="generate-map" onSubmit={submit}>
        <label className="field">
          <span>Reproduce a generated map</span>
          <input
            value={reproduceName}
            placeholder="neroxis_map_generator_1.7.7_..."
            aria-invalid={Boolean(reproduceError)}
            onChange={(e) => setReproduceName(e.target.value)}
          />
          {reproduceError ? (
            <small className="generate-map-error">{reproduceError}</small>
          ) : (
            <small className="muted">
              Paste a name to rebuild that exact map. Everything below is ignored while it is set.
            </small>
          )}
        </label>

        <fieldset className="generate-map-fieldset" disabled={reproducing}>
          <div className="generate-map-grid">
            <label className="field">
              <span>Generator version</span>
              <select
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
            </label>

            <label className="field">
              <span>Map size</span>
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
              <span>Spawns</span>
              <input
                type="number"
                min={2}
                max={16}
                value={form.spawnCount ?? 6}
                onChange={(e) => set("spawnCount", Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Teams</span>
              <input
                type="number"
                min={2}
                max={8}
                value={form.numTeams ?? 2}
                onChange={(e) => set("numTeams", Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>Maps to generate</span>
              <input
                type="number"
                min={1}
                max={10}
                disabled={seedPinsOneMap}
                value={seedPinsOneMap ? 1 : form.numToGenerate ?? 1}
                onChange={(e) => set("numToGenerate", Number(e.target.value))}
              />
              {seedPinsOneMap && <small className="muted">A fixed seed always makes one map.</small>}
            </label>
          </div>

          <fieldset className="generate-map-types surface">
            <legend>Style of game</legend>
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
            {advanced ? "Fewer options" : "More options"}
          </button>

          {advanced && (
            <div className="generate-map-advanced">
              {typeOverrides && (
                <p className="muted generate-map-note">
                  "{GENERATION_TYPES[form.generationType].label}" sets the
                  whole map: the options below are ignored while it is selected.
                </p>
              )}

              <div className="generate-map-grid">
                <label className="field">
                  <span>Seed</span>
                  <span className="generate-map-seed">
                    <input
                      value={form.seed}
                      placeholder="Random"
                      onChange={(e) => set("seed", e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label="Reroll seed"
                      title="Reroll seed"
                      onClick={() =>
                        set("seed", String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)))
                      }
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  </span>
                </label>

                <MultiSelect
                  label="Symmetries"
                  options={lists.symmetries.map((s) => ({ value: s, label: s }))}
                  selected={form.symmetries ?? []}
                  onChange={(symmetries) => set("symmetries", symmetries)}
                  anyLabel="Random (Any)"
                />

                <MultiSelect
                  label="Map styles"
                  options={lists.styles.map((s) => ({ value: s, label: s }))}
                  selected={form.styles ?? []}
                  onChange={(styles) => set("styles", styles)}
                  anyLabel="Random (Any)"
                />
              </div>

              {styleOverrides && (
                <p className="muted generate-map-note">
                  A map style replaces the individual terrain, texture, resource and prop styles.
                </p>
              )}

              <div className="generate-map-grid">
                <MultiSelect
                  label="Terrain styles"
                  options={lists.terrainStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.terrainStyles ?? []}
                  onChange={(terrainStyles) => set("terrainStyles", terrainStyles)}
                  anyLabel="Random (Any)"
                />
                <MultiSelect
                  label="Texture styles"
                  options={lists.textureStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.textureStyles ?? []}
                  onChange={(textureStyles) => set("textureStyles", textureStyles)}
                  anyLabel="Random (Any)"
                />
                <MultiSelect
                  label="Resource styles"
                  options={lists.resourceStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.resourceStyles ?? []}
                  onChange={(resourceStyles) => set("resourceStyles", resourceStyles)}
                  anyLabel="Random (Any)"
                />
                <MultiSelect
                  label="Prop styles"
                  options={lists.propStyles.map((s) => ({ value: s, label: s }))}
                  selected={form.propStyles ?? []}
                  onChange={(propStyles) => set("propStyles", propStyles)}
                  anyLabel="Random (Any)"
                />
              </div>

              <div className="generate-map-sliders">
                <RangeSlider
                  label="Reclaim density"
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
                  label="Resource density"
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

              <label className="field">
                <span>Raw generator arguments</span>
                <input
                  value={form.commandLineArgs}
                  placeholder="Overrides every option above"
                  onChange={(e) => set("commandLineArgs", e.target.value)}
                />
              </label>
            </div>
          )}
        </fieldset>

        <GeneratorProgress />

        <div className="generate-map-actions">
          <Button type="button" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            disabled={reproducing}
            onClick={() => {
              void setOptions(form);
            }}
          >
            Save settings
          </Button>
          <Button type="submit" variant="primary" disabled={busy || Boolean(reproduceError)}>
            {busy ? "Working..." : reproducing ? "Reproduce" : "Generate"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The three slow stages, narrated. Generation routinely takes 30-120 seconds. */
export function GeneratorProgress() {
  const status = useAppStore((s) => s.state.mapGenerator.status);

  switch (status.type) {
    case "idle":
      return null;
    case "resolvingVersion":
      return <p className="muted generate-map-progress">Looking up the newest map generator...</p>;
    case "downloading": {
      const { downloadedBytes, totalBytes, version } = status.payload;
      const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
      return (
        <p className="muted generate-map-progress">
          Downloading map generator {version}
          {percent === null ? "..." : `: ${percent}%`}
        </p>
      );
    }
    case "generating":
      return (
        <p className="muted generate-map-progress">
          Generating with {status.payload.version}... {status.payload.detail}
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
