// The signed-in player's latest matchmaker games, under the queues (#301).
//
// A list of games and nothing else: no streaks and no titles for them, which
// is what the thread settled on. Each row is one game from this player's side:
// the mode, the map, who was on the other team, how it ended and what it did
// to the rating, with the two ways into its replay the vault offers.
//
// Loaded by its own command into its own list, so opening this tab never
// replaces whatever the Replays tab was showing. Drawn as a table like the
// live-replay one, with the same draggable, remembered column widths.

import { useEffect } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { ResizeHandle } from "../../../design-system/ResizeHandle";
import type { ReplayPlayer, VaultMap, VaultReplay } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { useTranslation } from "../../../i18n/useTranslation";
import { formatAgeOrDate } from "../../../shared/format/dates";
import { MapThumbnail } from "../../../shared/components/MapThumbnail";
import { PlayerName } from "../../../shared/components/nameColors";
import { usePlayerMenu } from "../../../shared/hooks/usePlayerMenu";
import { useColumnWidths } from "../../../shared/hooks/useColumnWidths";
import { mapPresentation } from "../../../shared/mapPresentation";
import { tableMinWidth } from "../../../shared/tableColumns";
import { EMPTY_REPLAY_QUERY } from "../../../shared/replayQuery";
import { requestReplaySearch } from "../../../shared/replaySearchIntent";
import { useAppStore } from "../../../store/store";
import { outcomeLabel, parseOutcome } from "../../../shared/gameOutcome";

/** One game from the point of view of the player it was loaded for. */
export interface RecentGameSide {
  me: ReplayPlayer | null;
  /** `1v1`, `2v2`: players per team as they actually played. */
  mode: string;
  opponents: string[];
}

export function recentGameSide(replay: VaultReplay, playerName: string): RecentGameSide {
  const name = playerName.toLocaleLowerCase();
  const own = replay.teams.find((team) => team.players.some((player) => player.name.toLocaleLowerCase() === name));
  const me = own?.players.find((player) => player.name.toLocaleLowerCase() === name) ?? null;
  const others = replay.teams.filter((team) => team !== own);
  const perTeam = own?.players.length ?? replay.teams[0]?.players.length ?? 0;
  return {
    me,
    mode: perTeam > 0 ? `${perTeam}v${perTeam}` : "",
    opponents: others.flatMap((team) => team.players.map((player) => player.name)),
  };
}

function signed(change: number): string {
  return change > 0 ? `+${change}` : String(change);
}

/**
 * The designed widths, in the order the columns are drawn: the map picture,
 * the map, the mode, the other team, when, the result, the rating change and
 * the two replay buttons. The map column is the flexible one and takes what
 * the others leave.
 */
const DEFAULT_COLUMN_PX = [64, 220, 70, 220, 110, 96, 80, 150];
const FLEXIBLE_COLUMN = 1;

