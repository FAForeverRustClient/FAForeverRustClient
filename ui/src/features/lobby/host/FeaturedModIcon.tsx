interface Props {
  modId: string;
  className?: string;
}

// Marks for supported primary featured mods.
const FEATURED_MOD_ASSETS: Record<string, string> = {
  faf: "/assets/featured-mods/faf.svg",
  fafbeta: "/assets/featured-mods/fafbeta.svg",
  fafdevelop: "/assets/featured-mods/fafdevelop.svg",
  nomads: "/assets/featured-mods/nomads.svg",
};

export function FeaturedModIcon({ modId, className }: Props) {
  const asset = FEATURED_MOD_ASSETS[modId];
  if (!asset) {
    return null;
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
