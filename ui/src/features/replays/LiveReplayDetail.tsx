// A running game, opened out of the live grid.
//
// The vault's panel next door (`ReplayDetailPanel`) is not reusable for this
// and should not be: half of what it does is about a *file* - download it,
// read its header, look up its rating changes, show its review - and a game
// still being played has no file. What it has is a lineup, a map, and a way in.
//
// So this borrows the layout and every class name from that panel, which is
// what makes the two read as one tab, and shows only the facts a live game
// actually carries. A fact with no value is left out rather than printed as
// "unknown": there is no game length yet, and saying so in eight places is
// noise rather than information.

import { useState } from "react";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { mapPresentation } from "../../shared/mapPresentation";
import { liveReplayLink } from "../../shared/replayLinks";
import { useAppStore } from "../../store/store";
import { ReplayMapThumb } from "./OnlineReplayPresentation";
import { ReplayDetailRoster } from "./ReplayRoster";
import { liveReplayTeams } from "./LiveReplayCards";
import { LiveWatchButton } from "./LiveReplayRow";
import { gameStartedAt, prettyGameType } from "./liveReplayModel";
import { clientIntlTag } from "../../shared/dates";
import { formatRelativeDuration } from "../../shared/durations";
import { useTranslation } from "../../i18n/useTranslation";
import type { IconName } from "../../design-system/Icon";

export function LiveReplayDetail({
  game,
  busy,
  tracking,
  waitSeconds,
  player,
  onClose,
}: {
  game: Game;
  busy: boolean;
  tracking: LiveReplayTracking | null;
  waitSeconds: number;
  /** The signed-in account, which the live replay link is built for. */
  player: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  const socialPlayers = useAppStore((state) => state.state.social.players);
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  const presentation = mapPresentation(vault, game.map, missions);
  const mapLabel = presentation.displayName || game.map;
  const title = game.title || mapLabel;
  const teams = liveReplayTeams(game);
  const simMods = Object.values(game.simMods);
  const started = gameStartedAt(game);

  // The directory's avatars, keyed the way the roster asks for them. The lobby
  // sends no avatar with a game, so this is the only place one can come from.
  const avatarByLogin = new Map<string, string>();
  for (const profile of socialPlayers) {
    if (profile.avatarUrl) avatarByLogin.set(profile.login.toLocaleLowerCase(), profile.avatarUrl);
  }

  // Only the facts this game has. A running game has no duration, no review
  // and no result, and a column of "unknown" is not a description of it.
  const facts: Array<{ icon: IconName; label: string; value: string }> = [];
  if (started) {
    facts.push({
      icon: "clock",
      label: t("replays.detail.time"),
      value: started.toLocaleTimeString(clientIntlTag(), { hour: "2-digit", minute: "2-digit" }),
    });
    facts.push({
      icon: "hourglass",
      label: t("replays.live.runningFor"),
      value: formatRelativeDuration(
        Math.max(0, (Date.now() - started.getTime()) / 1000),
        { nowLabel: "0m" },
      ),
    });
  }
  facts.push({
    icon: "users",
    label: t("replays.detail.players"),
    value: `${game.players} / ${game.maxPlayers}`,
  });
  if (game.averageRating > 0) {
    facts.push({
      icon: "leaderboard",
      label: t("replays.detail.avgRating"),
      value: String(game.averageRating),
    });
  }
  facts.push({
    icon: "settings",
    label: t("replays.detail.featuredMod"),
    value: game.modName || "faf",
  });
  facts.push({
    icon: "play",
    label: t("replays.live.gameType"),
    value: prettyGameType(game.gameType),
  });
  facts.push({
    icon: "chat",
    label: t("replays.column.host"),
    value: game.host,
  });

  return (
    <Modal
      className="replay-detail-modal"
      ariaLabel={t("replays.detail.aria", { name: title })}
      onClose={onClose}
    >
      <div className="replay-card-layout">
        <aside className="replay-card-rail">
          <div className="replay-rail-thumb">
            <ReplayMapThumb
              url=""
              mapName={game.map}
              className="replay-rail-thumb-image"
              emptyClassName="replay-rail-thumb-empty"
              iconSize={44}
              large
            />
          </div>

          {/* The one action a running game has. Same control as the grid and
              the table, delay menu included. */}
          <div className="replay-card-rail-actions live-replay-detail-actions">
            <LiveWatchButton
              busy={busy}
              game={game}
              tracking={tracking}
              waitSeconds={waitSeconds}
            />
          </div>

          <div className="replay-card-idrow">
            <span className="replay-card-idlabel">{t("replays.detail.replayIdLabel")}</span>
            <span className="replay-card-idvalue">#{game.id}</span>
            <button
              type="button"
              className="replay-card-icon-btn"
              aria-label={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
              title={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
              onClick={() =>
                ipc.run(navigator.clipboard.writeText(String(game.id)).then(() => setCopiedId(true)))
              }
            >
              <Icon name={copiedId ? "check" : "copy"} size={13} />
            </button>
            {/* The live-replay URL, which is what somebody pastes to another
                client rather than a vault link: the game is not in the vault
                yet and will not be until it ends. */}
            <button
              type="button"
              className="replay-card-icon-btn"
              aria-label={t(copied ? "replays.detail.copiedShort" : "replays.live.copyLink")}
              title={t(copied ? "replays.detail.copiedShort" : "replays.live.copyLink")}
              onClick={() =>
                ipc.run(
                  navigator.clipboard
                    .writeText(liveReplayLink(game, player))
                    .then(() => setCopied(true)),
                )
              }
            >
              <Icon name={copied ? "check" : "external"} size={13} />
            </button>
          </div>
        </aside>

        <div className="replay-card-main">
          <div className="replay-card-heading">
            <h2 className="replay-card-title" title={title}>{title}</h2>
            <p className="replay-card-onmap">{t("replays.detail.onMap", { map: mapLabel })}</p>
          </div>

          <dl className="replay-card-facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt><Icon name={fact.icon} size={14} />{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>

          <section className="replay-card-lineup" aria-label={t("replays.live.lineup")}>
            {teams.length > 0 ? (
              // `showResults` off, and not a choice here: nobody has won yet.
              <ReplayDetailRoster teams={teams} showResults={false} avatarByLogin={avatarByLogin} />
            ) : (
              <p className="replay-detail-empty muted">{t("replays.live.lineupUnavailable")}</p>
            )}
          </section>

          {simMods.length > 0 && (
            <section className="replay-detail-sim-mods">
              <h3 className="replay-more-info-title">
                {t("replays.detail.simMods")}
                <span className="muted replay-more-info-count">({simMods.length})</span>
              </h3>
              <ul className="replay-sim-mod-list">
                {simMods.map((mod) => (
                  <li key={mod} className="surface-chip">{mod}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
