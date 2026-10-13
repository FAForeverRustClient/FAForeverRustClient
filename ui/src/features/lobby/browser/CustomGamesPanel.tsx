// The Play tab's custom games: the toolbar, the list, and the details panel
// beside it with the divider that sizes it. The state is the Play tab's and
// `useDetailPanelLayout`'s; this only draws it.

import type { ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { StatusNotice } from "../../../design-system/StatusNotice";
import { EmptyState } from "../../../design-system/EmptyState";
import { ResizeHandle } from "../../../design-system/ResizeHandle";
import type { Game, JoinState, LobbyStatus, VaultMap } from "../../../ipc/bindings";
import type { GameViewMode } from "../../../shared/gameRules";
import { plainError } from "../../../shared/plainError";
import { useTranslation } from "../../../i18n/useTranslation";
import type { PlayModePanelProps } from "../PlayModeTabs";
import { CustomGamesBrowser } from "./CustomGamesBrowser";
import { GameDetails } from "./GameDetails";
import type { DetailPanelLayout } from "./useDetailPanelLayout";

interface Props {
  /** Makes this the panel of the Play tab's Custom mode tab. */
  panelProps: PlayModePanelProps;
  layout: DetailPanelLayout;
  toolbar: ReactNode;
  /** The open custom games after the toolbar's search and filters. */
  games: Game[];
  /** Every open custom game, before the search and filters. */
  totalGames: number;
  selected: Game | null;
  vault: VaultMap[];
  viewMode: GameViewMode;
  status: LobbyStatus;
  join: JoinState;
  onJoin: (game: Game) => void;
  onPreview: (game: Game) => void;
  onOpenUserMenu: (nickname: string, event: React.MouseEvent) => void;
  onReconnect: () => void;
  onHost: () => void;
  /** Clear the search and the filters, for when they hid every game. */
  onClearFilters: () => void;
}

export function CustomGamesPanel({
  panelProps,
  layout,
  toolbar,
  games,
  totalGames,
  selected,
  vault,
  viewMode,
  status,
  join,
  onJoin,
  onPreview,
  onOpenUserMenu,
  onReconnect,
  onHost,
  onClearFilters,
}: Props) {
  const { t } = useTranslation();
  const {
    setLayoutElement, selectGame, detailShown, detailStyle, onDetailDrag, onDetailCommit, onDetailReset,
  } = layout;

  // Why the list is empty, which decides what it says and what it offers.
  // "No games match. Adjust the search or the filters" used to stand for all
  // of these, so a player who was not connected went looking for a filter.
  const emptyGames =
    status === "disconnected" ? (
      <EmptyState icon="globe" title={t("lobby.browser.disconnected")} hint={t("lobby.browser.disconnectedHint")}>
        <Button onClick={() => onReconnect()}>
          {t("status.reconnect")}
        </Button>
      </EmptyState>
    ) : status === "connecting" ? (
      <EmptyState icon="refresh" title={t("lobby.browser.connecting")} />
    ) : totalGames === 0 ? (
      <EmptyState icon="play" title={t("lobby.browser.noGames")} hint={t("lobby.browser.noGamesHint")}>
        <Button onClick={() => onHost()}>
          {t("lobby.toolbar.hostGame")}
        </Button>
      </EmptyState>
    ) : (
      <EmptyState icon="search" title={t("lobby.browser.noMatch")} hint={t("lobby.browser.noMatchHint")}>
        <Button onClick={() => onClearFilters()}>
          {t("lobby.browser.clearFilters")}
        </Button>
      </EmptyState>
    );

  return (
    <div
      {...panelProps}
      className="custom-games-layout"
      style={detailStyle}
      ref={setLayoutElement}
    >
      {toolbar}

      <CustomGamesBrowser
        games={games}
        totalGames={totalGames}
        selectedId={selected?.id ?? null}
        vault={vault}
        viewMode={viewMode}
        onSelect={selectGame}
        onJoin={onJoin}
        onPreview={onPreview}
        empty={emptyGames}
      />
      {/* The divider sits between the list and the panel rather than on
          either, so dragging it reads as moving the boundary. The panel
          folds away and back from the toolbar (#370, #377); the choice is
          a setting, so it holds across restarts. */}
      {detailShown && (
        <div className="custom-games-divider">
          <ResizeHandle
            label={t("lobby.browser.resizeDetails")}
            onDrag={onDetailDrag}
            onEnd={onDetailCommit}
            onReset={onDetailReset}
          />
        </div>
      )}
      {!detailShown ? null : selected ? (
        <GameDetails
          game={selected}
          onJoin={() => onJoin(selected)}
          onOpenUserMenu={onOpenUserMenu}
          onPreview={() => onPreview(selected)}
        />
      ) : (
        <aside className="game-detail-panel surface-panel empty">
          {/* A refused join for a game that has since gone from the list
              (the host left, it launched): the panel is where the reader
              looks after pressing Join, so the reason is said here too. */}
          {join.type === "failed" ? (
            <StatusNotice tone="error" detail={join.payload.reason}>
              {t("lobby.details.joinFailed", { reason: plainError(join.payload.reason) })}
            </StatusNotice>
          ) : (
            <>
              <Icon name="play" size={24} />
              <p>{t("lobby.details.selectGame")}</p>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