export function MatchmakerRecentGames({ playerName, vault }: { playerName: string; vault: VaultMap[] }) {
  const { t } = useTranslation();
  const games = useAppStore((state) => state.state.replays.recentMatchmaker);
  const status = useAppStore((state) => state.state.replays.recentMatchmakerStatus);
  // Draggable like the live-replay table, and remembered like it: a table of
  // its own, so a drag here never moves the live tab's columns.
  const columns = useColumnWidths("matchmakerRecentColumns", DEFAULT_COLUMN_PX, FLEXIBLE_COLUMN);
  const { openPlayerMenu, playerMenu } = usePlayerMenu();

  // Once per visit to the tab, and again for another account.
  useEffect(() => {
    if (!playerName) return;
    ipc.send({ kind: "Replays", command: { type: "loadRecentMatchmaker" } });
  }, [playerName]);

  const openReplay = (uid: number) => {
    requestReplaySearch({ ...EMPTY_REPLAY_QUERY, replayId: String(uid) });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  };

  const columnLabels = [
    t("lobby.matchmaker.recent.column.preview"),
    t("lobby.matchmaker.recent.column.map"),
    t("lobby.matchmaker.recent.column.mode"),
    t("lobby.matchmaker.recent.column.opponents"),
    t("lobby.matchmaker.recent.column.when"),
    t("lobby.matchmaker.recent.column.result"),
    t("lobby.matchmaker.recent.ratingChange"),
    t("lobby.matchmaker.recent.column.replay"),
  ];
  /** The divider in front of a column, trading width with the one before it. */
  const divider = (boundary: number) => (
    <ResizeHandle
      className="matchmaker-recent-col-handle is-ruled"
      label={t("lobby.browser.resizeColumn", { column: columnLabels[boundary] })}
      onDrag={(delta) => columns.onDrag(boundary, delta)}
      onEnd={columns.onCommit}
      onReset={columns.onReset}
    />
  );

  return (
    <section className="matchmaker-card surface-panel matchmaker-recent" aria-labelledby="matchmaker-recent-title">
      <div className="matchmaker-section-copy">
        <div>
          <span className="matchmaker-kicker">{t("lobby.matchmaker.recent.kicker")}</span>
          <h2 id="matchmaker-recent-title">{t("lobby.matchmaker.recent.title")}</h2>
        </div>
      </div>

      {status.type === "failed" ? (
        <p className="muted matchmaker-recent-state">{t("lobby.matchmaker.recent.failed", { reason: status.payload.reason })}</p>
      ) : games.length === 0 ? (
        <p className="muted matchmaker-recent-state">
          {status.type === "loading" || status.type === "idle" ? t("lobby.matchmaker.recent.loading") : t("lobby.matchmaker.recent.empty")}
        </p>
      ) : (
        <div className="matchmaker-recent-table-wrap">
          <table className="matchmaker-recent-table" style={{ minWidth: `${tableMinWidth(columns.widths)}px` }}>
            <colgroup>
              {columns.widths.map((width, index) =>
                index === FLEXIBLE_COLUMN
                  ? <col key={columnLabels[index]} />
                  : <col key={columnLabels[index]} style={{ width: `${width}px` }} />,
              )}
            </colgroup>
            <thead>
              <tr>
                <th className="matchmaker-recent-preview-column" aria-label={columnLabels[0]} />
                {columnLabels.slice(1).map((label, offset) => (
                  <th key={label}>
                    {divider(offset + 1)}
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {games.map((game) => {
                const side = recentGameSide(game, playerName);
                const outcome = parseOutcome(side.me?.outcome ?? "");
                const change = side.me?.ratingChange ?? null;
                const mapName = mapPresentation(vault, game.map).displayName;
                return (
                  <tr key={game.uid} className="matchmaker-recent-row">
                    <td>
                      <MapThumbnail
                        mapName={game.map}
                        vault={vault}
                        url={game.mapThumbnailUrl || null}
                        className="matchmaker-recent-thumb"
                        placeholderClassName="matchmaker-recent-thumb matchmaker-recent-thumb-empty"
                      />
                    </td>
                    <td className="matchmaker-recent-map" title={mapName}>{mapName}</td>
                    <td className="matchmaker-recent-mode">{side.mode}</td>
                    <td className="matchmaker-recent-opponents" title={side.opponents.join(", ")}>
                      {/* Each name as the rest of the client draws it: the
                          reader's friend, foe and custom colours, and the
                          same right-click menu as a replay lineup. */}
                      {side.opponents.map((name, index) => (
                        <span key={name} onContextMenu={(event) => openPlayerMenu(name, event)}>
                          {index > 0 && ", "}
                          <PlayerName name={name} />
                        </span>
                      ))}
                    </td>
                    <td className="muted">{formatAgeOrDate(game.startTime)}</td>
                    <td className={`matchmaker-recent-outcome${outcome ? ` is-${outcome}` : ""}`}>
                      {outcomeLabel(side.me?.outcome ?? "") || t("lobby.matchmaker.recent.noResult")}
                    </td>
                    <td className={`matchmaker-recent-change${change === null ? "" : change >= 0 ? " is-up" : " is-down"}`}>
                      {change === null ? "" : signed(change)}
                    </td>
                    <td>
                      <span className="matchmaker-recent-actions">
                        <Button
                          disabled={!game.replayAvailable}
                          title={game.replayAvailable ? undefined : t("lobby.matchmaker.recent.notYetAvailable")}
                          onClick={() => ipc.send({ kind: "Replays", command: { type: "watchVault", payload: { uid: game.uid } } })}
                        >
                          <Icon name="play" size={13} /> {t("lobby.matchmaker.recent.watch")}
                        </Button>
                        <Button onClick={() => openReplay(game.uid)} aria-label={t("lobby.matchmaker.recent.openAria", { id: game.uid })}>
                          <Icon name="replays" size={13} />
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {playerMenu}
    </section>
  );
}
