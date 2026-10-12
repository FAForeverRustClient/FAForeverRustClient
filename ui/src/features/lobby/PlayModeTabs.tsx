import { SectionTabs, sectionPanelProps, type SectionTab } from "../../design-system/SectionTabs";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

export type PlayMode = "custom" | "matchmaking" | "coop" | "galacticWar";

/** Ties the mode tabs to the panel under them, for assistive technology. */
const PLAY_MODE_TABS_ID = "play-mode";

/** What a mode's panel spreads on its outermost element to be that tab's panel. */
export type PlayModePanelProps = ReturnType<typeof sectionPanelProps>;

/**
 * The id, role and label that make a mode's panel the one its tab controls.
 *
 * Spread on the panel's own outermost element rather than on a wrapper: every
 * mode's panel is a grid or a flex column sized as a child of the Play view,
 * and a box around it would be the child instead and undo that sizing.
 */
export function playModePanelProps(mode: PlayMode): PlayModePanelProps {
  return sectionPanelProps(PLAY_MODE_TABS_ID, mode);
}

interface Props {
  mode: PlayMode;
  customGames: number;
  /** Players searching right now, summed over the queues. Not the queue count. */
  queuedPlayers: number;
  coopGames: number;
  /** Players online in Galactic War, as its gateway last reported. */
  galacticWarOnline: number;
  onChange: (mode: PlayMode) => void;
}

const TABS: Array<{
  mode: PlayMode;
  label: MessageKey;
  count: keyof Pick<Props, "customGames" | "queuedPlayers" | "coopGames" | "galacticWarOnline">;
}> = [
  { mode: "custom", label: "lobby.mode.custom", count: "customGames" },
  { mode: "matchmaking", label: "lobby.mode.matchmaking", count: "queuedPlayers" },
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
  return (
    <SectionTabs
      active={props.mode}
      ariaLabel={t("lobby.mode.aria")}
      className="play-mode-tabs"
      idPrefix={PLAY_MODE_TABS_ID}
      items={items}
      onChange={props.onChange}
    />
  );
}
