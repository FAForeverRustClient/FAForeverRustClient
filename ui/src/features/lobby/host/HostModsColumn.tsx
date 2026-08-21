// The mods column, identical in both host dialogs: saved presets, a search, the
// UI/Sim split, and bulk actions scoped to whichever kind is on screen.
//
// Self-contained on purpose: it reads the installed mods and the presets from
// the store and writes both back itself, so a dialog embedding it passes
// nothing and cannot get the wiring subtly wrong.

import { useMemo, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { ipc } from "../../../ipc/client";
import type { InstalledMod, ModPreset } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { useAppStore } from "../../../store/store";
import { ModPresetModal } from "../ModPresetModal";

type ModTab = "ui" | "sim";

export function HostModsColumn() {
  const { t } = useTranslation();
  const installedMods = useAppStore((state) => state.state.mods.installed);
  const presets = useAppStore((state) => state.state.settings.browsing.modPresets);

  const [modTab, setModTab] = useState<ModTab>("ui");
  const [modSearch, setModSearch] = useState("");
  const [presetModalOpen, setPresetModalOpen] = useState(false);

  /// `setBrowsing` replaces the whole preferences bag, so a writer must start
  /// from the newest copy rather than the one captured at render time. Saving a
  /// preset and closing the dialog in quick succession would otherwise write the
  /// preset straight back out again.
  const currentBrowsing = () => useAppStore.getState().state.settings.browsing;

  const activeModsCount = useMemo(
    () => installedMods.filter((mod) => mod.enabled).length,
    [installedMods],
  );
  const simMods = useMemo(
    () => installedMods.filter((mod) => mod.modType === "sim"),
    [installedMods],
  );
  const uiMods = useMemo(() => installedMods.filter((mod) => mod.modType === "ui"), [installedMods]);

  const filteredMods = useMemo(() => {
    const query = modSearch.trim().toLowerCase();
    return installedMods
      .filter((mod) => {
        if (mod.modType !== modTab) return false;
        if (!query) return true;
        return (
          mod.displayName.toLowerCase().includes(query) ||
          (mod.modType === "ui" && query === "ui") ||
          (mod.modType === "sim" && query === "sim")
        );
      })
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName),
      );
  }, [installedMods, modSearch, modTab]);

  // One command rather than one per mod: each `toggleMod` rewrites
  // `game.prefs` and rescans every mod folder, so a bulk action across twenty
  // mods would cost twenty rescans and walk the list through every
  // intermediate state on screen.
  const setActiveMods = (uids: string[]) => {
    ipc.send({ kind: "Mods", command: { type: "setActiveMods", payload: { uids } } });
  };

  const setModsEnabled = (mods: InstalledMod[], enabled: boolean) => {
    const affected = new Set(mods.map((mod) => mod.uid));
    setActiveMods(
      installedMods
        .filter((mod) => (affected.has(mod.uid) ? enabled : mod.enabled))
        .map((mod) => mod.uid),
    );
  };

  // A preset is the complete wanted state, so everything it does not name is
  // switched off. Without that, "put my set back" would leave whatever the user
  // had enabled in the meantime sitting alongside it.
  const applyPreset = (preset: ModPreset) => {
    const wanted = new Set(preset.uids);
    setActiveMods(installedMods.filter((mod) => wanted.has(mod.uid)).map((mod) => mod.uid));
  };

  const persistPresets = (modPresets: ModPreset[]) => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: { preferences: { ...currentBrowsing(), modPresets } },
      },
    });
  };

  const savePreset = (name: string, uids: string[]) => {
    const key = name.toLocaleLowerCase();
    const existing = presets.findIndex((preset) => preset.name.toLocaleLowerCase() === key);
    // Overwrite in place rather than moving the preset to the end: the list is
    // a row of buttons, and having one jump position on every save is worse
    // than it sounds once there are more than two.
    persistPresets(
      existing >= 0
        ? presets.map((preset, index) => (index === existing ? { name, uids } : preset))
        : [...presets, { name, uids }],
    );
    setPresetModalOpen(false);
  };

  const deletePreset = (name: string) =>
    persistPresets(presets.filter((preset) => preset.name !== name));

  // What the list shows is what Enable All / Disable All act on, which is how
  // the two mod kinds stay separately controllable without four buttons.
  const tabMods = modTab === "ui" ? uiMods : simMods;

  return (
    <section className="host-column host-column-mods surface-panel">
      <div className="host-column-header">
        <h3>{t("lobby.host.mods")}</h3>
        <span className="host-count-badge">
          {activeModsCount} active · {installedMods.length} installed
        </span>
      </div>

      <div className="host-preset-block">
        <span className="host-preset-label">{t("lobby.host.presets")}</span>
        <div className="host-preset-chips">
          {presets.map((preset) => (
            <span key={preset.name} className="host-preset-chip">
              <button
                type="button"
                className="host-preset-apply"
                title={t("lobby.host.applyPreset", { name: preset.name })}
                onClick={() => applyPreset(preset)}
              >
                {preset.name}
              </button>
              <button
                type="button"
                className="host-preset-delete"
                aria-label={t("lobby.host.deletePreset", { name: preset.name })}
                onClick={() => deletePreset(preset.name)}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="host-preset-save"
            disabled={installedMods.length === 0}
            onClick={() => setPresetModalOpen(true)}
          >
            <Icon name="plus" size={12} /> {t("lobby.host.savePreset")}
          </button>
        </div>
      </div>

      <div className="search-field host-column-search">
        <Icon name="search" size={13} />
        <input
          value={modSearch}
          onChange={(event) => setModSearch(event.target.value)}
          placeholder={t("lobby.host.searchModsPlaceholder")}
          aria-label={t("lobby.host.searchModsAria")}
        />
      </div>

      <div className="host-mod-tabs">
        <button
          type="button"
          className={`host-mod-tab${modTab === "ui" ? " active" : ""}`}
          onClick={() => setModTab("ui")}
        >
          {t("lobby.host.uiMods")} ({uiMods.length})
        </button>
        <button
          type="button"
          className={`host-mod-tab${modTab === "sim" ? " active" : ""}`}
          onClick={() => setModTab("sim")}
        >
          {t("lobby.host.simMods")} ({simMods.length})
        </button>
      </div>

      <div className="host-column-body host-mod-list">
        {filteredMods.length === 0 ? (
          <p className="play-empty">
            {t(installedMods.length === 0 ? "lobby.host.noInstalledMods" : "lobby.host.noModsMatch")}
          </p>
        ) : (
          filteredMods.map((mod) => (
            <label key={mod.uid} className={`host-mod-row${mod.enabled ? " is-active" : ""}`}>
              <input
                type="checkbox"
                checked={mod.enabled}
                onChange={(event) =>
                  ipc.send({
                    kind: "Mods",
                    command: {
                      type: "toggleMod",
                      payload: { uid: mod.uid, enabled: event.target.checked },
                    },
                  })
                }
              />
              <span className="host-mod-name" title={mod.displayName}>
                {mod.displayName}
              </span>
              {/* The tab already says which kind these are, so the trailing
                  slot carries the version instead of a redundant badge. */}
              <span className="host-mod-version">{mod.version}</span>
            </label>
          ))
        )}
      </div>

      <div className="host-column-footer host-mod-actions">
        <Button
          className="host-col-action-btn"
          disabled={tabMods.length === 0 || tabMods.every((mod) => mod.enabled)}
          onClick={() => setModsEnabled(tabMods, true)}
        >
          {t("lobby.host.enableAll")}
        </Button>
        <Button
          className="host-col-action-btn"
          disabled={!tabMods.some((mod) => mod.enabled)}
          onClick={() => setModsEnabled(tabMods, false)}
        >
          {t("lobby.host.disableAll")}
        </Button>
      </div>

      <div className="host-column-footer">
        <Button
          className="host-col-action-btn"
          onClick={() => ipc.send({ kind: "Mods", command: { type: "loadInstalled" } })}
        >
          <Icon name="refresh" size={13} /> {t("lobby.host.reloadMods")}
        </Button>
      </div>

      {presetModalOpen && (
        <ModPresetModal
          installedMods={installedMods}
          presets={presets}
          onCancel={() => setPresetModalOpen(false)}
          onSave={savePreset}
        />
      )}
    </section>
  );
}
