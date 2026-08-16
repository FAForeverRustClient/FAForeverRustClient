// Generate a Neroxis map.
//
// FAF matchmaker maps are not files, they are recipes: a name encodes the
// generator version, seed and options, and every client rebuilds identical
// terrain. This dialog drives both directions: choosing options to produce a
// fresh map, and rebuilding one from a name.
//
// Laid out one option per row rather than in a grid. There are twenty of them,
// and a grid makes the eye hunt for each label; a single column of
// label-then-control reads straight down.
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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  GenerationType,
  GeneratorOptions,
  GeneratorStatus,
  MapGeneratorCommand,
} from "../../ipc/bindings";
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
import {
  DENSITY_BINS,
  MAP_SIZES,
  MAX_MAPS_PER_RUN,
  TEAM_COUNTS,
  canGenerate,
  densityPercent,
  describeIssue,
  formatMapSize,
  isFatal,
  issueKey,
  nearestLegalSpawnCount,
  outcomeOfRun,
  spawnCountsFor,
  summariseDecodedName,
} from "./generatorPresentation";
import "./generate-map.css";

/** Labels from the Java client's `game.generateMap.*` strings. */
const GENERATION_TYPES = {
  casual: { label: "maps.generate.kind.casual", hint: "maps.generate.kind.casualHint" },
  tournament: { label: "maps.generate.kind.tournament", hint: "maps.generate.kind.tournamentHint" },
  blind: { label: "maps.generate.kind.blind", hint: "maps.generate.kind.blindHint" },
  unexplored: { label: "maps.generate.kind.unexplored", hint: "maps.generate.kind.unexploredHint" },
} as const satisfies Record<GenerationType, { label: MessageKey; hint: MessageKey }>;

const send = (command: MapGeneratorCommand) => ipc.send({ kind: "MapGenerator", command });

const generate = (options: GeneratorOptions) => send({ type: "generate", payload: { options } });
const generateNamed = (mapName: string) => send({ type: "generateNamed", payload: { mapName } });
const loadOptions = (version?: string | null) =>
  send({ type: "loadOptions", payload: { version: version ?? null } });
const setOptions = (options: GeneratorOptions) =>
  send({ type: "setOptions", payload: { options } });
const savePreset = (name: string, options: GeneratorOptions) =>
  send({ type: "savePreset", payload: { name, options } });
const loadPresets = () => send({ type: "loadPresets" });
const deletePreset = (name: string) => send({ type: "deletePreset", payload: { name } });
const validate = (options: GeneratorOptions) => send({ type: "validate", payload: { options } });
const preflight = (options: GeneratorOptions) => send({ type: "preflight", payload: { options } });
const decodeNames = (mapNames: string[]) => send({ type: "decodeNames", payload: { mapNames } });
const loadHelp = (version?: string | null) =>
  send({ type: "loadHelp", payload: { version: version ?? null } });
const cancel = () => send({ type: "cancel" });

