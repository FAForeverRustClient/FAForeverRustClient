import "./switch.css";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name. The switch draws no text of its own. */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * An on/off switch for a setting that takes effect at once.
 *
 * Settings drew the only one, and the Events tab's reminder needed the same
 * control; a feature cannot import another feature, so it lives here.
 */
export function Switch({ checked, onChange, label, disabled = false, className }: Props) {
  return (
    <label className={className ? `switch ${className}` : "switch"}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span className="switch-track" aria-hidden="true"><span /></span>
    </label>
  );
}
