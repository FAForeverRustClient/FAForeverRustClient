import { SectionTabs, type SectionTab } from "../../design-system/SectionTabs";

export type PlayMode = "custom" | "matchmaking" | "coop" | "galacticWar";

interface Props {
  mode: PlayMode;
  customGames: number;
  queues: number;
  coopGames: number;
  /** Players online in Galactic War, as its gateway last reported. */
  galacticWarOnline: number;
  onChange: (mode: PlayMode) => void;
}

const TABS: Array<{
  mode: PlayMode;
  label: string;
  count: keyof Pick<Props, "customGames" | "queues" | "coopGames" | "galacticWarOnline">;
}> = [
  { mode: "custom", label: "Play", count: "customGames" },
  { mode: "matchmaking", label: "Matchmaker", count: "queues" },
  { mode: "coop", label: "Coop", count: "coopGames" },
  { mode: "galacticWar", label: "Galactic War", count: "galacticWarOnline" },
];

export function PlayModeTabs(props: Props) {
  const items: SectionTab<PlayMode>[] = TABS.map((tab) => ({
    id: tab.mode,
    label: tab.label,
    count: props[tab.count],
  }));
  return <SectionTabs active={props.mode} ariaLabel="Play modes" className="play-mode-tabs" items={items} onChange={props.onChange} />;
}
