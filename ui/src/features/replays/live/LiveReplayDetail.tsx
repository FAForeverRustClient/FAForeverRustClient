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
//
// One thing it does ask the vault for: the lineup. The lobby's `game_info`
// carries team numbers and logins and nothing else - no faction, no rating -
// but the API's `game` row is written when the match *launches*, not when it
// ends, so a running game already has one, with `playerStats` in it. The same
// one-id lookup the local library uses (`lookUpOnline`) answers it, and the
// panel simply shows the richer lineup when it arrives. If the API has nothing
// to say, the lobby's names stay on screen and nothing is lost.

import { useEffect, useState } from "react";
import type { Game, LiveReplayTracking } from "../../../ipc/bindings";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
import { ipc } from "../../../ipc/client";
import { isGeneratedMap, mapPresentation, mapSize } from "../../../shared/mapPresentation";
import { useAppStore } from "../../../store/store";
import { useNamedMapGeneration } from "../../../shared/hooks/useNamedMapGeneration";
import { ReplayMapThumb } from "../ReplayCard";
import { MapPreviewFrame } from "../../../shared/components/MapPreviewZoom";
import { ReplayDetailRoster } from "../ReplayRoster";
import type { PlayerMenuOpener } from "../../../shared/hooks/usePlayerMenu";
import { liveReplayTeams } from "./LiveReplayCards";
import { LiveWatchButton } from "./LiveReplayRow";
import { gameStartedAt, prettyGameType } from "../../../shared/liveReplayModel";
import { clientIntlTag } from "../../../shared/format/dates";
import { formatRelativeDuration } from "../../../shared/format/durations";
import { useTranslation } from "../../../i18n/useTranslation";
import type { IconName } from "../../../design-system/Icon";

