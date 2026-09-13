// Live replays as cards, built out of the online vault's card rather than
// beside it.
//
// The first version of this was its own card with its own grid, its own meta
// row and its own team list, and it looked like what it was: a second design
// for the same object, in the same tab, one click from the first. So the
// pieces are the vault's now, class for class: `.replay-grid`, `.replay-card`
// and its two columns, `ReplayMapThumb`, the icon-paired meta grid and
// `ReplayCardRoster`. What differs is only what a live game is: the facts a
// finished replay has and a running one does not (a duration, a review) give
// their places to the ones only a running game has, and the footer carries the
// watch control.
//
// It cannot be `ReplayLibraryCard` itself: that card is one large `<button>`,
// and this one holds a button with a menu behind it, which is not something a
// button may contain.

import { Fragment, memo, useEffect, useState } from "react";
import type { Game, LiveReplayTracking, ReplayPlayer, ReplayTeam } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { mapPresentation, type MapPresentation } from "../../shared/mapPresentation";
import { ReplayMapThumb, ReplayMetaFact, replayCardTitle } from "./OnlineReplayPresentation";
import { ReplayCardRoster } from "./ReplayRoster";
import { LiveReplayAge, LiveWatchButton } from "./LiveReplayRow";
import { prettyGameType, replayDelayRemaining } from "./liveReplayModel";
import "./online-replays.css";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * A running game's lineup, in the shape the vault's roster draws.
 *
 * The lobby gives names and nothing else: no faction, no rating, no outcome.
 * All three are optional in `ReplayPlayer` and the roster already draws a
 * player who has none of them, which is why this is a projection rather than a
 * second lineup component. `-1` and `null` are both the observer bucket on the
 * wire, and the roster reads any negative team as observers.
 */
export function liveReplayTeams(game: Game): ReplayTeam[] {
  return Object.entries(game.teams)
    .filter(([, players]) => players.length > 0)
    .map(([team, players]) => ({
      team: Number.parseInt(team, 10) || (team === "null" ? -1 : 0),
      players: players.map((name): ReplayPlayer => ({
        name,
        faction: null,
        rating: null,
        // Both required, and both exactly right for a game still being
        // played: nothing has been scored and nothing has been won yet.
        outcome: "",
        score: null,
      })),
    }))
    .sort((left, right) => left.team - right.team);
}

interface Props {
  busy: boolean;
  games: Array<{ game: Game; presentation: MapPresentation }>;
  matchingCount: number;
  totalCount: number;
  batchSize: number;
  previewsLoading: boolean;
  tracking: LiveReplayTracking | null;
  /** Open one game's detail panel. */
  onOpen: (id: number) => void;
  onLoadMore: () => void;
}

