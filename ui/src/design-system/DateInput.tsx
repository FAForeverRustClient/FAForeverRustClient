// A date field in the user's regional format (issue 292).
//
// `<input type="date">` lays its field out after the webview's language, so
// an English Windows set to a day-first region shows `mm/dd/yyyy` there and
// nowhere else. Where the shell has read a regional pattern this is a text
// field in that pattern instead, with the native calendar one click away on
// its button. Where it has not, in a browser or on a system without one, it is
// the native field as before.
//
// The contract is the native field's either way: `value` in and `onChange`
// out as `yyyy-mm-dd`, or `""` for no date.

import { useRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes } from "react";
import { t } from "../i18n";
import {
  formatWithTokens,
  parseWithTokens,
  placeholderFor,
  systemDateTokens,
  type DatePatternToken,
} from "../shared/format/systemDate";
import { Icon } from "./Icon";
import "./date-input.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  /** `yyyy-mm-dd`, or `""` for no date. */
  value: string;
  onChange: (value: string) => void;
};

/** A native field's `yyyy-mm-dd` written in `tokens`, or `""`. */
function shownValue(tokens: readonly DatePatternToken[], value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatWithTokens(tokens, date);
}

export function DateInput({ value, onChange, onBlur, className, readOnly, disabled, ...rest }: Props) {
  // Only while typing: what was typed, whole date or not. Leaving the field
  // puts back the last whole date it held.
  const [draft, setDraft] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const tokens = systemDateTokens();

  if (!tokens) {
    return (
      <input
        {...rest}
        className={className}
        readOnly={readOnly}
        disabled={disabled}
        onBlur={onBlur}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    if (text.trim() === "") {
      onChange("");
      return;
    }
    const parsed = parseWithTokens(tokens, text);
    if (parsed !== null) onChange(parsed);
  };

  const blur = (event: FocusEvent<HTMLInputElement>) => {
    setDraft(null);
    onBlur?.(event);
  };

  const openPicker = () => {
    try {
      picker.current?.showPicker();
    } catch {
      // An engine without `showPicker` still has the text field.
    }
  };

  const locked = Boolean(readOnly || disabled);

  return (
    <span className="date-input">
      <input
        {...rest}
        className={className}
        readOnly={readOnly}
        disabled={disabled}
        type="text"
        placeholder={placeholderFor(tokens)}
        value={draft ?? shownValue(tokens, value)}
        onChange={change}
        onBlur={blur}
      />
      <button
        type="button"
        className="date-input-button"
        aria-label={t("common.pickDate")}
        title={t("common.pickDate")}
        disabled={locked}
        onClick={openPicker}
      >
        <Icon name="calendar" size={14} />
      </button>
      <input
        ref={picker}
        className="date-input-picker"
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        onChange={(event) => {
          setDraft(null);
          onChange(event.target.value);
        }}
      />
    </span>
  );
}
