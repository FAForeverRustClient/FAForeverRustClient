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

import { memo, useEffect, useState } from "react";
import type { Game, LiveReplayTracking, ReplayPlayer, ReplayTeam } from "../../../ipc/bindings";
import { Button } from "../../../design-system/Button";
import { ipc } from "../../../ipc/client";
import { useAppStore } from "../../../store/store";
import { mapPresentation, type MapPresentation } from "../../../shared/mapPresentation";
import { ReplayMapThumb, ReplayMetaFact, ReplayThumbGenerate, replayCardTitle } from "../ReplayCard";
import { ReplayCardRoster } from "../ReplayRoster";
import type { PlayerMenuOpener } from "../../../shared/hooks/usePlayerMenu";
import { LiveReplayAge, LiveWatchButton } from "./LiveReplayRow";
import { prettyGameType, replayDelayRemaining } from "../../../shared/liveReplayModel";
import { isCoopGame } from "../../../shared/gameRules";
import "../online-replays.css";
import { useTranslation } from "../../../i18n/useTranslation";

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
  games: Array<{ game: Game; presentation: MapPresentation; mapSize: string | null }>;
  matchingCount: number;
  totalCount: number;
  batchSize: number;
  previewsLoading: boolean;
  tracking: LiveReplayTracking | null;
  /** Open one game's detail panel. */
  onOpen: (id: number) => void;
  /** Opens the chat player menu on a name in a card's lineup. */
  onPlayerMenu: PlayerMenuOpener;
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
        {props.games.map(({ game, mapSize }) => (
          <LiveReplayCard
            key={game.id}
            mapSize={mapSize}
            busy={props.busy}
            game={game}
            ageNow={ageNow}
            waitSeconds={replayDelayRemaining(game, waitNow)}
            tracking={props.tracking}
            onOpen={props.onOpen}
            onPlayerMenu={props.onPlayerMenu}
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

/**
 * One running game as the Live tab draws it. Exported for the side panel of a
 * private conversation (#448), which shows the game the other person is
 * playing and should say exactly what this tab says about it.
 */
export const LiveReplayCard = memo(function LiveReplayCard({
  busy,
  game,
  ageNow,
  waitSeconds,
  tracking,
  onOpen,
  onPlayerMenu,
  mapSize,
}: {
  busy: boolean;
  game: Game;
  /** "10 km", or null when nothing knows it. */
  mapSize: string | null;
  ageNow: number;
  waitSeconds: number;
  tracking: LiveReplayTracking | null;
  /** Opens the game's detail panel; a card with nowhere to open one leaves it out. */
  onOpen?: (id: number) => void;
  onPlayerMenu: PlayerMenuOpener;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  // The vault's lineup when it has one: the lobby sends names and nothing
  // else, and the API's row for a game carries the faction each player picked.
  // `LiveReplayView` asks for the whole page at once; this only reads the
  // answer, and draws the lobby's names until it arrives.
  const lookup = useAppStore((state) => state.state.replays.onlineLookups?.[game.id]);
  const presentation = mapPresentation(vault, game.map, missions);
  const title = replayCardTitle(game.title, presentation.displayName || game.map);
  const vaultTeams = lookup?.type === "found" ? lookup.payload.teams : [];
  const lineup = vaultTeams.length > 0 ? vaultTeams : liveReplayTeams(game);
  // A co-op mission rates nobody, and the vault's row says 0 for every
  // player in it: a column of zeros down every co-op card (#434).
  const teams = isCoopGame(game)
    ? lineup.map((team) => ({ ...team, players: team.players.map((player) => ({ ...player, rating: null })) }))
    : lineup;
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
        if (opensDetail(event)) onOpen?.(game.id);
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
        <span className="replay-card-thumb-wrap">
          <ReplayMapThumb
            url=""
            mapName={game.map}
            className="replay-card-thumb"
            emptyClassName="replay-card-thumb-empty"
            iconSize={32}
          />
          <ReplayThumbGenerate mapName={game.map} />
        </span>
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
          {/* Only what is known (#434): an unrated lobby's "N/A" and a vanilla
              game's "0 sim mods" were a third of the grid on most cards and
              said nothing. */}
          {game.averageRating > 0 && (
            <ReplayMetaFact
              icon="activity"
              label={t("replays.card.averageRating")}
              value={`~${game.averageRating}`}
            />
          )}
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
          {simMods.length > 0 && (
            <ReplayMetaFact
              icon="mods"
              label={t("replays.detail.simMods")}
              value={t("replays.live.simModCount", { count: simMods.length })}
              detail={simMods.join(", ")}
            />
          )}
          {/* Last, so it can take the grid's whole width: an eight-digit id
              did not fit the narrow column and was cut to "#27904..." (#434). */}
          <ReplayMetaFact
            icon="replays"
            label={t("replays.detail.replayIdLabel")}
            value={`#${game.id}`}
          />
        </div>
      </div>
      <div className="replay-card-right">
        <div className="replay-card-header">
          <span className="replay-card-title" title={title.full} aria-label={title.full}>
            {title.display}
          </span>
          <span className="replay-card-submap muted">
            {t("replays.card.onMap", {
              map: mapSize ? `${presentation.displayName || game.map} (${mapSize})` : presentation.displayName || game.map,
            })}
          </span>
        </div>
        <ReplayCardRoster teams={teams} interactive onPlayerMenu={onPlayerMenu} />
        {/* Who hosts it, and the one thing to do with it. The featured mod and
            the sim mods used to close this line and are in the fact grid on
            the left, where the rest of what the game *is* lives. */}
        <div className="replay-card-footer live-replay-card-footer">
          <span className="muted">{t("lobby.details.host", { name: game.host })}</span>
          <LiveWatchButton
            busy={busy}
            game={game}
            tracking={tracking}
            waitSeconds={waitSeconds}
          />
        </div>
      </div>
    </article>
  );
});
