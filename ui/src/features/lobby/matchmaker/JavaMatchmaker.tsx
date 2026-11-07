// The Java client's matchmaker, for the Java Client theme.
//
// `team_matchmaking.fxml` and `matchmaking_queue_card.fxml`: under the player
// and the party, one wide search button, and under it the queues as a row of
// toggle buttons, each with its map list button and its three numbers. Same
// state and the same commands as the default layout (MatchmakingPanel owns
// both); only the shape is the Java client's.

import type { MatchmakerQueue, MatchmakingState } from "../../../ipc/bindings";
import { formatClockDuration } from "../../../shared/format/durations";
import { useTranslation } from "../../../i18n/useTranslation";
import type { QueueDisplayState } from "./MatchmakerQueueCard";

/** The queue's name as the Java client prints it: `2v2`, `4v4 Full Share`. */
export function javaQueueName(queue: MatchmakerQueue, t: ReturnType<typeof useTranslation>["t"]): string {
  const size = `${queue.teamSize}v${queue.teamSize}`;
  if (queue.queueName.includes("full_share")) return `${size} ${t("lobby.matchmaker.java.fullShare")}`;
  if (queue.queueName.includes("share_until_death")) return `${size} ${t("lobby.matchmaker.java.noShare")}`;
  return size;
}

interface SearchButtonProps {
  matchmaking: MatchmakingState;
  searching: boolean;
  selfInGame: boolean;
  othersInGame: boolean;
  partyNeedsLeader: boolean;
  queueCount: number;
  disabled: boolean;
  onClick: () => void;
}

/** `.toggle-button.start-search`: what it says is why it can or cannot start. */
export function JavaSearchButton({
  matchmaking,
  searching,
  selfInGame,
  othersInGame,
  partyNeedsLeader,
  queueCount,
  disabled,
  onClick,
}: SearchButtonProps) {
  const { t } = useTranslation();
  const label = searching
    ? t("lobby.matchmaker.java.searchInQueue")
    : matchmaking.type === "matchFound"
      ? t("lobby.matchmaker.java.found")
      : matchmaking.type === "launching"
        ? t("lobby.matchmaker.java.launching")
        : selfInGame
          ? t("lobby.matchmaker.java.searchInGame")
          : othersInGame
            ? t("lobby.matchmaker.java.searchMemberInGame")
            : partyNeedsLeader
              ? t("lobby.matchmaker.java.searchInParty")
              : queueCount === 0
                ? t("lobby.matchmaker.java.searchNoQueue")
                : t("lobby.matchmaker.java.search");
  return (
    <button
      type="button"
      className="java-tmm-search"
      aria-pressed={searching}
      disabled={disabled}
      title={searching ? t("lobby.matchmaker.stopSearching") : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const STATUS_KEY = {
  searching: "lobby.matchmaker.java.searching",
  found: "lobby.matchmaker.java.found",
  launching: "lobby.matchmaker.java.launching",
  cancelled: "lobby.matchmaker.java.cancelled",
} as const;

interface QueueItemProps {
  queue: MatchmakerQueue;
  selected: boolean;
  disabled: boolean;
  incompatible: boolean;
  status: QueueDisplayState;
  activeGames: number;
  secondsUntilPop: number;
  onToggle: () => void;
  onOpenMapPool: () => void;
}

/** One `matchmaking_queue_card.fxml`. */
export function JavaQueueItem({
  queue,
  selected,
  disabled,
  incompatible,
  status,
  activeGames,
  secondsUntilPop,
  onToggle,
  onOpenMapPool,
}: QueueItemProps) {
  const { t } = useTranslation();
  const name = javaQueueName(queue, t);
  return (
    <div className={`java-tmm-queue${incompatible ? " is-incompatible" : ""}`}>
      <button
        type="button"
        className="java-tmm-queue-toggle"
        aria-pressed={selected}
        disabled={disabled}
        title={incompatible ? t("lobby.matchmaker.partyTooLarge") : undefined}
        onClick={onToggle}
      >
        {name}
      </button>
      <button type="button" className="java-tmm-outline java-tmm-map-list" onClick={onOpenMapPool}>
        {t("lobby.matchmaker.java.mapList")}
      </button>
      <p className="java-tmm-queue-facts">
        <span>{t("lobby.matchmaker.java.popTimer", { time: formatClockDuration(secondsUntilPop) })}</span>
        <span>{t("lobby.matchmaker.java.inQueue", { count: queue.numPlayers })}</span>
        <span>{t("lobby.matchmaker.java.activeGames", { count: activeGames })}</span>
      </p>
      {status !== "idle" && (
        <p className={`java-tmm-queue-status is-${status}`} role="status">{t(STATUS_KEY[status])}</p>
      )}
    </div>
  );
}
