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
  /** Overrides the readout for an unbounded endpoint. */
  formatUnbounded?: (side: "low" | "high") => string;
  /** Overrides the readout when both endpoints are unbounded. */
  unboundedLabel?: string;
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
  formatUnbounded,
  unboundedLabel,
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

  const quantize = (val: number) => {
    if (step <= 0) return val;
    const steps = Math.round((val - min) / step);
    const stepped = min + steps * step;
    return Number(stepped.toFixed(10));
  };

  // Clamp so the handles can't cross: each side stops at the other.
  const setLow = (raw: number) => {
    const quantized = quantize(raw);
    const next = Math.min(quantized, highValue);
    onChange(next <= min ? null : next, high);
  };

  const setHigh = (raw: number) => {
    const quantized = quantize(raw);
    const next = Math.max(quantized, lowValue);
    onChange(low, next >= max ? null : next);
  };

  const unbounded = low === null && high === null;
  const lowLabel = low === null ? (formatUnbounded?.("low") ?? t("common.any")) : format(low);
  const highLabel = high === null ? (formatUnbounded?.("high") ?? t("common.any")) : format(high);
  const valueLabel = unbounded
    ? (unboundedLabel ?? t("common.any"))
    : lowLabel === highLabel
      ? lowLabel
      : t("common.rangeBetween", { low: lowLabel, high: highLabel });

  // Keep the active handle above the other one. At the minimum, put the high
  // handle on top so a collapsed range can be expanded by dragging it right.
  const handlesOverlap = lowValue === highValue;
  const lowZIndex =
    activeHandle === "low"
      ? 3
      : activeHandle === "high"
        ? 1
        : handlesOverlap && lowValue >= max
          ? 2
          : 1;
  const highZIndex =
    activeHandle === "high"
      ? 3
      : activeHandle === "low"
        ? 1
        : handlesOverlap && lowValue < max
          ? 2
          : 1;

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
          {valueLabel}
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
