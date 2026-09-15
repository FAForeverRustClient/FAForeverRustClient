import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";

import { addSettingsIndexEntry, removeSettingsIndexEntry } from "./settingsSearch";

/**
 * Which register the rows below belong to.
 *
 * Supplied by the settings shell around each register's panels, so a row does
 * not have to be told, and a panel that moves between registers carries its
 * rows' search entries with it without anybody editing a list.
 */
const RegisterContext = createContext<string>("");

export function SettingsRegisterScope({
  register,
  children,
}: {
  register: string;
  children: ReactNode;
}) {
  return <RegisterContext.Provider value={register}>{children}</RegisterContext.Provider>;
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
  const register = useContext(RegisterContext);
  useEffect(() => {
    if (!register) return;
    const parts = key.split("\n").filter(Boolean);
    for (const phrase of parts) addSettingsIndexEntry(register, phrase);
    return () => {
      for (const phrase of parts) removeSettingsIndexEntry(register, phrase);
    };
  }, [register, key]);
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
  hint: ReactNode;
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
        <span className="muted">{hint}</span>
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
