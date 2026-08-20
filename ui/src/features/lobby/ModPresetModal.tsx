import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { InstalledMod, ModPreset } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  installedMods: InstalledMod[];
  presets: ModPreset[];
  onCancel: () => void;
  onSave: (name: string, uids: string[]) => void;
}

/**
 * Name a set of installed mods and save it, so it can be put back in one click.
 *
 * The selection starts as whatever is enabled right now. That is the request
 * this came from: someone wants to turn every mod off to watch an old replay
 * and get exactly their working set back afterwards, and having to re-tick that
 * set by hand is the chore the preset is supposed to remove.
 */
export function ModPresetModal({ installedMods, presets, onCancel, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(
    () => new Set(installedMods.filter((mod) => mod.enabled).map((mod) => mod.uid)),
  );

  const uiMods = useMemo(() => installedMods.filter((mod) => mod.modType === "ui"), [installedMods]);
  const simMods = useMemo(
    () => installedMods.filter((mod) => mod.modType === "sim"),
    [installedMods],
  );

  const trimmed = name.trim();
  // Matching is case-insensitive because the domain deduplicates that way; a
  // "replay" typed over "Replay" replaces it rather than quietly vanishing on
  // the next normalisation pass.
  const overwrites = presets.some(
    (preset) => preset.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );

  const toggle = (uid: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(uid)) next.add(uid);
      return next;
    });
  };

  const save = () => {
    if (!trimmed) return;
    // Ordered by the installed list rather than by click order, so two presets
    // holding the same mods are stored identically.
    onSave(
      trimmed,
      installedMods.filter((mod) => selected.has(mod.uid)).map((mod) => mod.uid),
    );
  };

  const section = (label: string, mods: InstalledMod[]) => (
    <section className="preset-mod-column">
      <div className="preset-mod-column-head">
        <h3>{label}</h3>
        <span className="host-count-badge">
          {mods.filter((mod) => selected.has(mod.uid)).length}/{mods.length}
        </span>
      </div>
      <div className="preset-mod-list">
        {mods.length === 0 ? (
          <p className="play-empty">{t("lobby.preset.noneInstalled")}</p>
        ) : (
          mods.map((mod) => (
            <label
              key={mod.uid}
              className={`host-mod-row${selected.has(mod.uid) ? " is-active" : ""}`}
            >
              <input
                type="checkbox"
                checked={selected.has(mod.uid)}
                onChange={() => toggle(mod.uid)}
              />
              <span className="host-mod-name" title={mod.displayName}>
                {mod.displayName}
              </span>
            </label>
          ))
        )}
      </div>
    </section>
  );

  return (
    <Modal className="mod-preset-modal" onClose={onCancel} ariaLabel={t("lobby.preset.title")}>
      <div className="play-dialog-head">
        <div>
          <h2>{t("lobby.preset.title")}</h2>
          <p>{t("lobby.preset.subtitle")}</p>
        </div>
      </div>

      <div className="preset-name-row surface-panel">
        <label className="preset-name-label" htmlFor="mod-preset-name">
          {t("lobby.preset.nameLabel")}
        </label>
        <input
          id="mod-preset-name"
          className="host-title-input"
          value={name}
          maxLength={64}
          autoFocus
          placeholder={t("lobby.preset.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="preset-mod-grid surface-panel">
        {section(t("lobby.host.uiMods"), uiMods)}
        {section(t("lobby.host.simMods"), simMods)}
      </div>

      <div className="preset-dialog-footer">
        <span className="preset-footer-hint">
          {!trimmed
            ? t("lobby.preset.needsName")
            : overwrites
              ? t("lobby.preset.willOverwrite", { name: trimmed })
              : t("lobby.preset.selectedCount", { count: selected.size })}
        </span>
        <div className="preset-footer-actions">
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!trimmed} onClick={save}>
            {overwrites ? t("lobby.preset.overwrite") : t("lobby.host.createPreset")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
