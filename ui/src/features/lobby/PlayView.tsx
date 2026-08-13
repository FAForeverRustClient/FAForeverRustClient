// Play tab — splits into Matchmaker / Custom Games / Co-Op subtabs. The
// sub-view choice is presentation-only, so it's local component state, not
// routed through the backend Nav slice (same posture as MapsView.tsx).

import { useState } from "react";
import { Tabs } from "../../design-system/Tabs";
import { CoOpView } from "./CoOpView";
import { CustomGamesView } from "./CustomGamesView";
import { MatchmakerView } from "./MatchmakerView";

type SubView = "matchmaker" | "custom" | "coop";

const SUB_VIEWS: Record<SubView, { label: string; Component: () => JSX.Element }> = {
  matchmaker: { label: "Matchmaker", Component: MatchmakerView },
  custom: { label: "Custom Games", Component: CustomGamesView },
  coop: { label: "Co-Op", Component: CoOpView },
};

export function PlayView() {
  // Custom Games is the only subtab with a real backend today.
  const [subView, setSubView] = useState<SubView>("custom");
  const { Component } = SUB_VIEWS[subView];

  return (
    <div>
      <Tabs
        tabs={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({
          key,
          label: SUB_VIEWS[key].label,
        }))}
        active={subView}
        onChange={setSubView}
      />
      <Component />
    </div>
  );
}