export function LiveReplayDetail({
  game,
  busy,
  tracking,
  waitSeconds,
  onPlayerMenu,
  onClose,
}: {
  game: Game;
  busy: boolean;
  tracking: LiveReplayTracking | null;
  waitSeconds: number;
  /** Opens the chat player menu on a name in the lineup. */
  onPlayerMenu: PlayerMenuOpener;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  const socialPlayers = useAppStore((state) => state.state.social.players);
  const lookup = useAppStore((state) => state.state.replays.onlineLookups?.[game.id]);
  const mapGen = useNamedMapGeneration(game.map);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedMapName, setCopiedMapName] = useState(false);
  /// Whether the map preview has been opened out of the rail.
  const [enlarged, setEnlarged] = useState(false);

  // Asked once per game, and only while a panel is open: a request per card in
  // the grid would be a request per refresh of a list that refreshes itself.
  useEffect(() => {
    if (lookup) return;
    ipc.send({ kind: "Replays", command: { type: "lookUpOnline", payload: { uid: game.id } } });
  }, [game.id, lookup]);

  // `Modal` closes on Escape from a bubble-phase listener on the document, so
  // the preview has to take Escape in the capture phase: one press steps back
  // out of the picture instead of shutting the whole panel.
  useEffect(() => {
    if (!enlarged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setEnlarged(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enlarged]);

  // A generated map's size is in its name, and decoding the name is one
  // command for the one game this panel shows, as the lobby's own panel does.
  const isGenerated = isGeneratedMap(game.map);
  const decoded = useAppStore((state) => state.state.mapGenerator.decoded?.[game.map]);
  useEffect(() => {
    if (!isGenerated || decoded) return;
    ipc.send({
      kind: "MapGenerator",
      command: { type: "decodeNames", payload: { mapNames: [game.map] } },
    });
  }, [isGenerated, decoded, game.map]);
  const size = mapSize(vault, game.map, decoded?.mapSize);

  const presentation = mapPresentation(vault, game.map, missions);
  const mapLabel = presentation.displayName || game.map;
  const title = game.title || mapLabel;
  // The vault's lineup when it has one, the lobby's otherwise. The API knows
  // factions and ratings; the lobby knows who is in the game. They are the same
  // lineup, recorded at the same moment.
  const vaultTeams = lookup?.type === "found" ? lookup.payload.teams : [];
  const teams = vaultTeams.length > 0 ? vaultTeams : liveReplayTeams(game);
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
  // Left out, like every other fact here, when nothing knows it (#327).
  if (size) {
    facts.push({
      icon: "maps",
      label: t("replays.filters.mapSize"),
      value: size.compact,
    });
  }

  return (
    <Modal
      className="replay-detail-modal"
      ariaLabel={t("replays.detail.aria", { name: title })}
      onClose={onClose}
    >
      <div className="replay-card-layout">
        <aside className="replay-card-rail">
          {/* The same preview the vault's panel has, and the same way in:
              press it and the map opens in the zoom frame the Maps and Play
              tabs use. A live game is the one where the map matters most, and
              it was the one picture here that could not be looked at. */}
          <div className="replay-rail-thumb">
            <button
              type="button"
              className="replay-rail-thumb-open"
              onClick={() => setEnlarged(true)}
              title={t("maps.preview.enlarge", { name: mapLabel })}
              aria-label={t("maps.preview.enlarge", { name: mapLabel })}
            >
              <ReplayMapThumb
                url=""
                mapName={game.map}
                className="replay-rail-thumb-image"
                emptyClassName="replay-rail-thumb-empty"
                iconSize={44}
                large
              />
              <span className="replay-rail-thumb-zoom" aria-hidden>
                <Icon name="search" size={14} />
              </span>
            </button>
            {(mapGen.canGenerate || mapGen.isGenerating) && (
              <div className="replay-rail-thumb-actions">
                <button
                  type="button"
                  className="replay-rail-thumb-btn"
                  disabled={mapGen.isGenerating}
                  onClick={mapGen.generate}
                  title={mapGen.generateLabel}
                  aria-label={mapGen.generateLabel}
                >
                  <Icon
                    name={mapGen.isGenerating ? "refresh" : "plus"}
                    size={14}
                    className={mapGen.isGenerating ? "spin" : undefined}
                  />
                </button>
              </div>
            )}
          </div>

        </aside>

        <div className="replay-card-main">
          <div className="replay-card-heading">
            <h2 className="replay-card-title" title={title}>{title}</h2>
            <p className="replay-card-onmap">{t("replays.detail.onMap", { map: mapLabel })}</p>
          </div>

          <dl className="replay-card-facts">
            {/* The id with the facts rather than off in the rail, the way the
                vault panel and the list view's opened row both have it. */}
            <div className="replay-card-fact-id">
              <dt><Icon name="list" size={14} />{t("replays.detail.replayIdLabel")}</dt>
              <dd>
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
              </dd>
            </div>
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
              <ReplayDetailRoster
                teams={teams}
                showResults={false}
                avatarByLogin={avatarByLogin}
                onPlayerMenu={onPlayerMenu}
              />
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

          {/* The way in, in the corner the vault's panel puts its own actions:
              at the end of the column that describes the game, not under the
              picture of the map. */}
          <div className="replay-card-bottom live-replay-detail-bottom">
            <LiveWatchButton
              busy={busy}
              game={game}
              tracking={tracking}
              waitSeconds={waitSeconds}
            />
          </div>
        </div>
      </div>

      {/* In this dialog's own markup rather than a second `Modal`: `Modal`
          closes on Escape from a document listener, so two stacked would close
          both at once. Three ways out, as next door: the button, the scrim and
          Escape. */}
      {enlarged && (
        <div
          className="replay-preview-scrim"
          role="presentation"
          onClick={() => setEnlarged(false)}
        >
          <div
            className="replay-preview-overlay"
            role="dialog"
            aria-label={t("maps.preview.enlarge", { name: mapLabel })}
            onClick={(event) => event.stopPropagation()}
          >
            <MapPreviewFrame
              kicker={t("lobby.browser.mapPreview")}
              title={mapLabel}
              subtitle={title === mapLabel ? undefined : title}
              onClose={() => setEnlarged(false)}
              footer={game.map ? (
                <div className="replay-preview-overlay-name">
                  <span>{t("lobby.browser.mapFullName")}</span>
                  <code>{game.map}</code>
                  <button
                    type="button"
                    className="replay-card-icon-btn"
                    aria-label={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                    title={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                    onClick={() =>
                      ipc.run(navigator.clipboard.writeText(game.map).then(() => setCopiedMapName(true)))
                    }
                  >
                    <Icon name={copiedMapName ? "check" : "copy"} size={13} />
                  </button>
                  {(mapGen.canGenerate || mapGen.isGenerating) && (
                    <Button
                      className="replay-preview-overlay-generate"
                      disabled={mapGen.isGenerating}
                      onClick={mapGen.generate}
                    >
                      <Icon
                        name={mapGen.isGenerating ? "refresh" : "plus"}
                        size={13}
                        className={mapGen.isGenerating ? "spin" : undefined}
                      />
                      {mapGen.generateLabel}
                    </Button>
                  )}
                </div>
              ) : null}
            >
              <ReplayMapThumb
                url=""
                mapName={game.map}
                className="replay-preview-overlay-image"
                emptyClassName="replay-rail-thumb-empty"
                iconSize={64}
                large
              />
            </MapPreviewFrame>
          </div>
        </div>
      )}
      {mapGen.isGenerating && mapGen.progress && (
        <div className="replay-generation-banner">
          <div className="replay-generation-banner-content">
            <Icon name="refresh" size={14} className="spin replay-generation-spinner" />
            <span className="replay-generation-banner-text">{mapGen.progress.label}</span>
            {mapGen.progress.percent !== null && (
              <span className="replay-generation-banner-pct">{mapGen.progress.percent}%</span>
            )}
          </div>
          {mapGen.progress.percent !== null ? (
            <div className="replay-generation-progress-track">
              <div
                className="replay-generation-progress-fill"
                style={{ width: `${mapGen.progress.percent}%` }}
              />
            </div>
          ) : (
            <div className="replay-generation-progress-track indeterminate">
              <div className="replay-generation-progress-fill" />
            </div>
          )}
        </div>
      )}
      {mapGen.status.type === "failed" && (
        <p className="replay-download-error surface-error">
          {t("replays.detail.generationFailed", { error: mapGen.status.payload.reason })}
        </p>
      )}
    </Modal>
  );
}
