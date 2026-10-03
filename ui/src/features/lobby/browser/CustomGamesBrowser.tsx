

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "../../../design-system/EmptyState";
import { Modal } from "../../../design-system/Modal";
import type { Game, VaultMap } from "../../../ipc/bindings";
import { useGameBrowserColumns } from "./gameBrowserColumns";
import { useAppStore } from "../../../store/store";
import { friendKeys } from "./friendPresence";
import { t } from "../../../i18n";
import { useLocale } from "../../../i18n/useTranslation";
import { type GameViewMode } from "../../../shared/gameRules";
import { hideGlobalLineup } from "./hoverPopovers";
import { GameTile } from "./GameTile";
import { GameBrowserRow } from "./GameBrowserRow";
import { GamePreviewDialog } from "./GamePreviewDialog";

interface Props {
  games: Game[];
  totalGames: number;
  selectedId: number | null;
  vault: VaultMap[];
  viewMode: GameViewMode;
  onSelect: (id: number) => void;
  onJoin: (game: Game) => void;
  onPreview?: (game: Game) => void;
  /**
   * What to show when there is nothing to list, chosen by the caller, which
   * knows why: disconnected, connecting, no games at all, or filtered away.
   * Without it, the filtered-away state, which used to be shown for all four.
   */
  empty?: ReactNode;
}

type ContextMenu = { game: Game; x: number; y: number };

export function CustomGamesBrowser({
  games,
  totalGames,
  selectedId,
  vault,
  viewMode,
  onSelect,
  onJoin,
  onPreview: onPreviewProp,
  empty,
}: Props) {
  useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [previewSnapshot, setInternalPreviewGame] = useState<Game | null>(null);
  // Followed through the list while open, so a map the host changes shows
  // (#384); the snapshot only stands in once the game has left the list.
  const internalPreviewGame = previewSnapshot
    ? games.find((game) => game.id === previewSnapshot.id) ?? previewSnapshot
    : null;
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // Widths and order, set on the list once and read by every row from there.
  const columns = useGameBrowserColumns(viewMode === "list");

  const handlePreview = onPreviewProp ?? setInternalPreviewGame;

  // Read once for the whole list. Every row used to subscribe to the mod vault
  // and to the friend list itself, which is a hundred subscriptions and a
  // hundred `Set` builds for two values that are the same in all of them.
  const vaultMods = useAppStore((state) => state.state.mods.vault);
  const friendLogins = useAppStore((state) => state.state.social.friends);
  const friendSet = useMemo(() => friendKeys(friendLogins), [friendLogins]);
  const foeLogins = useAppStore((state) => state.state.social.foes);
  const foeSet = useMemo(() => friendKeys(foeLogins), [foeLogins]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const openContextMenu = (event: React.MouseEvent, game: Game) => {
    event.preventDefault();
    hideGlobalLineup();
    onSelect(game.id);
    setContextMenu({
      game,
      x: Math.min(event.clientX, window.innerWidth - 202),
      y: Math.min(event.clientY, window.innerHeight - 112),
    });
  };

  const tileColumns = useAppStore((state) => state.state.settings.appearance.gameTileColumns) ?? 0;
  const tileGridStyle = viewMode === "tiles" && tileColumns > 0
    ? { gridTemplateColumns: `repeat(${tileColumns}, minmax(0, 1fr))` }
    : undefined;

  return (
    <section className={`game-browser-panel surface-panel game-browser-${viewMode}`}>
      <div
        className={viewMode === "tiles" ? "game-tile-grid" : "game-browser-list"}
        style={viewMode === "tiles" ? tileGridStyle : columns.style}
      >
        {viewMode === "list" && columns.header}
        {games.length === 0 ? (
          empty ?? (
            <EmptyState
              icon="search"
              title={t("lobby.browser.noMatch")}
              hint={t("lobby.browser.noMatchHint")}
            />
          )
        ) : viewMode === "tiles" ? (
          games.map((game) => (
            <GameTile
              key={game.id}
              game={game}
              vault={vault}
              vaultMods={vaultMods}
              friendSet={friendSet}
              foeSet={foeSet}
              selected={selectedId === game.id}
              now={now}
              onSelect={() => onSelect(game.id)}
              onJoin={() => onJoin(game)}
              onContextMenu={(event) => openContextMenu(event, game)}
            />
          ))
        ) : (
          games.map((game) => (
            <GameBrowserRow
              key={game.id}
              game={game}
              vault={vault}
              vaultMods={vaultMods}
              friendSet={friendSet}
              foeSet={foeSet}
              now={now}
              selected={selectedId === game.id}
              onSelect={() => onSelect(game.id)}
              onJoin={() => onJoin(game)}
              onContextMenu={(event) => openContextMenu(event, game)}
            />
          ))
        )}
      </div>
      <footer className="game-browser-footer">
        <span>{t("lobby.browser.footerCount", { shown: games.length, total: totalGames })}</span>
        <span>{t(viewMode === "tiles" ? "lobby.browser.tileHint" : "lobby.browser.listHint")}</span>
      </footer>

      {!onPreviewProp && internalPreviewGame && (
        <Modal className="game-preview-modal" onClose={() => setInternalPreviewGame(null)}>
          <GamePreviewDialog
            game={internalPreviewGame}
            vault={vault}
            onClose={() => setInternalPreviewGame(null)}
            onJoin={() => onJoin(internalPreviewGame)}
          />
        </Modal>
      )}

      {contextMenu && (
        <div
          className="game-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong>{contextMenu.game.title}</strong>
          <button onClick={() => { onJoin(contextMenu.game); setContextMenu(null); }}>{t("lobby.browser.joinGame")}</button>
          <button onClick={() => { handlePreview(contextMenu.game); setContextMenu(null); }}>{t("lobby.browser.previewMap")}</button>
        </div>
      )}
    </section>
  );
}
