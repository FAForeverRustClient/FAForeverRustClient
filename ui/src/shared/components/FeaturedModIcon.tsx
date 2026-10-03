import type { CSSProperties } from "react";
import "./featured-mod-icon.css";

interface Props {
  modId: string;
  className?: string;
  /**
   * Paint the mark in the current text colour instead of drawing the file as
   * it is. The files are white, which disappears on a light theme; as a mask
   * the mark takes whatever colour its surroundings give it, the way the FAF
   * wordmark does.
   */
  tint?: boolean;
}

// Marks for supported primary featured mods.
const FEATURED_MOD_ASSETS: Record<string, string> = {
  faf: "/assets/featured-mods/faf.svg",
  fafbeta: "/assets/featured-mods/fafbeta.svg",
  fafdevelop: "/assets/featured-mods/fafdevelop.svg",
  nomads: "/assets/featured-mods/nomads.svg",
};

export function FeaturedModIcon({ modId, className, tint = false }: Props) {
  const asset = FEATURED_MOD_ASSETS[modId];
  if (!asset) {
    return null;
  }

  if (tint) {
    return (
      <span
        className={className ? `featured-mod-icon-tinted ${className}` : "featured-mod-icon-tinted"}
        style={{ "--featured-mod-icon": `url("${asset}")` } as CSSProperties}
        aria-hidden="true"
      />
    );
  }

  return (
    <img
      src={asset}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
    />
  );
}
