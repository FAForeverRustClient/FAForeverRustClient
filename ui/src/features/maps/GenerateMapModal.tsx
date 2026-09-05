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
import { Select, type SelectOption } from "../../design-system/Select";
import { ipc } from "../../ipc/client";
import { GENERATED_MAP_PLACEHOLDER_URL, isGeneratedMap } from "../../shared/mapPresentation";
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
import { NumberInput } from "../../design-system/NumberInput";

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
function Row({
  label,
  hint,
  superseded = false,
  children,
}: {
  label: string;
  hint?: string;
  /** Dim the row: something else is deciding this value (see the style rows). */
  superseded?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={superseded ? "generate-map-row is-superseded" : "generate-map-row"}>
      <span className="generate-map-row-label">{label}</span>
      <div className="generate-map-row-control">
        {children}
        {hint && <small className="generate-map-row-hint">{hint}</small>}
      </div>
    </div>
  );
}

function GeneratePreviewImg({
  url,
  alt,
  className,
}: {
  url: string | undefined;
  alt: string;
  className: string;
  placeholderClassName?: string;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  return (
    <img
      src={!url || failed ? GENERATED_MAP_PLACEHOLDER_URL : url}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (!failed) setFailed(true);
      }}
    />
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
  const [showHelp, setShowHelp] = useState(false);
  const [saved, setSaved] = useState(false);
  const [presetName, setPresetName] = useState("");

  // Load generator versions, options, and presets on dialog open.
  useEffect(() => {
    void loadOptions();
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
    onClose();
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

  const handleDeleteMap = (mapName: string) => {
    ipc.send({ kind: "Maps", command: { type: "uninstallMap", payload: { folderName: mapName } } });
    if (results) {
      const nextResults = results.filter((m) => m !== mapName);
      if (nextResults.length === 0) {
        setResults(null);
        setSelectedMapIndex(0);
      } else {
        setResults(nextResults);
        setSelectedMapIndex((prev) => Math.min(prev, nextResults.length - 1));
      }
    }
  };

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

  const presets = useMemo(() => state.presets ?? [], [state.presets]);
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

  const availableVersions = useMemo(() => state.availableVersions ?? [], [state.availableVersions]);
  const versionOptions: SelectOption<string>[] = useMemo(
    () => [
      {
        value: "",
        label: t("maps.generate.latestVersion", {
          version: state.latestVersion || availableVersions[0] || t("maps.generate.auto"),
        }),
      },
      ...availableVersions.map((v) => ({ value: v, label: v })),
    ],
    [availableVersions, state.latestVersion, t],
  );

  const mapSizeOptions: SelectOption<number>[] = useMemo(
    () =>
      MAP_SIZES.map((size) => ({
        value: size,
        label: formatMapSize(size),
      })),
    [],
  );

  const teamOptions: SelectOption<number>[] = useMemo(
    () =>
      TEAM_COUNTS.map((count) => ({
        value: count,
        label: count === 0 ? t("maps.generate.asymmetric") : String(count),
      })),
    [t],
  );

  const spawnSelectOptions: SelectOption<number>[] = useMemo(
    () =>
      spawnOptions.map((count) => ({
        value: count,
        label: String(count),
      })),
    [spawnOptions],
  );

  const generationTypeOptions: SelectOption<GenerationType>[] = useMemo(
    () =>
      recordEntries(GENERATION_TYPES).map(([value, kind]) => ({
        value,
        label: t(kind.label),
      })),
    [t],
  );

  const presetOptions: SelectOption<string>[] = useMemo(
    () => [
      {
        value: "",
        label: presets.length === 0 ? t("maps.generate.presetsEmpty") : t("maps.generate.presetsLoad"),
        disabled: true,
      },
      ...presets.map((preset) => ({
        value: preset.name,
        label: preset.name,
      })),
    ],
    [presets, t],
  );

  const lists = state.optionLists;
  const previews = state.previews ?? {};
  const styleOverrides = (form.styles?.length ?? 0) > 0 || Boolean(form.style);
  const typeOverrides = form.generationType !== "casual";
  const rawOverrides = form.commandLineArgs.trim() !== "";

  const [selectedMapIndex, setSelectedMapIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const copyCurrentName = (name: string) => {
    void navigator.clipboard.writeText(name);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const currentMap = results && results.length > 0 ? results[selectedMapIndex] ?? results[0] : null;
  const currentPreviewUrl = currentMap ? previews[currentMap] : undefined;
  const currentFacts = currentMap ? state.decoded?.[currentMap] : undefined;
  const pickable = Boolean(onGenerated);

  return (
    // While the preview is zoomed, Escape and a backdrop click belong to the
    // zoom. The dialog owns the only close handler the modal has, so it hands
    // that handler over rather than racing a second Escape listener with it.
    <Modal onClose={zoomed ? () => setZoomed(false) : onClose} className="generate-map-modal">
      <div className="generate-map-head">
        <h2 className="generate-map-title">{t("maps.generate.title")}</h2>
        <p className="generate-map-subtitle">{t("maps.generate.subtitle")}</p>
      </div>

      <div className="generate-map-unified-layout">
        {/* Left Column: Generator Form & Controls */}
        <div className="generate-map-form-pane">
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
              <div className="generate-map-grid-2col">
                <Row label={t("maps.generate.generatorVersion")}>
                  <Select
                    value={form.version ?? ""}
                    options={versionOptions}
                    onChange={(value) => {
                      const version = value || null;
                      set("version", version);
                      void loadOptions(version);
                    }}
                  />
                </Row>

                <Row label={t("maps.generate.mapSize")}>
                  <Select
                    value={form.mapSize ?? 512}
                    options={mapSizeOptions}
                    onChange={(v) => set("mapSize", Number(v))}
                  />
                </Row>

                <Row label={t("maps.generate.teams")}>
                  <Select
                    value={teams}
                    options={teamOptions}
                    onChange={(v) => changeTeams(Number(v))}
                  />
                </Row>

                <Row
                  label={t("maps.generate.spawns")}
                  hint={teams > 0 ? t("maps.generate.spawnsMultipleHint", { teams }) : undefined}
                >
                  <Select
                    value={form.spawnCount ?? 6}
                    options={spawnSelectOptions}
                    onChange={(v) => set("spawnCount", Number(v))}
                  />
                </Row>

                <Row
                  label={t("maps.generate.count")}
                  hint={seedPinsOneMap ? t("maps.generate.seedPinsOneMap") : undefined}
                >
                  <NumberInput
                    className="generate-map-control"
                    min={1}
                    max={MAX_MAPS_PER_RUN}
                    disabled={seedPinsOneMap}
                    value={seedPinsOneMap ? 1 : (form.numToGenerate ?? 1)}
                    onChange={(count) => set("numToGenerate", count)}
                  />
                </Row>

                <Row
                  label={t("maps.generate.styleOfGame")}
                  hint={t(GENERATION_TYPES[form.generationType].hint)}
                >
                  <Select
                    value={form.generationType}
                    options={generationTypeOptions}
                    onChange={(v) => set("generationType", v)}
                  />
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

            <hr className="generate-map-divider" />

            <fieldset className="generate-map-fieldset" disabled={reproducing}>
              {typeOverrides && (
                <p className="generate-map-note">
                  {t("maps.generate.typeOverridesNote", {
                    type: t(GENERATION_TYPES[form.generationType].label),
                  })}
                </p>
              )}

                  <div className="generate-map-grid-2col">
                    <Row label={t("maps.generate.symmetries")}>
                      <MultiSelect
                        label={t("maps.generate.symmetries")}
                        options={lists.symmetries.map((s) => ({ value: s, label: s }))}
                        selected={form.symmetries ?? []}
                        onChange={(symmetries) => set("symmetries", symmetries)}
                        anyLabel={t("maps.generate.randomAny")}
                      />
                    </Row>

                    {/* The four rows below pick one generator each; a map
                        style picks all four at once and the generator ignores
                        the individual flags when it is set (see
                        `protocol::map_generator`). The explanation is always
                        on, because "how do these differ" is the question the
                        two overlapping lists actually raise. */}
                    <Row
                      label={t("maps.generate.mapStyles")}
                      hint={t("maps.generate.mapStyleHint")}
                    >
                      <MultiSelect
                        label={t("maps.generate.mapStyles")}
                        options={lists.styles.map((s) => ({ value: s, label: s }))}
                        selected={form.styles ?? []}
                        onChange={(styles) => set("styles", styles)}
                        anyLabel={t("maps.generate.randomAny")}
                      />
                    </Row>

                    <Row
                      label={t("maps.generate.terrainStyles")}
                      superseded={styleOverrides}
                      hint={styleOverrides ? t("maps.generate.styleSuperseded") : undefined}
                    >
                      <MultiSelect
                        label={t("maps.generate.terrainStyles")}
                        options={lists.terrainStyles.map((s) => ({ value: s, label: s }))}
                        selected={form.terrainStyles ?? []}
                        onChange={(terrainStyles) => set("terrainStyles", terrainStyles)}
                        anyLabel={t("maps.generate.randomAny")}
                      />
                    </Row>

                    <Row
                      label={t("maps.generate.textureStyles")}
                      superseded={styleOverrides}
                      hint={styleOverrides ? t("maps.generate.styleSuperseded") : undefined}
                    >
                      <MultiSelect
                        label={t("maps.generate.textureStyles")}
                        options={lists.textureStyles.map((s) => ({ value: s, label: s }))}
                        selected={form.textureStyles ?? []}
                        onChange={(textureStyles) => set("textureStyles", textureStyles)}
                        anyLabel={t("maps.generate.randomAny")}
                      />
                    </Row>

                    <Row
                      label={t("maps.generate.resourceStyles")}
                      superseded={styleOverrides}
                      hint={styleOverrides ? t("maps.generate.styleSuperseded") : undefined}
                    >
                      <MultiSelect
                        label={t("maps.generate.resourceStyles")}
                        options={lists.resourceStyles.map((s) => ({ value: s, label: s }))}
                        selected={form.resourceStyles ?? []}
                        onChange={(resourceStyles) => set("resourceStyles", resourceStyles)}
                        anyLabel={t("maps.generate.randomAny")}
                      />
                    </Row>

                    <Row
                      label={t("maps.generate.propStyles")}
                      superseded={styleOverrides}
                      hint={styleOverrides ? t("maps.generate.styleSuperseded") : undefined}
                    >
                      <MultiSelect
                        label={t("maps.generate.propStyles")}
                        options={lists.propStyles.map((s) => ({ value: s, label: s }))}
                        selected={form.propStyles ?? []}
                        onChange={(propStyles) => set("propStyles", propStyles)}
                        anyLabel={t("maps.generate.randomAny")}
                      />
                    </Row>

                    <Row label={t("maps.generate.reclaimDensity")}>
                      <RangeSlider
                        label={t("maps.generate.reclaimDensity")}
                        min={0}
                        max={DENSITY_BINS}
                        low={form.reclaimDensityMin ?? null}
                        high={form.reclaimDensityMax ?? null}
                        format={(v) => `${densityPercent(v)}%`}
                        onChange={(low, high) => {
                          set("reclaimDensityMin", low);
                          set("reclaimDensityMax", high);
                        }}
                      />
                    </Row>

                    <Row label={t("maps.generate.resourceDensity")}>
                      <RangeSlider
                        label={t("maps.generate.resourceDensity")}
                        min={0}
                        max={DENSITY_BINS}
                        low={form.resourceDensityMin ?? null}
                        high={form.resourceDensityMax ?? null}
                        format={(v) => `${densityPercent(v)}%`}
                        onChange={(low, high) => {
                          set("resourceDensityMin", low);
                          set("resourceDensityMax", high);
                        }}
                      />
                    </Row>
                  </div>

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

                    <Row label={t("maps.generate.reproduceTitle")}>
                      <input
                        className="generate-map-control"
                        value={reproduceName}
                        aria-invalid={reproducing && !reproduceValid}
                        aria-label={t("maps.generate.mapNameSeed")}
                        placeholder={t("maps.generate.mapNameSeedPlaceholder")}
                        onChange={(e) => setReproduceName(e.target.value)}
                      />
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

                  <div className="generate-map-grid-2col">
                    <Row label={t("maps.generate.presets")}>
                      <Select
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

                    <Row label={t("maps.generate.presetName")}>
                      <div className="generate-map-preset-save-group">
                        <input
                          className="generate-map-control"
                          value={presetName}
                          maxLength={80}
                          aria-label={t("maps.generate.presetName")}
                          placeholder={t("maps.generate.presetName")}
                          onChange={(e) => setPresetName(e.target.value)}
                        />
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

                {showHelp && (
                  <pre className="generate-map-help">
                    {state.helpText || t("maps.generate.loadingHelp")}
                  </pre>
                )}

            {/* Deliberately here rather than among the generator flags: this
                one never reaches the generator. It decides what happens to the
                maps this run produces once they exist, so it belongs where the
                run is started and has to be visible without opening the
                advanced options. */}
            <label className="generate-map-check generate-map-keep">
              <input
                type="checkbox"
                checked={form.keepMaps}
                onChange={(e) => set("keepMaps", e.target.checked)}
              />
              <span title={t("maps.generate.keepMapsHint")}>{t("maps.generate.keepMaps")}</span>
            </label>

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
        </div>

        {/* Right Column: Live Map Preview & Generation Output */}
        <div className="generate-map-preview-pane">

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
                    {t("maps.generate.reproduceTitle") || "Map name"}
                  </span>
                  <code className="generate-map-name-code" title={currentMap}>
                    {currentMap}
                  </code>
                </div>
                <Button onClick={() => copyCurrentName(currentMap)} title={t("maps.generate.copyName")}>
                  <Icon name={copied ? "check" : "copy"} size={14} />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>

              <dl className="generate-map-specs-grid">
                <div>
                  <dt>{t("maps.generate.mapSize")}</dt>
                  <dd>{currentFacts ? formatMapSize(currentFacts.mapSize) : "N/A"}</dd>
                </div>
                <div>
                  <dt>{t("maps.generate.spawns")}</dt>
                  <dd>{currentFacts ? `${currentFacts.spawnCount} players` : "N/A"}</dd>
                </div>
                <div>
                  <dt>{t("maps.generate.teams")}</dt>
                  <dd>
                    {currentFacts
                      ? currentFacts.numTeams === 0
                        ? "Asymmetric"
                        : `${currentFacts.numTeams} teams`
                      : "N/A"}
                  </dd>
                </div>
                <div>
                  <dt>{t("maps.generate.symmetry")}</dt>
                  <dd>{currentFacts?.symmetry || t("maps.generate.any")}</dd>
                </div>
                <div>
                  <dt>{t("maps.generate.generatorVersion")}</dt>
                  <dd>{currentFacts ? `v${currentFacts.version}` : "N/A"}</dd>
                </div>
                <div>
                  <dt>{t("maps.generate.seed")}</dt>
                  <dd className="generate-map-spec-seed" title={currentFacts?.seed}>
                    {currentFacts?.seed || "N/A"}
                  </dd>
                </div>
              </dl>

              {currentFacts && (
                <div className="generate-map-tags">
                  {summariseDecodedName(currentFacts).map((fact) => (
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
              <div className="generate-map-preview-empty-meta">
                <span className="generate-map-name-label">
                  {t("maps.generate.willBeCalled") || "Predicted map name"}
                </span>
                {state.predictedName && !reproducing ? (
                  <code className="generate-map-name-code">{state.predictedName}</code>
                ) : (
                  <p className="generate-map-empty-hint">
                    {reproducing
                      ? t("maps.generate.rebuildingHint")
                      : t("maps.generate.subtitle")}
                  </p>
                )}
              </div>
              <div className="generate-map-preview-empty-footer">
                <span className="muted">
                  {t("maps.generate.singleResultSubtitle")}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {zoomed && currentPreviewUrl && (
        <div
          className="generate-map-zoom-overlay"
          role="dialog"
          aria-label={t("maps.generate.enlargePreview")}
          onClick={() => setZoomed(false)}
        >
          <img
            className="generate-map-zoom-img"
            src={currentPreviewUrl}
            alt={currentMap ?? ""}
            decoding="async"
          />
          <span className="generate-map-zoom-hint muted">{t("maps.generate.closePreview")}</span>
        </div>
      )}
    </Modal>
  );
}

/** Whether a run is in flight. Mirrors `GeneratorStatus::is_busy` in faf-domain. */
export function stillRunning(status: GeneratorStatus): boolean {
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
