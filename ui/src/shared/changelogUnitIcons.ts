// Legacy balance-note PNGs can include strategic or status badges in their
// corners. These verified artwork matches use the existing clean FAF icons;
// identities come from the pictures, never inferred from arbitrary captions.
// Keep unknown sources and enhancement/category artwork unchanged.

const LEGACY_ICON_BASE = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/";
const CLEAN_ICON_BASE = "https://faforever.github.io/fa/assets/icons";

const CLEAN_UNIT_ICONS: Readonly<Record<string, string>> = {
  "Cybran_T2_Land_Factory_HQ.png": "URB0201",
  "Cybran_T2_Static_Shield_L4.png": "URB4206",
  "Cybran_T3_Land_Factory_HQ.png": "URB0301",
  "Cybran_T3_Naval_Factory.png": "URB0303",
  "Sera_T1_Arty.png": "XSL0103",
  "Sera_T2_Land_Factory_HQ.png": "XSB0201",
  "Sera_T3_Land_Factory_HQ.png": "XSB0301",
  "UEF_T1_Mass_Storage.png": "UEB1106",
  "UEF_T2_Field_Engineer.png": "XEL0209",
  "UEF_T2_Naval_Factory.png": "UEB0203",
  "UEF_T2_Shield_Boat.png": "XES0205",
  "UEF_T3_Mass_Fabricator.png": "UEB1303",
  "UEF_T3_Mobile_Arty.png": "UEL0304",
  "UEF_T3_PD.png": "XEB2306",
  "aurora.png": "UAL0201",
  "chickenbot.png": "XSL0202",
  "corsair.png": "DRA0202",
  "cybranT2StaticArty.png": "URB2303",
  "cybranT3StaticArty.png": "URB2302",
  "cybranairstaging.png": "URB5202",
  "cybrancom.png": "URL0001",
  "cybranfacto.png": "URB0101",
  "cybranscu.png": "URL0301",
  "demolisher.png": "UEL0304",
  "duke.png": "UEB2302",
  "ed5shield.png": "URB4207",
  "eyeofrhianne.png": "XAB3301",
  "fatboy.png": "UEL0401",
  "hiveT1.png": "XRB0104",
  "hiveT2.png": "XRB0204",
  "hiveT3.png": "XRB0304",
  "hoverflak.png": "XSL0205",
  "hydro.png": "URB1102",
  "janus.png": "DEA0202",
  "kennelT2.png": "XEB0104",
  "kennelT3.png": "XEB0204",
  "lobo.png": "UEL0103",
  "nukelauncher.png": "URB2305",
  "nukesub.png": "UES0304",
  "quantumgate.png": "UEB0304",
  "renegade.png": "URA0203",
  "restorer.png": "XAA0305",
  "scathis.png": "URL0401",
  "seraT2StaticArty.png": "XSB2303",
  "seraT3StaticArty.png": "XSB2302",
  "seracom.png": "XSL0001",
  "serafacto.png": "XSB0101",
  "serahover.png": "XSL0203",
  "serat1maa.png": "XSL0104",
  "serat2mex.png": "XSB1202",
  "serat3mobileshield.png": "XSL0307",
  "seratorp.png": "XSA0204",
  "solace.png": "XAA0306",
  "staticflak.png": "XSB2204",
  "summit.png": "UES0302",
  "t2landhq.png": "UAB0201",
  "t2naval.png": "XSB0203",
  "t2navalhq.png": "URB0203",
  "t2sonar.png": "UEB3202",
  "t3hq.png": "URB0301",
  "t3landhq.png": "URB0301",
  "t3navalhq.png": "UEB0303",
  "t3sonar.png": "UES0305",
  "t3sub.png": "XSS0304",
  "tml.png": "UEB2108",
  "uefT2StaticArty.png": "UEB2303",
  "uefT3StaticArty.png": "UEB2302",
  "uefdestro.png": "UES0201",
  "uefhover.png": "UEL0203",
  "uefscu.png": "UEL0301",
  "ueft3shield.png": "UEB4301",
  "wall.png": "UEB5101",
  "ythotha.png": "XSL0401",
};

/** Shared by article pictures, historical captions and contents thumbnails. */
export function changelogUnitIconUrl(source: string): string {
  if (!source.startsWith(LEGACY_ICON_BASE)) return source;
  const path = source.slice(LEGACY_ICON_BASE.length);
  return Object.prototype.hasOwnProperty.call(CLEAN_UNIT_ICONS, path)
    ? `${CLEAN_ICON_BASE}/${CLEAN_UNIT_ICONS[path]}_icon.png`
    : source;
}

/** Only the known clean icon source identifies a local unit picture. Captions
 * and unrelated URLs must not be used to guess an artwork replacement. */
export function changelogUnitIconId(source: string): string | null {
  const clean = changelogUnitIconUrl(source);
  if (!clean.startsWith(`${CLEAN_ICON_BASE}/`)) return null;
  return /^([A-Z]{3}\d{4})_icon\.png$/.exec(clean.slice(CLEAN_ICON_BASE.length + 1))?.[1] ?? null;
}
