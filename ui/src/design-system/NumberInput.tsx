import { useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes } from "react";

/**
 * What one keystroke in a number field means.
 *
 * `null` for the states a field passes *through* on the way to a number: empty
 * after the last digit is deleted, a lone minus sign before the digits arrive.
 * Those are not values, and treating them as one is what put a `0` in the way.
 */
export function numberFromEdit(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "+") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number;
  onChange: (value: number) => void;
};

/**
 * A number field that is allowed to be empty while it is being typed in.
 *
 * `value={aNumber}` with `Number(event.target.value)` turns a cleared field
 * into a zero the moment the last digit goes, because `Number("")` is `0` and
 * the parent hands that straight back. Every edit then starts by selecting a
 * zero somebody has to get rid of first.
 *
 * The keystrokes live here as a draft and the parent only ever hears a number
 * it can use. Leaving the field drops the draft, so the parent's own value
 * comes back on screen and an abandoned edit cannot leave a field blank.
 */
export function NumberInput({ value, onChange, onBlur, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    const parsed = numberFromEdit(text);
    if (parsed !== null) onChange(parsed);
  };

  const blur = (event: FocusEvent<HTMLInputElement>) => {
    setDraft(null);
    onBlur?.(event);
  };

  return (
    <input
      {...rest}
      type="number"
      value={draft ?? String(value)}
      onChange={change}
      onBlur={blur}
    />
  );
}
