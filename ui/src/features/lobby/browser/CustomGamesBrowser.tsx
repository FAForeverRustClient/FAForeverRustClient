

import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../../design-system/EmptyState";
import { Modal } from "../../../design-system/Modal";
import type { Game, VaultMap } from "../../../ipc/bindings";
import { useGameBrowserColumns } from "./gameBrowserColumns";
import { useAppStore } from "../../../store/store";
import { friendKeys } from "./friendPresence";
import { t } from "../../../i18n";
import { useLocale } from "../../../i18n/useTranslation";
import { type GameViewMode } from "./gameRules";
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
}: Props) {
  useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [internalPreviewGame, setInternalPreviewGame] = useState<Game | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // Column widths live in settings, but a drag has to be visible before it is
  // saved: writing every pointer move through the backend would be a round
  // trip per pixel. So the saved widths seed a local copy, the drag moves the
  // copy, and releasing the handle persists it.
  const columns = useGameBrowserColumns(viewMode === "list");
  const columnStyle = columns.style;

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
        style={tileGridStyle}
      >
        {viewMode === "list" && columns.header}
        {games.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("lobby.browser.noMatch")}
            hint={t("lobby.browser.noMatchHint")}
          />
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
              columnStyle={columnStyle}
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
