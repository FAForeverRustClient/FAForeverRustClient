// Live replays as a grid of cards, the other half of the view switch the two
// other replay tabs already have.
//
// The table is a scan: eight columns, sortable, and the right shape for "who
// is playing 4v4 on Setons right now". A card is a look: the map is the thing
// that decides whether a game is worth watching, and in the table it is a 42px
// thumbnail in the first column. Every other list of games in this client
// offers both, and this one offered a table, which is what #234 is about.
//
// The pieces come from `LiveReplayRow` rather than being written again: the
// watch button owns a delay menu, a tracking state and a portal, and two
// copies of that would be two behaviours.

import { Fragment, memo, useEffect, useState } from "react";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import type { MapPresentation } from "../../shared/mapPresentation";
import type { PlayerMenuOpener } from "../chat/usePlayerMenu";
import {
  LiveMapThumbnail,
  LivePlayerName,
  LiveReplayAge,
  LiveWatchButton,
} from "./LiveReplayRow";
import { prettyGameType, replayDelayRemaining } from "./liveReplayModel";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  busy: boolean;
  games: Array<{ game: Game; presentation: MapPresentation }>;
  matchingCount: number;
  totalCount: number;
  batchSize: number;
  previewsLoading: boolean;
  tracking: LiveReplayTracking | null;
  onPlayerMenu: PlayerMenuOpener;
  onLoadMore: () => void;
}

export function LiveReplayCards(props: Props) {
  const { t } = useTranslation();
  // One pair of clocks for the whole grid, as in the table: a timer per card
  // scales timer work with the result count, and the rows that are not waiting
  // for a delay get a stable zero so `memo` still skips them on every tick.
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
      <div className="live-replay-grid">
        {props.games.map(({ game, presentation }) => (
          <LiveReplayCard
            key={game.id}
            busy={props.busy}
            game={game}
            presentation={presentation}
            ageNow={ageNow}
            waitSeconds={replayDelayRemaining(game, waitNow)}
            tracking={props.tracking}
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
          <span>{t(props.previewsLoading ? "replays.live.loadingPreviews" : "replays.live.selectGame")}</span>
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
  presentation,
  ageNow,
  waitSeconds,
  tracking,
  onPlayerMenu,
}: {
  busy: boolean;
  game: Game;
  presentation: MapPresentation;
  ageNow: number;
  waitSeconds: number;
  tracking: LiveReplayTracking | null;
  onPlayerMenu: PlayerMenuOpener;
}) {
  const { t } = useTranslation();
  const simMods = Object.values(game.simMods);
  const teams = Object.entries(game.teams).filter(([, players]) => players.length > 0);

  return (
    <article
      className="live-replay-card surface-panel"
      // The table's own gesture, and the footer offers it in both views.
      onDoubleClick={() => {
        if (busy || waitSeconds > 0) return;
        ipc.send({
          kind: "Replays",
          command: {
            type: "watchLive",
            payload: { uid: game.id, modName: game.modName, map: game.map },
          },
        });
      }}
    >
      <div className="live-replay-card-map">
        <LiveMapThumbnail presentation={presentation} />
      </div>
      <div className="live-replay-card-body">
        <header className="live-replay-card-head">
          <strong title={game.title || presentation.displayName}>
            {game.title || presentation.displayName}
          </strong>
          <small>{presentation.displayName} · {prettyGameType(game.gameType)}</small>
        </header>

        <dl className="live-replay-card-meta">
          <div>
            <dt>{t("replays.column.players")}</dt>
            <dd>{game.players} / {game.maxPlayers}</dd>
          </div>
          <div>
            <dt>{t("replays.column.rating")}</dt>
            <dd>{game.averageRating > 0 ? game.averageRating : "N/A"}</dd>
          </div>
          <div>
            <dt>{t("replays.column.started")}</dt>
            <dd><LiveReplayAge game={game} now={ageNow} /></dd>
          </div>
          <div>
            <dt>{t("replays.column.host")}</dt>
            <dd><LivePlayerName name={game.host} onMenu={onPlayerMenu} /></dd>
          </div>
        </dl>

        {/* The lineup, which the table hides behind an expander. A card has
            the room, and "who is in it" is most of what decides whether a game
            is worth watching. */}
        <div className="live-replay-card-teams">
          {teams.length === 0 ? (
            <span className="muted">{t("replays.live.lineupUnavailable")}</span>
          ) : (
            teams.map(([team, players]) => (
              <span className="live-replay-card-team" key={team}>
                <em>
                  {team === "-1" || team === "null"
                    ? t("replays.live.observers")
                    : t("replays.live.team", { team })}
                </em>
                <span>
                  {players.map((player, index) => (
                    <Fragment key={player}>
                      {index > 0 && ", "}
                      <LivePlayerName name={player} onMenu={onPlayerMenu} />
                    </Fragment>
                  ))}
                </span>
              </span>
            ))
          )}
        </div>

        <footer className="live-replay-card-foot">
          <small title={simMods.join(", ")}>
            {game.modName || "faf"} · {simMods.length === 0
              ? t("replays.live.noSimMods")
              : simMods.length === 1
                ? simMods[0]
                : t("replays.live.moreSimMods", { first: simMods[0], count: simMods.length - 1 })}
          </small>
          <LiveWatchButton
            busy={busy}
            game={game}
            tracking={tracking}
            waitSeconds={waitSeconds}
          />
        </footer>
      </div>
    </article>
  );
});
