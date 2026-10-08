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

import { useEffect, useRef, useState } from "react";
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
import { useListColumns } from "../../../shared/hooks/useListColumns";
import { mapPresentation } from "../../../shared/mapPresentation";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { requestPlayerCardTab } from "../../../shared/playerCardTabIntent";
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
 * Asks for the list again. The same command on the tab's first visit and on
 * Retry, so a retried load is answered exactly like the first one.
 */
function loadRecentGames() {
  ipc.send({ kind: "Replays", command: { type: "loadRecentMatchmaker" } });
}

/**
 * The designed widths, in the order the columns are drawn: the map picture,
 * the map, the mode, the other team, when, the result, the rating change and
 * the two replay buttons. The map column is the flexible one and takes what
 * the others leave.
 */
const DEFAULT_COLUMN_PX = [64, 220, 70, 220, 110, 96, 80, 150];
const FLEXIBLE_COLUMN = 1;

/**
 * The narrowest each column is drawn, in the same order. The map and the
 * opponents are what tell one game from another, so they keep a readable
 * name: cut to "Set..." and "Op..." at 1280 pixels with the party chat open,
 * as they were, a list of five games read as five copies of one. The room
 * comes from the replay column, which narrower than its designed width draws
 * Watch and the vault button as two 28 pixel icon buttons (see
 * `compactActions`) rather than keeping Watch's label at the names' expense.
 * The picture keeps its 44 pixel thumbnail, the result a whole "Victory", the
 * mode and the rating change ("+18" in tabular figures) their few characters,
 * the time its first ones. Together these fit that 1280 pixel window, where
 * the table has about 478 pixels.
 */
const COLUMN_FLOOR_PX = [60, 88, 36, 80, 40, 56, 42, 76];

/** The replay buttons' column, in designed order. */
const REPLAY_COLUMN = 7;

