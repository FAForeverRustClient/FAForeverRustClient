// The small building blocks of the generator form.

import { useEffect, useState, type ReactNode } from "react";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";

/** One labelled option. The label column is fixed so every control lines up. */
export function Row({
  label,
  hint,
  superseded = false,
  className,
  children,
}: {
  label: string;
  hint?: string;
  /** Dim the row: something else is deciding this value (see the style rows). */
  superseded?: boolean;
  /** Extra class, for a row whose control is taller than one field. */
  className?: string;
  children: ReactNode;
}) {
  const classes = ["generate-map-row"];
  if (superseded) classes.push("is-superseded");
  if (className) classes.push(className);
  return (
    <div className={classes.join(" ")}>
      <span className="generate-map-row-label">{label}</span>
      <div className="generate-map-row-control">
        {children}
        {hint && <small className="generate-map-row-hint">{hint}</small>}
      </div>
    </div>
  );
}

export function GeneratePreviewImg({
  url,
  alt,
  className,
}: {
  url: string | undefined;
  alt: string;
  className: string;
  placeholderClassName?: string;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  return (
    <img
      src={!url || failed ? GENERATED_MAP_PLACEHOLDER_URL : url}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (!failed) setFailed(true);
      }}
    />
  );
}
