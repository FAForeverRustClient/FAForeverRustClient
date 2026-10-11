import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { GenerationType, GeneratorOptions, GeneratorStatus } from "../../ipc/bindings";
import type { SelectOption } from "../../design-system/Select";
import { ipc } from "../../ipc/client";
import { isGeneratedMap } from "../../shared/mapPresentation";
import { recordEntries } from "../../shared/records";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { MAP_SIZES, TEAM_COUNTS, canGenerate, formatMapSize, isFatal, outcomeOfRun, spawnCountsFor } from "../../shared/generatorPresentation";
import { GENERATION_TYPES, decodeNames, generate, generateNamed, loadOptions, loadPresets, setOptions } from "./generatorCommands";
import { stillRunning } from "./GeneratorProgress";
import { generatorDraftReducer } from "./generatorDraft";
import { useGeneratorPresets } from "./useGeneratorPresets";

export function useGeneratorDialog(onClose: () => void, onGenerated?: (maps: string[]) => void) {
  const { t } = useTranslation();
  const state = useAppStore((s) => s.state.mapGenerator);
  const [form, updateForm] = useReducer(generatorDraftReducer, state.options);
  const [showHelp, setShowHelp] = useState(false);

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
  const [failure, setFailure] = useState<string | null>(null);
  const lastRun = useRef<(() => void) | null>(null);
  const [results, setResults] = useState<string[] | null>(null);
  useEffect(() => {
    const outcome = outcomeOfRun(state.status, awaitingSince.current);
    if (outcome.kind === "waiting") return;
    awaitingSince.current = null;
    if (outcome.kind !== "generated") {
      if (state.status.type === "failed") setFailure(state.status.payload.reason);
      return;
    }
    setResults(outcome.maps);
    // Each name carries its own parameters, so the overview can describe every
    // map it lists without another generator run.
    if (outcome.maps.length > 0) void decodeNames(outcome.maps);
  }, [state.status]);

  const beginRun = (start: () => void) => {
    awaitingSince.current = state.status;
    setResults(null);
    setFailure(null);
    lastRun.current = start;
    start();
  };

  const retry = () => { if (lastRun.current) beginRun(lastRun.current); };

  /** Hand one map back to whoever opened the dialog, e.g. to host it. */
  const pick = (map: string) => {
    setResults(null);
    onGenerated?.([map]);
    onClose();
  };

  const set = <K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) =>
    updateForm({ type: "patch", patch: { [key]: value } });

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

  // Re-check the options as they are edited, and remember them.
  //
  // `setOptions` runs the same validation `validate` does and writes the
  // options to the settings file as well, so one settled-keystroke command
  // does both. That is deliberate: there used to be a "Remember these
  // options" button beside Generate, and nothing on screen said whether it had
  // been pressed, which made it indistinguishable from a button that did
  // nothing. Remembering is now what the dialog always does.
  //
  // What counts as remembered is what the backend holds, read back out of
  // state, and never what this dialog last sent: a send that was refused or
  // lost would otherwise be taken for saved, and the same options would never
  // be offered again. The backend echoes accepted options as
  // `OptionsChanged`, so a form that matches state needs no write, which also
  // keeps opening the dialog from rewriting the settings file.
  const remembered = JSON.stringify(state.options);
  useEffect(() => {
    if (reproducing) return;
    if (JSON.stringify(form) === remembered) return;
    const timer = setTimeout(() => void setOptions(form), 250);
    return () => clearTimeout(timer);
  }, [form, remembered, reproducing]);

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

  const { presets, existing, saved, presetName, setPresetName, presetNameUsable, save, applyPreset } =
    useGeneratorPresets(state, form, (options) => updateForm({ type: "replace", options }));

  const seedPinsOneMap = form.seed.trim() !== "";
  const teams = form.numTeams ?? 2;
  const spawnOptions = useMemo(() => spawnCountsFor(teams), [teams]);

  // Changing the team count can strand the spawn count on an illegal value, so
  // it moves with it. The Java client does the same by refiltering its spinner.
  const changeTeams = (numTeams: number) =>
    updateForm({ type: "teams", numTeams });

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
  };
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // Left and right step through the run. Generating several maps at once and
  // comparing them is the whole point of asking for several, and the only way
  // through them was clicking each thumbnail in turn.
  //
  // Not while the preview is zoomed: the arrows pan the enlarged image there,
  // which is the more specific meaning and the one already bound. And not
  // while a field has the caret, because the arrows belong to the text being
  // typed or the option being chosen -- this dialog is mostly a form.
  useEffect(() => {
    const count = results?.length ?? 0;
    if (zoomed || count < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const focused = event.target as HTMLElement | null;
      const tag = focused?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (focused?.isContentEditable || focused?.closest('[role="combobox"], [role="tablist"]')) return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : count - 1;
      setSelectedMapIndex((current) => (current + step) % count);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [results, zoomed]);

  const currentMap = results && results.length > 0 ? results[selectedMapIndex] ?? results[0] : null;
  const currentPreviewUrl = currentMap ? previews[currentMap] : undefined;
  const currentFacts = currentMap ? state.decoded?.[currentMap] : undefined;
  const pickable = Boolean(onGenerated);

  return { failure, retry, t, state, form, set, showHelp, setShowHelp, busy, reproduceName, setReproduceName, reproducing, reproduceValid, decoded, blocking, advisory, submittable, submit, presets, existing, saved, presetName, setPresetName, presetNameUsable, save, applyPreset, seedPinsOneMap, teams, changeTeams, versionOptions, mapSizeOptions, teamOptions, spawnSelectOptions, generationTypeOptions, presetOptions, lists, styleOverrides, typeOverrides, rawOverrides, results, selectedMapIndex, setSelectedMapIndex, copied, zoomed, setZoomed, copyCurrentName, currentMap, currentPreviewUrl, currentFacts, pickable, previews, pick, handleDeleteMap };
}
export type GeneratorDialogModel = ReturnType<typeof useGeneratorDialog>;