/** One labelled option. The label column is fixed so every control lines up. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="generate-map-row">
      <span className="generate-map-row-label">{label}</span>
      <div className="generate-map-row-control">
        {children}
        {hint && <small className="generate-map-row-hint">{hint}</small>}
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="generate-map-select-wrap">
      <select
        className="generate-map-control generate-map-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <Icon name="chevronDown" size={13} className="generate-map-select-arrow" />
    </div>
  );
}

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
  const [showHelp, setShowHelp] = useState(false);
  const [saved, setSaved] = useState(false);
  const [presetName, setPresetName] = useState("");

  // The option lists come from the generator itself, so they need a round trip
  // (and possibly a JAR download) before the pickers mean anything.
  useEffect(() => {
    if (useAppStore.getState().state.mapGenerator.optionLists.styles.length === 0) {
      void loadOptions();
    }
    void loadPresets();
  }, []);

  // Show every run's result, and only our own run's result.
  //
  // The status is sticky: it keeps reporting the last run's maps until
  // something replaces it, so "status is generated" is not the same question as
  // "my run finished". Remembering what was on screen when the run was asked
  // for is what separates the two; see `outcomeOfRun`.
  const awaitingSince = useRef<GeneratorStatus | null>(null);
  const [results, setResults] = useState<string[] | null>(null);
  useEffect(() => {
    const outcome = outcomeOfRun(state.status, awaitingSince.current);
    if (outcome.kind === "waiting") return;
    awaitingSince.current = null;
    if (outcome.kind !== "generated") return;
    setResults(outcome.maps);
    // Each name carries its own parameters, so the overview can describe every
    // map it lists without another generator run.
    if (outcome.maps.length > 0) void decodeNames(outcome.maps);
  }, [state.status]);

  const beginRun = (start: () => void) => {
    awaitingSince.current = state.status;
    setResults(null);
    start();
  };

  /** Hand one map back to whoever opened the dialog, e.g. to host it. */
  const pick = (map: string) => {
    setResults(null);
    onGenerated?.([map]);
  };

  const set = <K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const busy = state.status.type !== "idle" && stillRunning(state.status);

  // A full map name is a complete recipe, so it overrides every option here.
  // It lives beside the seed because that is what people call it, but it means
  // something much stronger, hence the banner.
  const [reproduceName, setReproduceName] = useState("");
  const trimmedName = reproduceName.trim();
  const reproducing = trimmedName !== "";
  const reproduceValid = reproducing && isGeneratedMap(trimmedName);

  // Decoding is pure arithmetic in the backend, so asking on every settled
  // keystroke is cheap. It turns an opaque name into "10 km, 6 spawns, …".
  useEffect(() => {
    if (!reproduceValid) return;
    const timer = setTimeout(() => void decodeNames([trimmedName]), 200);
    return () => clearTimeout(timer);
  }, [reproduceValid, trimmedName]);
  const decoded = state.decoded?.[trimmedName];

  // Re-check the options as they are edited. Pure and instant on the other
  // side; the authoritative check happens with `--parse` on generate.
  useEffect(() => {
    if (reproducing) return;
    const timer = setTimeout(() => void validate(form), 250);
    return () => clearTimeout(timer);
  }, [form, reproducing]);

  const issues = reproducing ? [] : (state.validation ?? []);
  const blocking = issues.filter(isFatal);
  const advisory = issues.filter((issue) => !isFatal(issue));
  const submittable = canGenerate(form, issues);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (reproducing) {
      if (!reproduceValid) return;
      beginRun(() => void generateNamed(trimmedName));
      return;
    }
    if (!submittable) return;
    beginRun(() => void generate(form));
  };

  const presets = state.presets ?? [];
  const trimmedPreset = presetName.trim();
  // Matching is case-insensitive because the file name is: saving "ladder"
  // over "Ladder" replaces it rather than making a second entry.
  const existing = presets.find(
    (preset) => preset.name.toLowerCase() === trimmedPreset.toLowerCase(),
  );
  const presetNameUsable = trimmedPreset !== "" && /^[\w\- ]+$/.test(trimmedPreset);

  const save = () => {
    if (!presetNameUsable) return;
    void savePreset(trimmedPreset, form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const applyPreset = (name: string) => {
    const preset = presets.find((entry) => entry.name === name);
    if (!preset) return;
    setForm(preset.options);
    setPresetName(preset.name);
  };

  const seedPinsOneMap = form.seed.trim() !== "";
  const teams = form.numTeams ?? 2;
  const spawnOptions = useMemo(() => spawnCountsFor(teams), [teams]);

  // Changing the team count can strand the spawn count on an illegal value, so
  // it moves with it. The Java client does the same by refiltering its spinner.
  const changeTeams = (numTeams: number) =>
    setForm((f) => ({
      ...f,
      numTeams,
      spawnCount: nearestLegalSpawnCount(f.spawnCount ?? 6, numTeams),
    }));

  const lists = state.optionLists;
  const availableVersions = state.availableVersions ?? [];
  const previews = state.previews ?? {};
  const styleOverrides = (form.styles?.length ?? 0) > 0 || Boolean(form.style);
  const typeOverrides = form.generationType !== "casual";
  const rawOverrides = form.commandLineArgs.trim() !== "";

  // Every finished run gets this overview, one map or twenty. It is the only
  // place the maps are named, previewed and described, and skipping it for a
  // single map left the commonest case with nothing to show at all.
  if (results !== null) {
    const pickable = Boolean(onGenerated);
    return (
      <Modal onClose={onClose} className="generate-map-modal">
        <div className="generate-map-head">
          <h2 className="generate-map-title">
            {pickable ? t("maps.generate.chooseMap") : t("maps.generate.resultTitle")}
          </h2>
          <p className="generate-map-subtitle">
            {results.length === 0
              ? t("maps.generate.resultNone")
              : pickable
                ? t("maps.generate.choicesNote", { count: results.length })
                : t("maps.generate.resultNote", { count: results.length })}
          </p>
        </div>
        <div className="generate-map-choices-grid">
          {results.map((map) => {
            const previewUrl = previews[map];
            const facts = state.decoded?.[map];
            const body = (
              <>
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
                  {facts && (
                    <span className="generate-map-card-facts">
                      {summariseDecodedName(facts).join(" · ")}
                    </span>
                  )}
                </div>
              </>
            );
            // Only a caller that can accept a map gets a clickable card;
            // elsewhere a button that does nothing would just be a lie.
            return pickable ? (
              <button key={map} type="button" className="generate-map-card" onClick={() => pick(map)}>
                {body}
              </button>
            ) : (
              <div key={map} className="generate-map-card is-static">
                {body}
              </div>
            );
          })}
        </div>
        <div className="generate-map-actions">
          <Button type="button" onClick={() => setResults(null)}>
            {t("maps.generate.backToOptions")}
          </Button>
          <Button type="button" variant="primary" onClick={onClose}>
            {t("maps.generate.done")}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} className="generate-map-modal">
      <div className="generate-map-head">
        <h2 className="generate-map-title">{t("maps.generate.title")}</h2>
        <p className="generate-map-subtitle">{t("maps.generate.subtitle")}</p>
      </div>

      <form className="generate-map" onSubmit={submit}>
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
                {summariseDecodedName(decoded).map((fact) => (
                  <li key={fact} className="generate-map-fact">
                    {fact}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <fieldset className="generate-map-fieldset" disabled={reproducing}>
          <div className="generate-map-rows">
            <Row label={t("maps.generate.generatorVersion")}>
              <Select
                value={form.version ?? ""}
                onChange={(value) => {
                  const version = value || null;
                  set("version", version);
                  void loadOptions(version);
                }}
              >
                <option value="">
                  {t("maps.generate.latestVersion", {
                    version: state.latestVersion || t("maps.generate.auto"),
                  })}
                </option>
                {availableVersions
                  .filter((v) => v !== state.latestVersion)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
              </Select>
            </Row>

            <Row label={t("maps.generate.mapSize")}>
              <Select value={form.mapSize ?? 512} onChange={(v) => set("mapSize", Number(v))}>
                {MAP_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {formatMapSize(size)}
                  </option>
                ))}
              </Select>
            </Row>

            <Row label={t("maps.generate.teams")}>
              <Select value={teams} onChange={(v) => changeTeams(Number(v))}>
                {TEAM_COUNTS.map((count) => (
                  <option key={count} value={count}>
                    {count === 0 ? t("maps.generate.asymmetric") : count}
                  </option>
                ))}
              </Select>
            </Row>

            <Row
              label={t("maps.generate.spawns")}
              hint={teams > 0 ? t("maps.generate.spawnsMultipleHint", { teams }) : undefined}
            >
              <Select value={form.spawnCount ?? 6} onChange={(v) => set("spawnCount", Number(v))}>
                {spawnOptions.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </Select>
            </Row>

            <Row
              label={t("maps.generate.count")}
              hint={seedPinsOneMap ? t("maps.generate.seedPinsOneMap") : undefined}
            >
              <input
                type="number"
                className="generate-map-control"
                min={1}
                max={MAX_MAPS_PER_RUN}
                disabled={seedPinsOneMap}
                value={seedPinsOneMap ? 1 : (form.numToGenerate ?? 1)}
                onChange={(e) => set("numToGenerate", Number(e.target.value))}
              />
            </Row>

            <Row
              label={t("maps.generate.styleOfGame")}
              hint={t(GENERATION_TYPES[form.generationType].hint)}
            >
              <Select
                value={form.generationType}
                onChange={(v) => set("generationType", v as GenerationType)}
              >
                {recordEntries(GENERATION_TYPES).map(([value, kind]) => (
                  <option key={value} value={value}>
                    {t(kind.label)}
                  </option>
                ))}
              </Select>
            </Row>
          </div>

          {(blocking.length > 0 || advisory.length > 0) && !rawOverrides && (
            <div className="generate-map-issues">
              {blocking.map((issue) => (
                <p key={issueKey(issue)} className="generate-map-issue is-blocking">
                  <span>{describeIssue(issue, t)}</span>
                </p>
              ))}
              {advisory.map((issue) => (
                <p key={issueKey(issue)} className="generate-map-issue is-advisory">
                  <span>{describeIssue(issue, t)}</span>
                </p>
              ))}
            </div>
          )}
        </fieldset>

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
            <fieldset className="generate-map-fieldset" disabled={reproducing}>
              {typeOverrides && (
                <p className="generate-map-note">
                  {t("maps.generate.typeOverridesNote", {
                    type: t(GENERATION_TYPES[form.generationType].label),
                  })}
                </p>
              )}

              <div className="generate-map-rows">
                <Row label={t("maps.generate.symmetries")}>
                  <MultiSelect
                    label={t("maps.generate.symmetries")}
                    options={lists.symmetries.map((s) => ({ value: s, label: s }))}
                    selected={form.symmetries ?? []}
                    onChange={(symmetries) => set("symmetries", symmetries)}
                    anyLabel={t("maps.generate.randomAny")}
                  />
                </Row>

                <Row
                  label={t("maps.generate.mapStyles")}
                  hint={styleOverrides ? t("maps.generate.mapStyleHint") : undefined}
                >
                  <MultiSelect
                    label={t("maps.generate.mapStyles")}
                    options={lists.styles.map((s) => ({ value: s, label: s }))}
                    selected={form.styles ?? []}
                    onChange={(styles) => set("styles", styles)}
                    anyLabel={t("maps.generate.randomAny")}
                  />
                </Row>

                <Row label={t("maps.generate.terrainStyles")}>
                  <MultiSelect
                    label={t("maps.generate.terrainStyles")}
                    options={lists.terrainStyles.map((s) => ({ value: s, label: s }))}
                    selected={form.terrainStyles ?? []}
                    onChange={(terrainStyles) => set("terrainStyles", terrainStyles)}
                    anyLabel={t("maps.generate.randomAny")}
                  />
                </Row>

                <Row label={t("maps.generate.textureStyles")}>
                  <MultiSelect
                    label={t("maps.generate.textureStyles")}
                    options={lists.textureStyles.map((s) => ({ value: s, label: s }))}
                    selected={form.textureStyles ?? []}
                    onChange={(textureStyles) => set("textureStyles", textureStyles)}
                    anyLabel={t("maps.generate.randomAny")}
                  />
                </Row>

                <Row label={t("maps.generate.resourceStyles")}>
                  <MultiSelect
                    label={t("maps.generate.resourceStyles")}
                    options={lists.resourceStyles.map((s) => ({ value: s, label: s }))}
                    selected={form.resourceStyles ?? []}
                    onChange={(resourceStyles) => set("resourceStyles", resourceStyles)}
                    anyLabel={t("maps.generate.randomAny")}
                  />
                </Row>

                <Row label={t("maps.generate.propStyles")}>
                  <MultiSelect
                    label={t("maps.generate.propStyles")}
                    options={lists.propStyles.map((s) => ({ value: s, label: s }))}
                    selected={form.propStyles ?? []}
                    onChange={(propStyles) => set("propStyles", propStyles)}
                    anyLabel={t("maps.generate.randomAny")}
                  />
                </Row>

                <Row
                  label={t("maps.generate.reclaimDensity")}
                  hint={`${densityPercent(form.reclaimDensityMin ?? 0)}–${densityPercent(
                    form.reclaimDensityMax ?? DENSITY_BINS,
                  )}%`}
                >
                  <RangeSlider
                    label={t("maps.generate.reclaimDensity")}
                    min={0}
                    max={DENSITY_BINS}
                    low={form.reclaimDensityMin ?? null}
                    high={form.reclaimDensityMax ?? null}
                    onChange={(low, high) => {
                      set("reclaimDensityMin", low);
                      set("reclaimDensityMax", high);
                    }}
                  />
                </Row>

                <Row
                  label={t("maps.generate.resourceDensity")}
                  hint={`${densityPercent(form.resourceDensityMin ?? 0)}–${densityPercent(
                    form.resourceDensityMax ?? DENSITY_BINS,
                  )}%`}
                >
                  <RangeSlider
                    label={t("maps.generate.resourceDensity")}
                    min={0}
                    max={DENSITY_BINS}
                    low={form.resourceDensityMin ?? null}
                    high={form.resourceDensityMax ?? null}
                    onChange={(low, high) => {
                      set("resourceDensityMin", low);
                      set("resourceDensityMax", high);
                    }}
                  />
                </Row>
              </div>
            </fieldset>

            {/* The seed row is outside the fieldset: its second field is the
                one control that must stay usable while a map name is set,
                because it is what sets it. */}
            <div className="generate-map-rows">
              <Row label={t("maps.generate.seed")} hint={t("maps.generate.seedHint")}>
                <div className="generate-map-seed-row">
                  <input
                    className="generate-map-control"
                    value={form.seed}
                    disabled={reproducing}
                    placeholder={t("maps.generate.random")}
                    aria-label={t("maps.generate.seed")}
                    onChange={(e) => set("seed", e.target.value.replace(/[^\d-]/g, ""))}
                  />
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
            </div>

            <fieldset className="generate-map-fieldset" disabled={reproducing}>
              <div className="generate-map-rows">
                <Row label={t("maps.generate.outputPath")}>
                  <div className="generate-map-trio">
                    <input
                      className="generate-map-control"
                      value={form.outputPath}
                      aria-label={t("maps.generate.outputPath")}
                      placeholder={t("maps.generate.outputPathHint")}
                      onChange={(e) => set("outputPath", e.target.value)}
                    />
                    <input
                      className="generate-map-control"
                      value={form.commandLineArgs}
                      aria-label={t("maps.generate.rawArguments")}
                      placeholder={t("maps.generate.rawArguments")}
                      onChange={(e) => set("commandLineArgs", e.target.value)}
                    />
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

                <Row label={t("maps.generate.diagnostics")}>
                  <div className="generate-map-trio">
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
                    <Button type="button" onClick={() => void preflight(form)} disabled={busy}>
                      {t("maps.generate.checkOptions")}
                    </Button>
                  </div>
                </Row>
              </div>
            </fieldset>

            {showHelp && (
              <pre className="generate-map-help">
                {state.helpText || t("maps.generate.loadingHelp")}
              </pre>
            )}
          </div>
        )}

        {state.predictedName && !reproducing && (
          <p className="generate-map-predicted">
            <span className="generate-map-row-label">{t("maps.generate.willBeCalled")}</span>
            <code>{state.predictedName}</code>
          </p>
        )}

        <div className="generate-map-rows generate-map-presets">
          <Row label={t("maps.generate.presets")} hint={t("maps.generate.presetsHint")}>
            <div className="generate-map-trio">
              <Select value="" onChange={applyPreset}>
                <option value="">
                  {presets.length === 0
                    ? t("maps.generate.presetsEmpty")
                    : t("maps.generate.presetsLoad")}
                </option>
                {presets.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </Select>
              <input
                className="generate-map-control"
                value={presetName}
                maxLength={80}
                aria-label={t("maps.generate.presetName")}
                placeholder={t("maps.generate.presetName")}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <div className="generate-map-preset-actions">
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

        <GeneratorProgress />

        <div className="generate-map-actions">
          <Button type="button" onClick={onClose}>
            {t("maps.generate.close")}
          </Button>
          <Button type="button" disabled={reproducing} onClick={() => void setOptions(form)}>
            {t("maps.generate.rememberOptions")}
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
    </Modal>
  );
}

/** Whether a run is in flight. Mirrors `GeneratorStatus::is_busy` in faf-domain. */
function stillRunning(status: GeneratorStatus): boolean {
  return (
    status.type === "preparing" ||
    status.type === "resolvingVersion" ||
    status.type === "downloading" ||
    status.type === "generating"
  );
}

/** The slow stages, narrated. Generation routinely takes 30-120 seconds. */
export function GeneratorProgress() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.state.mapGenerator.status);

  switch (status.type) {
    case "idle":
      return null;
    case "preparing":
      // The `--parse` preflight costs a JVM start; without this the dialog
      // sits silent for a second or two after the button is pressed.
      return <p className="muted generate-map-progress">{t("maps.generate.preparing")}</p>;
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
          {t("maps.generate.generatingWith", {
            version: status.payload.version,
            detail: status.payload.detail,
          })}
        </p>
      );
    case "generated":
      return (
        <p className="generate-map-progress is-ok">
          {t("maps.generate.ready", { maps: status.payload.maps.join(", ") })}
        </p>
      );
    case "cancelled":
      return <p className="muted generate-map-progress">{t("maps.generate.cancelled")}</p>;
    case "failed":
      return <p className="generate-map-progress is-error">{status.payload.reason}</p>;
  }
}
