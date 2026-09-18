// The vault's replay list, grouped by day.

import type { VaultReplay } from "../../ipc/bindings";
import { formatShortDate } from "../../shared/format/dates";
import { formatDuration } from "../../shared/format/durations";
import { effectiveReplayMapName } from "../../shared/mapPresentation";
import { replayMapKey, replayMapPresentation } from "./coopReplayMap";
import { useAppStore } from "../../store/store";
import { playerCount } from "./ReplayRoster";
import {
  formatReplayListTime,
  ReplayList,
  type ReplayListGroup,
} from "./ReplayList";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { NO_RESOLVED_MAPS, replayAge } from "./ReplayCard";

export function OnlineReplayList({
  replays,
  groupByDate = true,
  selectedUid,
  watchedUids,
  onOpen,
  onWatch,
  onDownload,
  onToggleWatched,
}: {
  replays: VaultReplay[];
  groupByDate?: boolean;
  selectedUid: number | null;
  watchedUids: Set<number>;
  /** Opens the detail panel, and marks the row selected on the way. */
  onOpen: (uid: number) => void;
  onWatch?: (uid: number) => void;
  /** Saves the `.fafreplay` file, without opening the detail panel first. */
  onDownload?: (uid: number) => void;
  onToggleWatched?: (uid: number) => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  const resolvedMaps = useAppStore((state) => state.state.replays.resolvedMaps ?? NO_RESOLVED_MAPS);
  const localReplays = useAppStore((state) => state.state.replays.local);
  const groups = groupByDate
    ? groupReplaysByDate(replays)
    : [{ label: t("replays.list.results"), replays }];

  const listGroups: ReplayListGroup[] = groups.map((group) => ({
    label: group.label,
    rows: group.replays.map((replay) => {
      const map = effectiveReplayMapName(replay.map, localReplays.find((local) => local.uid === replay.uid)?.map);
      const resolved = resolvedMaps[replay.uid];
      const presentation = replayMapPresentation(vault, missions, { ...replay, map }, resolved);
      return {
        key: String(replay.uid),
        mapName: replayMapKey(missions, { ...replay, map }, resolved),
        mapThumbnailUrl: replay.mapThumbnailUrl,
        game: {
          primary: replay.title || presentation.displayName || map,
          secondary: presentation.displayName || map || t("replays.list.mapUnavailable"),
        },
        played: {
          primary: formatReplayListTime(replay.startTime),
          secondary: replayAge(replay.startTime) || "N/A",
        },
        players: { primary: String(playerCount(replay.teams)) },
        rating: { primary: replay.averageRating === null ? "N/A" : String(replay.averageRating) },
        mod: {
          primary: replay.modName || "faf",
          secondary: replay.reviewsCount
            ? `★ ${replay.reviewsAverage?.toFixed(1) ?? "N/A"} (${replay.reviewsCount})`
            : undefined,
        },
        duration: {
          primary: replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : "N/A",
          secondary: replay.durationSeconds !== null
            ? t("replays.list.realTimeSuffix", { duration: formatDuration(replay.durationSeconds) })
            : t("replays.list.realTimeUnavailable"),
        },
        replay: {
          primary: t(replay.replayAvailable ? "replays.list.available" : "replays.list.processing"),
          secondary: `#${replay.uid}`,
          tone: replay.replayAvailable ? "ok" : "warn",
        },
        selected: selectedUid === replay.uid,
        watched: watchedUids.has(replay.uid),
        // One click opens the replay, the same as a click on the card in the
        // tile view and on a live game. It used to only highlight the row, and
        // the way in was a Details button at the far end of it: the one thing
        // every reader wants from a row was the one thing behind a control
        // they had to aim at. Highlighting still happens, because opening sets
        // the selection too, so the row stays marked once the panel is closed.
        onSelect: () => onOpen(replay.uid),
        onActivate: () => {
          if (onWatch && replay.replayAvailable) onWatch(replay.uid);
          else onOpen(replay.uid);
        },
        // Watch and Download on the row itself, which is what the thread
        // asked for: both were a detail panel away, and both are the reason
        // somebody is looking at the row in the first place. Neither appears
        // for a replay the server has not finished processing, because
        // neither would work.
        iconActions: [
          ...(onWatch && replay.replayAvailable
            ? [{
              icon: "play" as const,
              ariaLabel: t("replays.list.watchAria", { name: replay.title || map }),
              title: t("replays.detail.watch"),
              onClick: () => onWatch(replay.uid),
            }]
            : []),
          ...(onDownload && replay.replayAvailable
            ? [{
              icon: "download" as const,
              ariaLabel: t("replays.list.downloadAria", { name: replay.title || map }),
              title: t("replays.detail.download"),
              onClick: () => onDownload(replay.uid),
            }]
            : []),
          ...(onToggleWatched
            ? [{
              icon: "eye" as const,
              pressed: watchedUids.has(replay.uid),
              ariaLabel: t(watchedUids.has(replay.uid)
                ? "replays.watched.unmarkAria"
                : "replays.watched.markAria", { name: replay.title || map }),
              title: t(watchedUids.has(replay.uid) ? "replays.watched.unmark" : "replays.watched.mark"),
              onClick: () => onToggleWatched(replay.uid),
            }]
            : []),
        ],
      };
    }),
  }));

  return (
    <ReplayList
      groups={listGroups}
      footer={<><span>{t("replays.list.count", { count: replays.length })}</span><span>{t("replays.list.openHint")}</span></>}
    />
  );
}

function groupReplaysByDate(replays: VaultReplay[]): Array<{ label: string; replays: VaultReplay[] }> {
  const groups: Array<{ label: string; replays: VaultReplay[] }> = [];
  for (const replay of replays) {
    const label = formatShortDate(replay.startTime, t("replays.list.unknownDate"));
    const current = groups[groups.length - 1];
    if (current?.label === label) current.replays.push(replay);
    else groups.push({ label, replays: [replay] });
  }
  return groups;
}
