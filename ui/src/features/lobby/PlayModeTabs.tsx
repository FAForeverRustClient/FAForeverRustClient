import { SectionTabs, type SectionTab } from "../../design-system/SectionTabs";

export type PlayMode = "custom" | "matchmaking" | "coop";

interface Props {
  mode: PlayMode;
  customGames: number;
  queues: number;
  coopGames: number;
  onChange: (mode: PlayMode) => void;
}

const TABS: Array<{ mode: PlayMode; label: string; count: keyof Pick<Props, "customGames" | "queues" | "coopGames"> }> = [
  { mode: "custom", label: "Play", count: "customGames" },
  { mode: "matchmaking", label: "Matchmaker", count: "queues" },
  { mode: "coop", label: "Coop", count: "coopGames" },
];

export function PlayModeTabs(props: Props) {
  const items: SectionTab<PlayMode>[] = TABS.map((tab) => ({
    id: tab.mode,
    label: tab.label,
    count: props[tab.count],
  }));
  return <SectionTabs active={props.mode} ariaLabel="Play modes" className="play-mode-tabs" items={items} onChange={props.onChange} />;
}