export function MatchmakerRecentGames({ playerName, vault }: { playerName: string; vault: VaultMap[] }) {
  const { t } = useTranslation();
  const games = useAppStore((state) => state.state.replays.recentMatchmaker);
  const status = useAppStore((state) => state.state.replays.recentMatchmakerStatus);
  // Widths, order and reset as every list view has them: see
  // `useListColumns`. Stored on its own, so a drag here never moves the live
  // tab's columns.
  const headerRef = useRef<HTMLTableRowElement | null>(null);
  const list = useListColumns({
    widthsField: "matchmakerRecentColumns",
    orderField: "matchmakerRecentOrder",
    defaults: DEFAULT_COLUMN_PX,
    flexible: FLEXIBLE_COLUMN,
    floors: COLUMN_FLOOR_PX,
    headerRef,
  });
  const { order, moving, widths: columns } = list;
  // Watch keeps its label only at the replay column's designed width, which
  // is what its longer translations were sized for. Narrower, whether the
  // window squeezed it or a divider did, both buttons are icons, and Watch's
  // name stays in its tooltip and for a screen reader.
  const compactActions = columns.drawn[REPLAY_COLUMN] < DEFAULT_COLUMN_PX[REPLAY_COLUMN];
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu();
  // The game whose row the player menu was opened from. The menu does not
  // print the name it is about and opens under the pointer, which has left the
  // row by then, so the row stays looking hovered and the name it was opened
  // on stays marked, as the chat roster does. Kept per game rather than per
  // name: the same opponent can be in several rows, and only one of them is
  // the row the menu came from.
  const [menuGame, setMenuGame] = useState<number | null>(null);
  const menuGameOpen = playerMenuTarget === null ? null : menuGame;

  // Once per visit to the tab, and again for another account.
  useEffect(() => {
    if (!playerName) return;
    loadRecentGames();
  }, [playerName]);

  const openReplay = (uid: number) => {
    requestReplaySearch({ ...EMPTY_REPLAY_QUERY, replayId: String(uid) });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  };

  /** The signed-in player's own card, opened straight on its Results tab. */
  const openOwnResults = () => {
    requestPlayerCardTab("results");
    void openPlayerCard(null, playerName);
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
  /**
   * The divider in front of the column drawn at `position`. It trades width
   * between the two columns either side of it on screen and names the one
   * that grows as it is dragged right: the one drawn before it, unless that is
   * the map column, which has no width of its own to name.
   */
  const divider = (position: number) => {
    const column = order[position];
    const before = order[position - 1];
    return (
      <ResizeHandle
        className="matchmaker-recent-col-handle is-ruled"
        label={t("lobby.browser.resizeColumn", {
          column: columnLabels[before === FLEXIBLE_COLUMN ? column : before],
        })}
        onStart={columns.onStart}
        onDrag={(delta) => columns.onDrag(position, delta)}
        onEnd={columns.onCommit}
        onReset={list.reset}
      />
    );
  };
  const moveHint = t("lobby.browser.moveColumn");

  const profileLink = playerName && (
    <Button onClick={openOwnResults} title={t("lobby.matchmaker.recent.openResultsHint")}>
      {t("lobby.matchmaker.recent.openResults")}
    </Button>
  );

  // Nothing to list yet (loading, none played, or the load failed): one slim
  // line rather than the full card. A kicker, a heading, a button and a
  // sentence of state took a card's height to say "no games", under the
  // queues where the space matters.
  if (games.length === 0) {
    const state = status.type === "failed"
      ? t("lobby.matchmaker.recent.failed", { reason: status.payload.reason })
      : status.type === "loading" || status.type === "idle"
        ? t("lobby.matchmaker.recent.loading")
        : t("lobby.matchmaker.recent.empty");
    return (
      <section
        className="matchmaker-card surface-panel matchmaker-recent is-compact"
        aria-labelledby="matchmaker-recent-title"
      >
        <h2 id="matchmaker-recent-title">{t("lobby.matchmaker.recent.title")}</h2>
        {/* The state is what gives way on a narrow line, so the whole of it,
            the failure's reason included, is on hover. */}
        <p
          className="muted matchmaker-recent-state"
          role={status.type === "failed" ? "alert" : undefined}
          title={state}
        >
          {state}
        </p>
        {/* Next to the failure it answers. Without it the only way to ask
            again was to leave the tab and come back. */}
        {status.type === "failed" && <Button onClick={loadRecentGames}>{t("common.retry")}</Button>}
        {profileLink}
      </section>
    );
  }

  return (
    <section className="matchmaker-card surface-panel matchmaker-recent" aria-labelledby="matchmaker-recent-title">
      <div className="matchmaker-section-copy">
        <div>
          <span className="matchmaker-kicker">{t("lobby.matchmaker.recent.kicker")}</span>
          <h2 id="matchmaker-recent-title">{t("lobby.matchmaker.recent.title")}</h2>
        </div>
        {/* The short list here is the last few games; the profile's Results
            tab is the whole history, with the queue and the rating change per
            game. One click across rather than two (issue 361). */}
        {profileLink}
      </div>

      {/* A reload that failed after an earlier one listed games, such as on a
          later visit to the tab: the store keeps the old list, and this card
          says why it is not showing it, with the same way to ask again as the
          slim line. */}
      {status.type === "failed" ? (
        <div className="matchmaker-recent-failed">
          <p className="muted matchmaker-recent-state" role="alert">
            {t("lobby.matchmaker.recent.failed", { reason: status.payload.reason })}
          </p>
          <Button onClick={loadRecentGames}>{t("common.retry")}</Button>
        </div>
      ) : (
        <div className="matchmaker-recent-table-wrap">
          <table className="matchmaker-recent-table" ref={columns.containerRef}>
            <colgroup>
              {order.map((column) =>
                column === FLEXIBLE_COLUMN
                  ? <col key={column} />
                  : <col key={column} style={{ width: `${columns.drawn[column]}px` }} />,
              )}
            </colgroup>
            <thead>
              {/* The cells in the stored order, as the live table draws its
                  own; each says which column it is, which is how a drag
                  finds them. Every one is a keyboard stop, so Alt and an
                  arrow key move it. */}
              <tr className={`list-head${moving !== null ? " is-moving" : ""}`} ref={headerRef}>
                {order.map((column, position) => (
                  <th
                    key={column}
                    {...list.cell(column)}
                    data-column={column}
                    tabIndex={0}
                    title={moveHint}
                    className={[
                      column === 0 ? "matchmaker-recent-preview-column" : "",
                      moving === column ? "is-moving" : "",
                    ].filter(Boolean).join(" ") || undefined}
                    aria-label={column === 0 ? columnLabels[0] : undefined}
                  >
                    {position > 0 && divider(position)}
                    {column === 0 ? null : columnLabels[column]}
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
                // In designed order here, drawn in the stored one.
                const cells = [
                  <td key={0}>
                    <MapThumbnail
                      mapName={game.map}
                      vault={vault}
                      url={game.mapThumbnailUrl || null}
                      className="matchmaker-recent-thumb"
                      placeholderClassName="matchmaker-recent-thumb matchmaker-recent-thumb-empty"
                    />
                  </td>,
                  <td key={1} className="matchmaker-recent-map" title={mapName}>{mapName}</td>,
                  <td key={2} className="matchmaker-recent-mode">{side.mode}</td>,
                  <td key={3} className="matchmaker-recent-opponents" title={side.opponents.join(", ")}>
                    {/* Each name as the rest of the client draws it: the
                        reader's friend, foe and custom colours, and the
                        same right-click menu as a replay lineup. */}
                    {side.opponents.map((name, index) => (
                      <span
                        key={name}
                        onContextMenu={(event) => {
                          setMenuGame(game.uid);
                          openPlayerMenu(name, event);
                        }}
                      >
                        {index > 0 && ", "}
                        <PlayerName
                          name={name}
                          className={menuGameOpen === game.uid && playerMenuTarget === name
                            ? "matchmaker-recent-opponent is-menu-open"
                            : "matchmaker-recent-opponent"}
                        />
                      </span>
                    ))}
                  </td>,
                  <td key={4} className="muted">{formatAgeOrDate(game.startTime)}</td>,
                  <td key={5} className={`matchmaker-recent-outcome${outcome ? ` is-${outcome}` : ""}`}>
                    {outcomeLabel(side.me?.outcome ?? "") || t("lobby.matchmaker.recent.noResult")}
                  </td>,
                  <td key={6} className={`matchmaker-recent-change${change === null ? "" : change >= 0 ? " is-up" : " is-down"}`}>
                    {change === null ? "" : signed(change)}
                  </td>,
                  <td key={7} className="matchmaker-recent-replay">
                    <span className={`matchmaker-recent-actions${compactActions ? " is-compact" : ""}`}>
                      <Button
                        disabled={!game.replayAvailable}
                        aria-label={compactActions ? t("lobby.matchmaker.recent.watch") : undefined}
                        title={game.replayAvailable ? t("lobby.matchmaker.recent.watchHint") : t("lobby.matchmaker.recent.notYetAvailable")}
                        onClick={() => ipc.send({ kind: "Replays", command: { type: "watchVault", payload: { uid: game.uid } } })}
                      >
                        <Icon name="play" size={13} />
                        {!compactActions && <> {t("lobby.matchmaker.recent.watch")}</>}
                      </Button>
                      {/* Icon only, so it needs words on hover as well as
                          for a screen reader (issue 361). */}
                      <Button
                        onClick={() => openReplay(game.uid)}
                        aria-label={t("lobby.matchmaker.recent.openAria", { id: game.uid })}
                        title={t("lobby.matchmaker.recent.openAria", { id: game.uid })}
                      >
                        <Icon name="replays" size={13} />
                      </Button>
                    </span>
                  </td>,
                ];
                return (
                  <tr
                    key={game.uid}
                    className={menuGameOpen === game.uid ? "matchmaker-recent-row is-menu-open" : "matchmaker-recent-row"}
                  >
                    {order.map((column) => cells[column])}
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