export function LiveReplayCards(props: Props) {
  const { t } = useTranslation();
  // One pair of clocks for the whole grid, as in the table: a timer per card
  // scales timer work with the result count, and a game that is not waiting on
  // the replay delay gets a stable zero, so `memo` still skips it on the ticks
  // the waiting ones need.
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [waitNow, setWaitNow] = useState(() => Date.now());
  const hasDelayedReplay = props.games.some(({ game }) => replayDelayRemaining(game, waitNow) > 0);

  useEffect(() => {
    const timer = window.setInterval(() => setAgeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasDelayedReplay) return;
    const timer = window.setInterval(() => setWaitNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasDelayedReplay]);

  return (
    <div className="live-replay-card-wrap">
      <div className="replay-grid">
        {props.games.map(({ game }) => (
          <LiveReplayCard
            key={game.id}
            busy={props.busy}
            game={game}
            ageNow={ageNow}
            waitSeconds={replayDelayRemaining(game, waitNow)}
            tracking={props.tracking}
            onOpen={props.onOpen}
          />
        ))}
      </div>
      <footer className="live-replay-footer">
        <span>
          {t("replays.live.showing", {
            shown: props.games.length,
            matching: props.matchingCount,
            total: props.totalCount,
          })}
        </span>
        <div className="live-replay-footer-actions">
          <span>
            {t(props.previewsLoading ? "replays.live.loadingPreviews" : "replays.live.selectGame")}
          </span>
          {props.games.length < props.matchingCount && (
            <Button className="live-replay-load-more" onClick={props.onLoadMore}>
              {t("replays.live.showMore", {
                count: Math.min(props.batchSize, props.matchingCount - props.games.length),
              })}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

const LiveReplayCard = memo(function LiveReplayCard({
  busy,
  game,
  ageNow,
  waitSeconds,
  tracking,
  onOpen,
}: {
  busy: boolean;
  game: Game;
  ageNow: number;
  waitSeconds: number;
  tracking: LiveReplayTracking | null;
  onOpen: (id: number) => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  const presentation = mapPresentation(vault, game.map, missions);
  const title = replayCardTitle(game.title, presentation.displayName || game.map);
  const teams = liveReplayTeams(game);
  const simMods = Object.values(game.simMods);

  // A click that did not land on a control opens the game, which is what the
  // vault's card does with a plain click. That card is one `<button>` and this
  // one cannot be: it holds the watch control and the lineup's player links.
  const opensDetail = (event: { target: EventTarget | null }) =>
    !(event.target as HTMLElement | null)?.closest("button, a");

  return (
    <article
      className="replay-card live-replay-card surface-panel"
      onClick={(event) => {
        if (opensDetail(event)) onOpen(game.id);
      }}
      // Double click watches, as it does on a table row.
      onDoubleClick={(event) => {
        if (!opensDetail(event) || busy || waitSeconds > 0) return;
        ipc.send({
          kind: "Replays",
          command: {
            type: "watchLive",
            payload: { uid: game.id, modName: game.modName, map: game.map },
          },
        });
      }}
    >
      <div className="replay-card-left">
        <ReplayMapThumb
          url=""
          mapName={game.map}
          className="replay-card-thumb"
          emptyClassName="replay-card-thumb-empty"
          iconSize={32}
        />
        {/* The slot the vault card spends on review stars. A running game has
            none and will have none while it is running, so it holds the one
            fact only a live game has: how long it has been going. */}
        <span className="live-replay-card-age muted">
          <LiveReplayAge game={game} now={ageNow} />
        </span>
        <div className="replay-meta-grid muted">
          <ReplayMetaFact
            icon="users"
            label={t("replays.card.players")}
            value={`${game.players} / ${game.maxPlayers}`}
          />
          <ReplayMetaFact
            icon="activity"
            label={t("replays.card.averageRating")}
            value={game.averageRating > 0 ? `~${game.averageRating}` : ""}
          />
          <ReplayMetaFact
            icon="mods"
            label={t("replays.card.featuredMod")}
            value={game.modName || "faf"}
          />
          <ReplayMetaFact
            icon="play"
            label={t("replays.live.gameType")}
            value={prettyGameType(game.gameType)}
          />
          {/* The id and what the game is running, in the grid rather than in
              the footer: both are facts about the game, like the four above
              them, and the footer is a line of text. */}
          <ReplayMetaFact
            icon="replays"
            label={t("replays.detail.replayIdLabel")}
            value={`#${game.id}`}
          />
          <ReplayMetaFact
            icon="mods"
            label={t("replays.detail.simMods")}
            value={t("replays.live.simModCount", { count: simMods.length })}
          />
        </div>
        {/* The one thing to do with a running game, at the bottom of the
            column that describes it. */}
        <div className="live-replay-card-watch">
          <LiveWatchButton
            busy={busy}
            game={game}
            tracking={tracking}
            waitSeconds={waitSeconds}
          />
        </div>
      </div>
      <div className="replay-card-right">
        <div className="replay-card-header">
          <span className="replay-card-title" title={title.full} aria-label={title.full}>
            {title.display}
          </span>
          <span className="replay-card-submap muted">
            {t("replays.card.onMap", { map: presentation.displayName || game.map })}
          </span>
        </div>
        <ReplayCardRoster teams={teams} interactive />
        <div className="replay-card-footer muted">
          {t("lobby.details.host", { name: game.host })}
          {simMods.length > 0 && (
            <Fragment>
              {" · "}
              <span title={simMods.join(", ")}>
                {simMods.length === 1
                  ? simMods[0]
                  : t("replays.live.moreSimMods", {
                    first: simMods[0],
                    count: simMods.length - 1,
                  })}
              </span>
            </Fragment>
          )}
        </div>
      </div>
    </article>
  );
});
