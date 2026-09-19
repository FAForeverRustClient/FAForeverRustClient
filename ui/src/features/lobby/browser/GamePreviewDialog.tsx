// The game opened out of the list: map, settings, lineup, and the join button.

import { memo, useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { Game, VaultMap } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { GameMapImage } from "../GameMapImage";
import { findVaultMap, isGeneratedMap, mapPresentation } from "../../../shared/mapPresentation";
import { findPlayer } from "../../../store/reducer";
import { useAppStore } from "../../../store/store";
import { sizeLabel } from "../../../shared/mapPresentation";
import { ZoomableImage } from "../../../shared/components/MapPreviewZoom";
import { generatorParameters } from "../../../shared/generatorPresentation";
import {
  generatedMapDescriptionRows,
  mergeGeneratorRows,
} from "../../../shared/generatedMapDescription";
import { t } from "../../../i18n";
import { displayedRating, gameLeaderboard, ratingGateBlocks } from "../../../shared/playerRatings";

export const GamePreviewDialog = memo(function GamePreviewDialog({
  game,
  vault,
  onClose,
  onJoin,
}: {
  game: Game;
  vault: VaultMap[];
  onClose: () => void;
  onJoin: () => void;
}) {
  const presentation = mapPresentation(vault, game.map);
  const vaultMap = findVaultMap(vault, game.map);
  const maps = useAppStore((state) => state.state.maps);
  const lobby = useAppStore((state) => state.state.lobby);
  const player = useAppStore((state) => state.state.auth.player);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const isGenerated = isGeneratedMap(game.map);
  const installedMap = maps.installed.find(
    (map) =>
      map.folderName.toLowerCase() === game.map.toLowerCase() ||
      map.folderName.toLowerCase().startsWith(`${game.map.toLowerCase()}.`),
  );
  const installed = installedMap !== undefined;
  const isGeneratingThisMap =
    mapGenStatus.type === "generating" ||
    mapGenStatus.type === "downloading" ||
    mapGenStatus.type === "resolvingVersion";
  const [copiedName, setCopiedName] = useState(false);
  useEffect(() => {
    if (!copiedName) return;
    const timer = window.setTimeout(() => setCopiedName(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copiedName]);

  // A generator name is the whole recipe, not a label, so the settings that
  // produced this map are already in the client's hands: decoding is pure
  // arithmetic, no download and no server round trip. Asking once per open
  // dialog is enough, and a name that does not decode simply yields nothing:
  // the row above still shows it verbatim, which is the honest fallback for a
  // generator newer than this client's tables.
  const decodedNames = useAppStore((state) => state.state.mapGenerator.decoded);
  const decoded = isGenerated ? decodedNames?.[game.map] : undefined;
  useEffect(() => {
    if (!isGenerated || decoded) return;
    ipc.send({
      kind: "MapGenerator",
      command: { type: "decodeNames", payload: { mapNames: [game.map] } },
    });
  }, [isGenerated, decoded, game.map]);
  // Two sources, and the better one is only sometimes there. The name is
  // always available and says what the generator was *asked* for. The map's
  // own description says what it *did* - biome, terrain, resources, props and
  // the three symmetries, none of which a predefined style encodes into a
  // name - but only somebody who has the map on disk has it. So the
  // description leads where there is one, and the name fills in the rest:
  // the generator version, and the densities a description never mentions.
  const generatorRows = mergeGeneratorRows(
    generatedMapDescriptionRows(isGenerated ? installedMap?.description : null, t),
    decoded ? generatorParameters(decoded, t) : [],
  );
  const isHost = !!player && game.host.localeCompare(player.name, undefined, { sensitivity: "base" }) === 0;
  const isPlayerInGame = !!player && Object.values(game.teams).some((teamPlayers) =>
    teamPlayers.some((p) => p.localeCompare(player.name, undefined, { sensitivity: "base" }) === 0)
  );

  // The server hides an enforced lobby from an out-of-range player, so this
  // usually never fires. It fires for the lobby that was already on screen
  // when the host set the range, which is the case worth catching: the join
  // would otherwise download mods for a minute and then be refused.
  const social = useAppStore((state) => state.state.social);
  const ownRating = displayedRating(
    player ? findPlayer(social, player.name) : undefined,
    gameLeaderboard(game.ratingType),
  );
  const ratingBlocked = !isHost && ratingGateBlocks(game, ownRating);

  const isJoiningThis = lobby.join.type === "joining" && lobby.join.payload.id === game.id;
  const isPreparingThis = lobby.join.type === "preparing";
  const isLaunchedThis = lobby.join.type === "launched" && lobby.join.payload.launch.uid === game.id;
  const isInGame = lobby.join.type === "inGame";

  const isBusyWithOther = (lobby.join.type === "joining" && lobby.join.payload.id !== game.id)
    || (lobby.join.type === "launched" && !isLaunchedThis)
    || (isInGame && !isPlayerInGame && !isHost);

  let joinLabel = t("lobby.details.joinGame");
  let joinDisabled = false;
  let joinTitle: string | undefined;

  if (isHost) {
    joinLabel = t("lobby.details.hostedByYou");
    joinDisabled = true;
  } else if (isPlayerInGame) {
    joinLabel = t("lobby.details.inGame");
    joinDisabled = true;
  } else if (isJoiningThis) {
    joinLabel = t("lobby.details.joining");
    joinDisabled = true;
  } else if (isPreparingThis) {
    joinLabel = t("lobby.details.preparing");
    joinDisabled = true;
  } else if (isBusyWithOther) {
    joinLabel = t("lobby.details.joinGame");
    joinDisabled = true;
    joinTitle = t("lobby.details.alreadyInGame");
  } else if (ratingBlocked) {
    joinLabel = t("lobby.details.ratingLocked");
    joinDisabled = true;
    joinTitle = t("lobby.details.ratingLockedTitle", {
      from: game.ratingMin === null ? t("lobby.browser.any") : String(game.ratingMin),
      to: game.ratingMax === null ? t("lobby.browser.any") : String(game.ratingMax),
      rating: String(ownRating ?? 0),
    });
  }

  return (
    <div className="game-preview-dialog">
      <header className="game-preview-dialog-header">
        <div>
          <span className="game-preview-dialog-kicker">{t("lobby.browser.mapPreview")}</span>
          <h2>{presentation.displayName}</h2>
          <p>{game.title}</p>
        </div>
      </header>
      {/* The same zoom the Maps tab has. This is the dialog somebody opens
          *because* the tile was too small to read a spawn off, so it is the one
          place a fixed picture helps least. The overlays stay in a wrapper of
          their own: the zoom's viewport clips whatever is inside it, which is
          the point of it, and a lock badge is not part of the map. */}
      <div className="game-preview-dialog-map">
        <ZoomableImage label={presentation.displayName || game.map}>
          <GameMapImage
            mapName={game.map}
            vault={vault}
            className="game-preview-dialog-image"
            placeholderClassName="game-preview-dialog-placeholder"
            large
          />
        </ZoomableImage>
        {game.passwordProtected && (
          <span className="game-preview-dialog-private" role="img" aria-label={t("lobby.browser.privateGame")} title={t("lobby.browser.privateGame")}>
            <Icon name="lock" size={13} />
            {t("lobby.browser.private")}
          </span>
        )}
        {!installed && isGenerated && (
          <Button
            className="game-preview-dialog-map-action"
            disabled={isGeneratingThisMap}
            onClick={() =>
              ipc.send({
                kind: "MapGenerator",
                command: {
                  type: "generateNamed",
                  payload: {
                    mapName: game.map,
                  },
                },
              })
            }
          >
            <Icon name="plus" size={13} />
            {isGeneratingThisMap ? t("lobby.browser.generatingMap") : t("lobby.browser.generateMap")}
          </Button>
        )}
      </div>
      {/* The full technical name. It is nowhere else in the client, and it is
          the one thing map generator hosting needs: generate many, note the
          names of the good ones, host them one after another. Untruncated,
          because half a generator name identifies nothing, and copyable,
          because nobody retypes forty characters of Base32.

          What is copied is the value the Generate map dialog's map-name field
          takes back, which is the only round trip that exists for a generated
          map: it is not in the vault, so pasting its name into the map search
          would find nothing. That is the trap the Python client's copy button
          falls into. */}
      <div className="game-preview-dialog-name">
        <span>{t("lobby.browser.mapFullName")}</span>
        <code>{game.map}</code>
        <button
          type="button"
          className="game-preview-dialog-copy"
          aria-label={t(copiedName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
          title={t(
            copiedName
              ? "lobby.browser.mapNameCopied"
              : isGenerated
                ? "lobby.browser.copyMapNameGenerated"
                : "lobby.browser.copyMapName",
          )}
          onClick={() =>
            ipc.run(navigator.clipboard.writeText(game.map).then(() => setCopiedName(true)))
          }
        >
          <Icon name={copiedName ? "check" : "copy"} size={13} />
        </button>
      </div>
      {/* All that is left of the metadata column: the facts that are about the
          map rather than about the game. Host, featured mod, players, ratings
          and teams are the details rail's job, and repeating them here in a
          narrower box is what left the map no room to be bigger than the
          thumbnail the reader clicked.

          For a generated map the facts are the generator settings, read out of
          the name. Its own size row supersedes the catalogue's, because a
          generated map has no catalogue entry to take one from. */}
      {(generatorRows.length > 0 || vaultMap) && (
        <dl className="game-preview-dialog-facts">
          {generatorRows.length === 0 && vaultMap && (
            <div>
              <dt>{t("lobby.browser.mapSize")}</dt>
              <dd>{sizeLabel(vaultMap)}</dd>
            </div>
          )}
          {generatorRows.map((row) => (
            <div key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <footer className="game-preview-dialog-actions play-dialog-actions">
        {!installed && !isGenerated && vaultMap && (
          <Button
            onClick={() =>
              ipc.send({
                kind: "Maps",
                command: {
                  type: "installMap",
                  payload: {
                    folderName: vaultMap.folderName,
                    downloadUrl: vaultMap.downloadUrl,
                  },
                },
              })
            }
          >
            {t("lobby.browser.downloadMap")}
          </Button>
        )}
        <Button onClick={onClose}>{t("lobby.browser.close")}</Button>
        <Button variant="primary" disabled={joinDisabled} title={joinTitle} onClick={onJoin}>{joinLabel}</Button>
      </footer>
    </div>
  );
});
