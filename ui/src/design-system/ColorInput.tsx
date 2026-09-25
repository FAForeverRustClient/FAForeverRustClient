// A colour field that speaks hex.
//
// `<input type="color">` opens WebView2's own picker, which shows red, green
// and blue as three numbers and gives a page no say in that. The settings,
// the chat menu and the swatch labels beside them all speak `#rrggbb`, so a
// colour copied out of one place could not be pasted into the picker (#285).
//
// This is the same field with the same contract, `value` in and `onChange`
// out as `#rrggbb`, and a small picker of its own: a saturation and
// brightness square, a hue slider, one hex field, and the screen eyedropper
// where the engine offers one. The popover is rendered into the document
// body, because two of the places this sits in (a context menu and a card
// grid) clip their overflow.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { clamp01, hexToHsv, hsvToHex, normalizeHex, type Hsv } from "./colorMath";
import { useTranslation } from "../i18n/useTranslation";
import "./color-input.css";

interface Props {
  /** `#rrggbb`. */
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  /** Classes for the trigger button, which replaces the native input in place. */
  className?: string;
  /** Draw the chosen colour on the trigger. Off where a swatch sits under it. */
  showSwatch?: boolean;
}

/** The Chromium screen eyedropper, where the engine has one. */
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };

const POPOVER_WIDTH = 220;

export function ColorInput({ value, onChange, "aria-label": ariaLabel, className, showSwatch = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  // Held rather than derived from `value`, so dragging to black or to grey
  // does not throw the hue away: `#000000` has no hue to read back.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (normalizeHex(value) !== hsvToHex(hsv)) setHsv(hexToHsv(value));
    setDraft(value);
    // `hsv` is deliberately not a dependency: this follows the outside value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.right - POPOVER_WIDTH), window.innerWidth - POPOVER_WIDTH - 8);
    const below = rect.bottom + 6;
    const height = popoverRef.current?.offsetHeight ?? 260;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    setPosition({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the picker: a menu or modal underneath must stay open.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setDraft(hex);
    onChange(hex);
  };

  const dragSquare = (event: ReactPointerEvent<HTMLDivElement>) => {
    const area = event.currentTarget;
    const update = (clientX: number, clientY: number) => {
      const rect = area.getBoundingClientRect();
      commit({
        h: hsv.h,
        s: clamp01((clientX - rect.left) / rect.width),
        v: clamp01(1 - (clientY - rect.top) / rect.height),
      });
    };
    area.setPointerCapture(event.pointerId);
    update(event.clientX, event.clientY);
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientX, moveEvent.clientY);
    const stop = () => {
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerup", stop);
      area.removeEventListener("pointercancel", stop);
    };
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerup", stop);
    area.addEventListener("pointercancel", stop);
  };

  const nudgeSquare = (key: string) => {
    const step = 0.02;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: clamp01(hsv.s - step) },
      ArrowRight: { s: clamp01(hsv.s + step) },
      ArrowUp: { v: clamp01(hsv.v + step) },
      ArrowDown: { v: clamp01(hsv.v - step) },
    };
    if (moves[key]) commit({ ...hsv, ...moves[key] });
  };

  const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  const pickFromScreen = async () => {
    if (!EyeDropper) return;
    try {
      const { sRGBHex } = await new EyeDropper().open();
      const hex = normalizeHex(sRGBHex);
      if (hex) commit(hexToHsv(hex));
    } catch {
      // Cancelled with Escape: nothing to do.
    }
  };

  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`color-input-trigger${className ? ` ${className}` : ""}`}
        style={showSwatch ? { backgroundColor: value } : undefined}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {open && createPortal(
        <div
          ref={popoverRef}
          className="color-input-popover surface-panel"
          role="dialog"
          aria-label={ariaLabel}
          style={{ ...position, width: POPOVER_WIDTH }}
        >
          <div
            className="color-input-square"
            style={{ backgroundColor: pureHue }}
            role="slider"
            tabIndex={0}
            aria-label={t("designSystem.colorInput.shade")}
            aria-valuetext={draft}
            onPointerDown={dragSquare}
            onKeyDown={(event) => {
              if (!event.key.startsWith("Arrow")) return;
              event.preventDefault();
              nudgeSquare(event.key);
            }}
          >
            <span
              className="color-input-square-handle"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hsvToHex(hsv) }}
            />
          </div>
          <input
            className="color-input-hue"
            type="range"
            min={0}
            max={359}
            value={Math.round(hsv.h)}
            aria-label={t("designSystem.colorInput.hue")}
            onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
          />
          <div className="color-input-row">
            <span className="color-input-preview" style={{ backgroundColor: hsvToHex(hsv) }} />
            <input
              className="color-input-hex"
              value={draft}
              maxLength={7}
              spellCheck={false}
              aria-label={t("designSystem.colorInput.hex")}
              onChange={(event) => {
                setDraft(event.target.value);
                const hex = normalizeHex(event.target.value);
                if (hex && event.target.value.replace(/^#/, "").length === 6) {
                  setHsv(hexToHsv(hex));
                  onChange(hex);
                }
              }}
              onBlur={() => {
                const hex = normalizeHex(draft);
                if (hex) {
                  setDraft(hex);
                  if (hex !== normalizeHex(value)) commit(hexToHsv(hex));
                } else {
                  setDraft(value);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
            />
            {EyeDropper && (
              <button
                type="button"
                className="color-input-eyedropper"
                title={t("designSystem.colorInput.eyedropper")}
                aria-label={t("designSystem.colorInput.eyedropper")}
                onClick={() => void pickFromScreen()}
              >
                <Icon name="eye" size={14} />
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
