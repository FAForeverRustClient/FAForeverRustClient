import type { ReactNode } from "react";

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
  children,
}: {
  label: string;
  hint: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`setting-row${className ? ` ${className}` : ""}`}>
      <div className="setting-copy">
        <span className="setting-label">{label}</span>
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
