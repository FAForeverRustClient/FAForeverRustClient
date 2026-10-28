// Units tab: embeds the community ETFreeman unit database directly
// (https://unitdb.faforever.com/#/, formerly faforever.github.io/etfreeman-db,
// which now answers with a redirect the frame CSP would block) rather than reimplementing
// its UI: it already has every feature (search, filters, comparisons,
// weapon/projectile detail) and matching its visual polish exactly is only
// achievable by using the real thing. No custom parsing/state on our side,
// this tab is presentation-only: a frame and the way out of it.
//
// Beside it, FAF Daily (https://daily.faforever.com, FAForever/daily): guess
// the day's unit, hosted by FAF since October 2026 (issue 626). The same kind
// of page about the same units, so a second view of this tab rather than a tab
// of its own.

import { useState } from "react";
import { SectionTabs, sectionPanelProps } from "../../design-system/SectionTabs";
import { EmbeddedSite } from "../../shared/components/EmbeddedSite";
import { useTranslation } from "../../i18n/useTranslation";
import "./units.css";

const ETFREEMAN_URL = "https://unitdb.faforever.com/#/";
const DAILY_URL = "https://daily.faforever.com/";

type UnitsSection = "database" | "daily";

/** The view last shown, so coming back to the tab lands on it. */
let lastSection: UnitsSection = "database";

export function UnitsView() {
  const { t } = useTranslation();
  const [section, setSection] = useState<UnitsSection>(lastSection);
  const choose = (next: UnitsSection) => {
    lastSection = next;
    setSection(next);
  };
  return (
    <div className="units-view">
      <SectionTabs
        className="units-section-tabs"
        active={section}
        ariaLabel={t("units.views")}
        items={[
          { id: "database", label: t("units.tab.database") },
          { id: "daily", label: t("units.tab.daily") },
        ]}
        onChange={choose}
        idPrefix="units-section"
      />
      <div className="units-panel" {...sectionPanelProps("units-section", section)}>
        {section === "database" ? (
          <EmbeddedSite url={ETFREEMAN_URL} title={t("units.frameTitle")} />
        ) : (
          <EmbeddedSite url={DAILY_URL} title={t("units.dailyFrameTitle")} />
        )}
      </div>
    </div>
  );
}
