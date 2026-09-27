// Numeric dates in the order the user's regional format asks for (issue 292).
//
// Windows keeps the regional format apart from the display language: an
// English Windows set to a German or Ukrainian region writes `16.09.2026`
// everywhere, while a webview formats dates after its language and writes
// `09/16/2026`, and a native date field shows `mm/dd/yyyy`. The shell reads
// the regional short date pattern once at startup; numeric dates and the date
// fields follow it. Dates with words in them (`Sep 16, 2026`) stay with the
// client's language, which is what keeps month names out of a foreign one.

import { native } from "../../ipc/native";
import { isDesktopShell } from "../webviewEngine";

type DateField = "day" | "month" | "year";

export type DatePatternToken =
  | { field: DateField; width: number }
  | { literal: string };

/** The order and separators of a numeric date, or `null` for the language's own. */
let systemTokens: DatePatternToken[] | null = null;

/**
 * A Windows short date pattern (`dd.MM.yyyy`, `M/d/yyyy`) as tokens, or
 * `null` for one that is not purely numeric: a day or month written as a
 * name, an era, or a field missing or repeated.
 */
export function parseDatePattern(pattern: string): DatePatternToken[] | null {
  const tokens: DatePatternToken[] = [];
  const pushLiteral = (text: string) => {
    const last = tokens[tokens.length - 1];
    if (last && "literal" in last) last.literal += text;
    else tokens.push({ literal: text });
  };
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "'") {
      const end = pattern.indexOf("'", index + 1);
      if (end === -1) return null;
      pushLiteral(end === index + 1 ? "'" : pattern.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === "d" || char === "M" || char === "y" || char === "g") {
      let run = 1;
      while (pattern[index + run] === char) run += 1;
      index += run;
      if (char === "g") return null;
      if (char === "y") {
        tokens.push({ field: "year", width: run <= 2 ? 2 : 4 });
      } else {
        // `ddd` and `MMM` are names, which a numeric date has none of.
        if (run > 2) return null;
        tokens.push({ field: char === "d" ? "day" : "month", width: run });
      }
      continue;
    }
    pushLiteral(char);
    index += 1;
  }
  const fields = tokens.flatMap((token) => ("field" in token ? [token.field] : []));
  const complete = fields.length === 3 && ["day", "month", "year"].every((field) => fields.includes(field as DateField));
  return complete ? tokens : null;
}

/** `date` written in `tokens`, from its local calendar day. */
export function formatWithTokens(tokens: readonly DatePatternToken[], date: Date): string {
  return tokens
    .map((token) => {
      if ("literal" in token) return token.literal;
      if (token.field === "year") {
        const year = date.getFullYear();
        return token.width === 2 ? String(year % 100).padStart(2, "0") : String(year);
      }
      const value = token.field === "day" ? date.getDate() : date.getMonth() + 1;
      return String(value).padStart(token.width, "0");
    })
    .join("");
}

/** What an empty date field shows: `dd.mm.yyyy`. */
export function placeholderFor(tokens: readonly DatePatternToken[]): string {
  return tokens
    .map((token) => {
      if ("literal" in token) return token.literal;
      if (token.field === "year") return "y".repeat(token.width);
      return token.field === "day" ? "dd" : "mm";
    })
    .join("");
}

/**
 * Text typed into a date field, read in `tokens`' order, as the `yyyy-mm-dd`
 * a native date field holds, or `null` while it is not a whole, real date.
 *
 * Any separator will do, so `16.9.26` and `16/09/2026` both read in a
 * day-first pattern, and a two-digit year is this century's.
 */
export function parseWithTokens(tokens: readonly DatePatternToken[], text: string): string | null {
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length !== 3) return null;
  const order = tokens.flatMap((token) => ("field" in token ? [token.field] : []));
  const value = (field: DateField) => numbers[order.indexOf(field)];
  const yearText = value("year");
  if (yearText.length !== 2 && yearText.length !== 4) return null;
  const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  const month = Number(value("month"));
  const day = Number(value("day"));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The regional pattern's tokens, or `null` to use the client language's order. */
export function systemDateTokens(): DatePatternToken[] | null {
  return systemTokens;
}

/** For tests, and for the shell: the pattern read at startup. */
export function setSystemDatePattern(pattern: string | null): void {
  systemTokens = pattern === null ? null : parseDatePattern(pattern);
}

/**
 * Read the regional pattern once, before the first render, so that no date
 * is drawn in one order and then redrawn in the other. Outside the desktop
 * shell, or in one without the command, dates keep the language's order.
 */
export async function loadSystemDatePattern(): Promise<void> {
  if (!isDesktopShell()) return;
  try {
    setSystemDatePattern(await native.systemDatePattern());
  } catch {
    setSystemDatePattern(null);
  }
}
