import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { addSettingsIndexEntry, removeSettingsIndexEntry } from "./settingsSearch";

/**
 * Which section the rows below belong to.
 *
 * Supplied by the settings shell around each section's panels, so a row does
 * not have to be told, and a panel that moves between sections carries its
 * rows' search entries with it without anybody editing a list.
 */
const SectionContext = createContext<string>("");

export function SettingsSectionScope({
  section,
  children,
}: {
  section: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The choices inside a dropdown are words people search for too ("pioneer"
  // finds the ICE adapter picker, whose label says only "ICE adapter"), and
  // no row passes them to the index. They are read off the rendered options
  // rather than listed a second time, for the reason at the top of
  // `settingsSearch`, and read again whenever the section's markup changes,
  // so a language switch or a list that loads late is picked up. Only a
  // difference touches the index, so typing elsewhere in the tab is cheap.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let indexed: string[] = [];
    const sync = () => {
      const next = [...new Set(
        [...root.querySelectorAll("option")]
          .map((option) => option.textContent?.trim() ?? "")
          .filter(Boolean),
      )];
      for (const phrase of indexed) if (!next.includes(phrase)) removeSettingsIndexEntry(section, phrase);
      for (const phrase of next) if (!indexed.includes(phrase)) addSettingsIndexEntry(section, phrase);
      indexed = next;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      for (const phrase of indexed) removeSettingsIndexEntry(section, phrase);
    };
  }, [section]);
  return (
    <SectionContext.Provider value={section}>
      <div ref={ref} className="settings-section-scope">{children}</div>
    </SectionContext.Provider>
  );
}

/**
 * Contribute this row's own words to the settings search.
 *
 * Called by every row that carries a label, which is what keeps the index and
 * the screen the same list. Exported because a few blocks build their copy
 * themselves rather than going through [`SettingRow`].
 */
export function useSettingsIndexEntry(...text: (ReactNode | undefined)[]): void {
  // Only strings are indexable, and only strings are ever passed here in
  // practice: a label built out of elements has no text this can read, and
  // guessing at one would index markup.
  const phrases = text.filter((value): value is string => typeof value === "string");
  // Joined into one string so the effect below has a stable dependency: an
  // array literal is a new value on every render and would re-register every
  // row on every keystroke elsewhere in the tab. A newline is a safe separator
  // because no label or hint contains one.
  const key = phrases.join("\n");
  const section = useContext(SectionContext);
  useEffect(() => {
    if (!section) return;
    const parts = key.split("\n").filter(Boolean);
    for (const phrase of parts) addSettingsIndexEntry(section, phrase);
    return () => {
      for (const phrase of parts) removeSettingsIndexEntry(section, phrase);
    };
  }, [section, key]);
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  useSettingsIndexEntry(title, description);
  return (
    <section className="settings-section surface-panel" id={id} aria-labelledby={`${id}-title`}>
      <header className="settings-section-head">
        <h3 className="settings-section-title" id={`${id}-title`}>{title}</h3>
        <p className="muted">{description}</p>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  hint,
  className,
  badge,
  children,
}: {
  label: ReactNode;
  /**
   * Only for what the label and the control do not already say: a limit, a
   * default, an edge case (#306). A self-explanatory setting has none, and
   * the settings search then finds its row by the label alone.
   */
  hint?: ReactNode;
  className?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  useSettingsIndexEntry(label, hint);
  return (
    <div className={`setting-row${className ? ` ${className}` : ""}`}>
      <div className="setting-copy">
        <span className="setting-label">
          {label}
          {badge}
        </span>
        {hint && <span className="muted">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function SettingsSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="settings-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span className="settings-switch-track" aria-hidden="true"><span /></span>
    </label>
  );
}
