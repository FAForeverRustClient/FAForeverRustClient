import { SectionTabs, type SectionTab } from "../../design-system/SectionTabs";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

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
  label: MessageKey;
  count: keyof Pick<Props, "customGames" | "queues" | "coopGames" | "galacticWarOnline">;
}> = [
  { mode: "custom", label: "lobby.mode.custom", count: "customGames" },
  { mode: "matchmaking", label: "lobby.mode.matchmaking", count: "queues" },
  { mode: "coop", label: "lobby.mode.coop", count: "coopGames" },
  { mode: "galacticWar", label: "lobby.mode.galacticWar", count: "galacticWarOnline" },
];

export function PlayModeTabs(props: Props) {
  const { t } = useTranslation();
  const items: SectionTab<PlayMode>[] = TABS.map((tab) => ({
    id: tab.mode,
    label: t(tab.label),
    count: props[tab.count],
  }));
  return <SectionTabs active={props.mode} ariaLabel={t("lobby.mode.aria")} className="play-mode-tabs" items={items} onChange={props.onChange} />;
}
