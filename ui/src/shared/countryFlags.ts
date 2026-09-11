/** Static country assets shared by chat and player surfaces. */
export const flagSrc = (country: string): string => {
  const code = country.trim().toLowerCase();
  if (!/^[a-z0-9]{2}$/.test(code) || code === "a1" || code === "a2") {
    return "/flags/earth.png";
  }
  return `/flags/${code}.png`;
};

// `Intl.DisplayNames` is not free to construct, and a games list redraws a few
// hundred flags at a time. One instance per locale, built on first use.
const nameFormatters = new Map<string, Intl.DisplayNames | null>();

function formatterFor(tag: string): Intl.DisplayNames | null {
  const cached = nameFormatters.get(tag);
  if (cached !== undefined) return cached;
  let formatter: Intl.DisplayNames | null = null;
  try {
    // `fallback: "none"` so an unknown code answers `undefined` rather than
    // handing back the code itself, which would put "XY" in a tooltip that is
    // supposed to say what "XY" means.
    formatter = new Intl.DisplayNames([tag], { type: "region", fallback: "none" });
  } catch {
    // An environment without region display names. The caller falls back to
    // the code, which is what the tooltips showed before.
  }
  nameFormatters.set(tag, formatter);
  return formatter;
}

/**
 * The country's name in the user's language, or `""` where the code names no
 * country.
 *
 * From `Intl` rather than a table in the repo: the six catalogues would each
 * need 250 entries, they would go stale, and the platform already has them
 * translated. `A1` and `A2` are GeoIP's "anonymous proxy" and "satellite
 * provider", not places, and they get the same neutral treatment here as they
 * get from [`flagSrc`].
 */
export const countryName = (country: string, intlTag: string): string => {
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "A1" || code === "A2") {
    return "";
  }
  return formatterFor(intlTag)?.of(code) ?? "";
};

/**
 * What to show when hovering a flag: the country's name where there is one,
 * and otherwise the bare code, which is still better than an empty tooltip.
 */
export const countryLabel = (country: string, intlTag: string): string =>
  countryName(country, intlTag) || country.trim().toUpperCase();
