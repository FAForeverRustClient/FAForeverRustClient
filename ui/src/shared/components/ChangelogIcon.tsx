import { useState } from "react";
import { changelogUnitIconId, changelogUnitIconUrl } from "../changelogUnitIcons";
import { useUnitIcons } from "../useUnitIcons";

/** Prefer the installed game's cached picture; keep the original web artwork
 * for missing installs and failed local pictures. Body and contents share it. */
export function ChangelogIcon({ source, className, size, title }: {
  source: string; className: string; size: number; title?: string;
}) {
  const unitId = changelogUnitIconId(source);
  const icons = useUnitIcons(unitId !== null);
  const remote = changelogUnitIconUrl(source);
  const local = unitId ? icons?.units[unitId] : undefined;
  const [failure, setFailure] = useState<{ source: string; local: boolean; remote: boolean } | null>(null);
  const currentFailure = failure?.source === source ? failure : null;
  // Wait only for the small local catalogue, not for pictures or the article.
  // Starting the remote request first would download images just to replace them.
  const url = unitId && !icons ? undefined : local && !currentFailure?.local ? local : remote;
  const missing = url === remote && currentFailure?.remote;
  return <img
    key={url}
    src={url}
    alt=""
    title={title}
    width={size}
    height={size}
    className={`${className}${missing ? " is-missing" : ""}`}
    loading="lazy"
    decoding="async"
    draggable={false}
    onLoad={() => setFailure(current => current?.source === source && current.remote ? { ...current, remote: false } : current)}
    onError={() => setFailure({ source, local: true, remote: url === remote })}
  />;
}
