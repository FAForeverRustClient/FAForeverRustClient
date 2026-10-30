// Units tab: embeds the community ETFreeman unit database directly
// (https://unitdb.faforever.com/#/, formerly faforever.github.io/etfreeman-db,
// which now answers with a redirect the frame CSP would block) rather than reimplementing
// its UI: it already has every feature (search, filters, comparisons,
// weapon/projectile detail) and matching its visual polish exactly is only
// achievable by using the real thing. No custom parsing/state on our side,
// this tab is presentation-only: a frame and the way out of it.

import { EmbeddedSite } from "../../shared/components/EmbeddedSite";
import { useTranslation } from "../../i18n/useTranslation";

const ETFREEMAN_URL = "https://unitdb.faforever.com/#/";

export function UnitsView() {
  const { t } = useTranslation();
  return <EmbeddedSite url={ETFREEMAN_URL} title={t("units.frameTitle")} />;
}
