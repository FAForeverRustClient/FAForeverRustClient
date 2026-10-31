import { useState } from "react";
import { changelogUnitIconBackground, changelogUnitIconId, changelogUnitIconUrl } from "../changelogUnitIcons";
import { useUnitIcons } from "../useUnitIcons";
import "./changelog-icon.css";

/** Prefer the installed game's cached picture; keep the original web artwork
 * for missing installs and failed local pictures. Body and contents share it. */
export function ChangelogIcon({ source, className, size, title, loading = "lazy" }: {
  source: string; className: string; size: number; title?: string; loading?: "eager" | "lazy";
}) {
  const unitId = changelogUnitIconId(source);
  const background = changelogUnitIconBackground(source);
  const icons = useUnitIcons(unitId !== null);
  const remote = changelogUnitIconUrl(source);
  const local = unitId ? icons?.units[unitId] : undefined;
  const [failure, setFailure] = useState<{ source: string; local: boolean; remote: boolean } | null>(null);
  const currentFailure = failure?.source === source ? failure : null;
  // Wait only for the small local catalogue, not for pictures or the article.
  // Starting the remote request first would download images just to replace them.
  const url = unitId && !icons ? undefined : local && !currentFailure?.local ? local : remote;
  const [loadedUrl, setLoadedUrl] = useState<string | undefined>(undefined);
  // Until there is a picture to draw, a quiet tile of the picture's size. An
  // image with no source and a tooltip is drawn by the browser as an empty
  // framed box, which is what a reader saw meanwhile. A picture still arriving
  // keeps the tile's fill underneath it.
  if (url === undefined) {
    return <span className={`${className} changelog-icon-pending`} aria-hidden="true" />;
  }
  const loaded = loadedUrl === url;
  const frame = local && url === local && background ? ` changelog-icon-background changelog-icon-background-${background}` : "";
  const missing = url === remote && currentFailure?.remote;
  return <img
    key={url}
    src={url}
    alt=""
    title={title}
    width={size}
    height={size}
    className={`${className}${frame}${missing ? " is-missing" : ""}${loaded ? "" : " changelog-icon-loading"}`}
    loading={loading}
    decoding="async"
    draggable={false}
    onLoad={() => {
      setLoadedUrl(url);
      setFailure(current => current?.source === source && current.remote ? { ...current, remote: false } : current);
    }}
    onError={() => setFailure({ source, local: true, remote: url === remote })}
  />;
}
