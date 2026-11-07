// Settings, Game, "Companion programs": tools of the player's own that the
// client starts alongside Forged Alliance, such as a recording tool.
//
// The backend starts, skips and closes them (`infra::companions`); this only
// edits the list and shows what the last start came to. A change to what an
// entry runs is confirmed in a native dialog first (`picked_paths` in
// src-tauri), so the text fields are saved together with one button rather
// than on every blur: one change, one question.

import { useEffect, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type {
  CompanionCommand,
  CompanionLaunches,
  CompanionOutcome,
  CompanionProgram,
  CompanionProgramPatch,
  CompanionRun,
  CompanionTiming,
  SettingsCommand,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n/catalog/en";
import { formatShortDateTime } from "../../shared/format/dates";
import { runsOnWindows } from "../../shared/platform";
import { SettingsGroup, SettingsSwitch, useSettingsIndexEntry } from "./SettingControls";

/** Mirrors `faf_domain::state::settings::MAX_COMPANION_PROGRAMS`. */
const MAX_COMPANION_PROGRAMS = 16;

const LAUNCHES: { value: CompanionLaunches; label: MessageKey }[] = [
  { value: "games", label: "settings.game.companions.launches.games" },
  { value: "replays", label: "settings.game.companions.launches.replays" },
  { value: "both", label: "settings.game.companions.launches.both" },
];

const TIMINGS: { value: CompanionTiming; label: MessageKey }[] = [
  { value: "after", label: "settings.game.companions.timing.after" },
  { value: "before", label: "settings.game.companions.timing.before" },
];

/** The text fields, edited as a draft and saved together. */
type Draft = Pick<Required<CompanionProgram>, "name" | "program" | "arguments" | "workingDir" | "skipIfRunning">;

const draftOf = (entry: CompanionProgram): Draft => ({
  name: entry.name ?? "",
  program: entry.program ?? "",
  arguments: entry.arguments ?? "",
  workingDir: entry.workingDir ?? "",
  skipIfRunning: entry.skipIfRunning ?? "",
});

/**
 * Send one companion change. Each names one entry and only the fields it
 * touches, and the backend applies it to its own copy, so two quick changes
 * never undo each other. Refused when the player declines the native
 * confirmation; `restore` then puts the fields back to what is stored.
 */
const send = (command: SettingsCommand, restore?: () => void): Promise<void> =>
  ipc.settle({ kind: "Settings", command }).catch((error: unknown) => {
    restore?.();
    throw error;
  });

/** An id nothing else has had: the process started for an entry is found by it. */
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `companion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function CompanionProgramsSettings() {
  const { t } = useTranslation();
  const companions = useAppStore((state) => state.state.settings.game.companions ?? []);
  const runs = useAppStore((state) => state.state.install.companions);
  useSettingsIndexEntry(t("settings.game.companions.hint"));

  const add = () =>
    ipc.run(
      send({
        type: "addCompanion",
        payload: { companion: { id: newId(), enabled: true, launches: "games", timing: "after", closeWithGame: false } },
      }),
    );

  return (
    <SettingsGroup title={t("settings.game.group.companions")}>
      <div className="setting-block">
        <span className="muted">{t("settings.game.companions.hint")}</span>
      </div>
      {companions.map((entry) => (
        <CompanionEntry
          key={entry.id}
          entry={entry}
          run={runs.find((run) => run.id === entry.id)}
        />
      ))}
      <div className="setting-block companion-add">
        <Button onClick={add} disabled={companions.length >= MAX_COMPANION_PROGRAMS}>
          {t("settings.game.companions.add")}
        </Button>
      </div>
    </SettingsGroup>
  );
}

function CompanionEntry({ entry, run }: { entry: CompanionProgram; run: CompanionRun | undefined }) {
  const { t } = useTranslation();
  const stored = draftOf(entry);
  const [draft, setDraft] = useState<Draft>(stored);
  // Reset only when the stored text changes, so switching the entry off or
  // picking when it starts keeps whatever is being typed meanwhile.
  const storedKey = JSON.stringify(stored);
  useEffect(() => setDraft(JSON.parse(storedKey) as Draft), [storedKey]);
  const dirty = JSON.stringify(draft) !== storedKey;
  const set = (field: keyof Draft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));

  const id = entry.id ?? "";
  // A change to what the entry runs names what it was made against, and is
  // applied only while the entry still runs that.
  const base: CompanionCommand = { program: stored.program, arguments: stored.arguments, workingDir: stored.workingDir };
  const patch = (fields: CompanionProgramPatch, against: CompanionCommand | null, restore?: () => void) =>
    send({ type: "patchCompanion", payload: { id, base: against, patch: fields } }, restore);
  const remove = () => ipc.run(send({ type: "removeCompanion", payload: { id } }));

  const commit = (): Promise<void> => (dirty ? patch({ ...draft }, base, () => setDraft(stored)) : Promise.resolve());
  const saveDraft = () => ipc.run(commit());
  // A test start runs what is stored, so what is being typed is saved first;
  // declining the confirmation then starts nothing.
  const testStart = () =>
    ipc.run(
      commit().then(() =>
        ipc.settle({
          kind: "Settings",
          command: {
            type: "testCompanion",
            // What is shown: refused or overtaken, nothing starts.
            payload: { id, expected: { program: draft.program, arguments: draft.arguments, workingDir: draft.workingDir } },
          },
        }),
      ),
    );
  // The switches and lists change nothing that runs, so they save at once,
  // and only their own field: the draft is the Save button's to send.
  const change = (fields: CompanionProgramPatch) => ipc.run(patch(fields, null));

  const browseProgram = () =>
    ipc.run(
      native
        .selectFile({ defaultPath: draft.program || undefined })
        .then((picked) => picked && set("program")(picked)),
    );
  const browseFolder = () =>
    ipc.run(native.selectDirectory(draft.workingDir || undefined).then((picked) => picked && set("workingDir")(picked)));

  // The entry's heading: its name, or the file it starts while it has none.
  const fileName = draft.program.trim().split(/[\\/]/).pop() ?? "";
  const title = draft.name.trim() || fileName || t("settings.game.companions.unnamed");
  const onEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") saveDraft();
  };
  const text = (field: keyof Draft, placeholder?: string) => (
    <input
      className="settings-input"
      type="text"
      value={draft[field]}
      placeholder={placeholder}
      onChange={(event) => set(field)(event.target.value)}
      onKeyDown={onEnter}
    />
  );

  return (
    <div className="setting-block companion-entry">
      <div className="companion-entry-head">
        <span className="companion-title">{title}</span>
        <div className="companion-entry-actions">
          <Button onClick={testStart} disabled={!draft.program.trim()}>
            {t("settings.game.companions.test")}
          </Button>
          <Button onClick={remove}>{t("settings.game.companions.remove")}</Button>
        </div>
      </div>

      <Field label={t("settings.game.companions.name")}>{text("name", fileName || undefined)}</Field>
      <Field label={t("settings.game.companions.program")}>
        {text("program")}
        <Button onClick={browseProgram}>{t("settings.paths.browse")}</Button>
      </Field>
      <Field label={t("settings.game.companions.arguments")}>{text("arguments")}</Field>
      <Field label={t("settings.game.companions.workingDir")}>
        {text("workingDir", t("settings.game.companions.workingDirPlaceholder"))}
        <Button onClick={browseFolder}>{t("settings.paths.browse")}</Button>
      </Field>
      {/* The process list is a Windows question; elsewhere the field would
          do nothing. */}
      {runsOnWindows() && (
        <Field label={t("settings.game.companions.skipIfRunning")}>
          {text("skipIfRunning", t("settings.game.companions.skipIfRunningPlaceholder"))}
        </Field>
      )}

      <Field label={t("settings.game.companions.launches")} group>
        <select
          className="settings-select"
          value={entry.launches ?? "games"}
          onChange={(event) => change({ launches: event.target.value as CompanionLaunches })}
          aria-label={t("settings.game.companions.launches")}
        >
          {LAUNCHES.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
        <select
          className="settings-select"
          value={entry.timing ?? "after"}
          onChange={(event) => change({ timing: event.target.value as CompanionTiming })}
          aria-label={t("settings.game.companions.timing")}
        >
          {TIMINGS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="" group>
        <span className="companion-switch">
          <SettingsSwitch
            checked={entry.enabled ?? true}
            onChange={(enabled) => change({ enabled })}
            label={t("settings.game.companions.enabled", { name: title })}
          />
          <span aria-hidden="true">{t("settings.game.companions.autostart")}</span>
        </span>
        <span className="companion-switch">
          <SettingsSwitch
            checked={entry.closeWithGame ?? false}
            onChange={(closeWithGame) => change({ closeWithGame })}
            label={t("settings.game.companions.closeWithGame")}
          />
          <span aria-hidden="true">{t("settings.game.companions.closeWithGame")}</span>
        </span>
      </Field>

      <div className="settings-save-line">
        <span className={`muted companion-result${run?.outcome.type === "failed" ? " is-failed" : ""}`} role="status">
          {run ? describeRun(run, t) : t("settings.game.companions.neverStarted")}
        </span>
        <Button onClick={saveDraft} disabled={!dirty}>
          {t("settings.game.companions.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * One row of an entry: its label in the first column, its controls in the
 * second. A row of several controls (`group`) is not a `label`, which may
 * only name one.
 */
function Field({ label, group = false, children }: { label: string; group?: boolean; children: ReactNode }) {
  const Row = group ? "div" : "label";
  return (
    <Row className="companion-field">
      <span className="companion-field-label">{label}</span>
      <span className={group ? "companion-field-input companion-field-group" : "companion-field-input"}>{children}</span>
    </Row>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** The last start, in a line: what happened and when. */
function describeRun(run: CompanionRun, t: Translate): string {
  const at = formatShortDateTime(run.at * 1000, "");
  const outcome: CompanionOutcome = run.outcome;
  switch (outcome.type) {
    case "started":
      return t("settings.game.companions.result.started", { pid: String(outcome.payload.pid), at });
    case "alreadyRunning":
      return t("settings.game.companions.result.alreadyRunning", { pid: String(outcome.payload.pid), at });
    case "skippedRunningImage":
      return t("settings.game.companions.result.skipped", { image: outcome.payload.image, at });
    case "failed":
      return t("settings.game.companions.result.failed", { reason: outcome.payload.reason, at });
    case "closed":
      return t("settings.game.companions.result.closed", { pid: String(outcome.payload.pid), at });
  }
}
