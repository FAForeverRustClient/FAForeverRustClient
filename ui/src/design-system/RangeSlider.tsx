// RangeSlider primitive — a dual-handle rating range. Read-only (no
// `onChange`) renders a static fill between `min`/`max` for the detail panel;
// passing `onChange` makes it interactive (two overlapping native range
// inputs — the standard dependency-free dual-slider technique) for the host
// dialog's desired-rating fields.

interface RangeSliderProps {
  bounds?: [number, number];
  min: number | null;
  max: number | null;
  onChange?: (min: number | null, max: number | null) => void;
}

export function RangeSlider({ bounds = [0, 3000], min, max, onChange }: RangeSliderProps) {
  const [lo, hi] = bounds;
  const lowVal = min ?? lo;
  const highVal = max ?? hi;
  const pctLow = ((lowVal - lo) / (hi - lo)) * 100;
  const pctHigh = ((highVal - lo) / (hi - lo)) * 100;

  return (
    <div className="range-slider">
      <div className="range-slider-track">
        <div
          className="range-slider-fill"
          style={{ left: `${pctLow}%`, width: `${pctHigh - pctLow}%` }}
        />
      </div>
      {onChange && (
        <>
          <input
            type="range"
            className="range-slider-input"
            min={lo}
            max={hi}
            value={lowVal}
            onChange={(e) => onChange(Math.min(Number(e.target.value), highVal), max)}
          />
          <input
            type="range"
            className="range-slider-input"
            min={lo}
            max={hi}
            value={highVal}
            onChange={(e) => onChange(min, Math.max(Number(e.target.value), lowVal))}
          />
        </>
      )}
      <div className="range-slider-labels muted">
        <span>{min ?? "Any"}</span>
        <span>{max ?? "Any"}</span>
      </div>
    </div>
  );
}
