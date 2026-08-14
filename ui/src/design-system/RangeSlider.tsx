import { useId, useState } from "react";
import "./range-slider.css";
import "./search-panel.css";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
  label: string;
  min: number;
  max: number;
  step?: number;
  /** `null` = unbounded on that side. */
  low: number | null;
  high: number | null;
  onChange: (low: number | null, high: number | null) => void;
  /** Renders a value for the readout, e.g. appending a unit. */
  format?: (value: number) => string;
}

export function RangeSlider({
  label,
  min,
  max,
  step = 1,
  low,
  high,
  onChange,
  format = String,
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [activeHandle, setActiveHandle] = useState<"low" | "high" | null>(null);

  const lowValue = low ?? min;
  const highValue = high ?? max;

  const pct = (value: number) => {
    if (max <= min) return 0;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  };

  // Clamp so the handles can't cross: each side stops at the other.
  const setLow = (raw: number) => {
    const next = Math.min(raw, highValue);
    onChange(next <= min ? null : next, high);
  };

  const setHigh = (raw: number) => {
    const next = Math.max(raw, lowValue);
    onChange(low, next >= max ? null : next);
  };

  const unbounded = low === null && high === null;

  // Elevate active handle's z-index so overlapping handles can always be separated
  const lowZIndex = activeHandle === "low" ? 3 : lowValue >= highValue ? 2 : 1;
  const highZIndex = activeHandle === "high" ? 3 : 1;

  // Handle clicking directly on the track to move the nearest thumb
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const clickPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickVal = min + clickPct * (max - min);

    const distToLow = Math.abs(clickVal - lowValue);
    const distToHigh = Math.abs(clickVal - highValue);

    if (distToLow <= distToHigh) {
      setActiveHandle("low");
      setLow(clickVal);
    } else {
      setActiveHandle("high");
      setHigh(clickVal);
    }
  };

  return (
    <div className={`range-slider${unbounded ? " is-unbounded" : ""}`}>
      <div className="range-slider-head">
        <span className="search-panel-label" id={`${id}-label`}>
          {label}
        </span>
        <span className={`range-slider-value${unbounded ? " is-any" : ""}`}>
          {unbounded
            ? t("common.any")
            : t("common.rangeBetween", { low: low === null ? t("common.any") : format(low), high: high === null ? t("common.any") : format(high) })}
        </span>
      </div>

      <div
        className="range-slider-track"
        onPointerDown={handleTrackPointerDown}
        style={
          {
            "--range-low": `${pct(lowValue)}%`,
            "--range-high": `${pct(highValue)}%`,
          } as React.CSSProperties
        }
      >
        <span className="range-slider-rail" aria-hidden="true" />
        <span className="range-slider-fill" aria-hidden="true" />
        <input
          type="range"
          className={`range-slider-input range-slider-input-low${low === null ? " is-unbounded" : ""}`}
          style={{ zIndex: lowZIndex }}
          min={min}
          max={max}
          step={step}
          value={lowValue}
          aria-label={`${label} minimum`}
          onFocus={() => setActiveHandle("low")}
          onPointerDown={() => setActiveHandle("low")}
          onChange={(e) => {
            setActiveHandle("low");
            setLow(Number(e.target.value));
          }}
        />
        <input
          type="range"
          className={`range-slider-input range-slider-input-high${high === null ? " is-unbounded" : ""}`}
          style={{ zIndex: highZIndex }}
          min={min}
          max={max}
          step={step}
          value={highValue}
          aria-label={`${label} maximum`}
          onFocus={() => setActiveHandle("high")}
          onPointerDown={() => setActiveHandle("high")}
          onChange={(e) => {
            setActiveHandle("high");
            setHigh(Number(e.target.value));
          }}
        />
      </div>
    </div>
  );
}
