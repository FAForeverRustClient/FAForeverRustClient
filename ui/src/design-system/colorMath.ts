// Conversions behind `ColorInput`: the picker edits hue, saturation and value,
// and everything outside it speaks `#rrggbb`.

export interface Hsv {
  /** 0 to 360. */
  h: number;
  /** 0 to 1. */
  s: number;
  /** 0 to 1. */
  v: number;
}

/**
 * `#rrggbb` in lower case, or `null` for anything else.
 *
 * Accepts the shorthand `#rgb` and a missing `#`, because that is how people
 * paste colours; hands back the one spelling the settings store.
 */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.split("").map((digit) => digit + digit).join("")}`;
  }
  return /^[0-9a-f]{6}$/.test(raw) ? `#${raw}` : null;
}

export function hexToHsv(hex: string): Hsv {
  const normalized = normalizeHex(hex) ?? "#000000";
  const r = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const g = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const b = Number.parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - chroma;
  const [r, g, b] =
    hue < 60 ? [chroma, x, 0]
      : hue < 120 ? [x, chroma, 0]
        : hue < 180 ? [0, chroma, x]
          : hue < 240 ? [0, x, chroma]
            : hue < 300 ? [x, 0, chroma]
              : [chroma, 0, x];
  const channel = (value: number) =>
    Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
