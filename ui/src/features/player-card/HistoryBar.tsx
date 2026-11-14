// The bar every history tab opens on (Results, Maps, Statistics): how much of
// the player's history the figures under it cover, and the way to the rest.
//
// A profile scans the most recent games first (#440): a long history is
// dozens of API requests, and the reader who opened the card to look at one
// recent game should not wait for all of them. The rest is one click away.
//
// That used to be a muted sentence with a primary button in the middle of it,
// placed wherever each tab had room: under the figures on one tab, above them
// on another, beside a note on the third. Now it is one bar, first on all
// three, in the same place. A control that switches the whole tab (the
// Statistics tab's Performance and Activity) goes at the bar's start.
//
// Only while part of the history is unread: once all of it is here, an
// "All games" bar says nothing the figures under it do not, so it is left
// out, and a tab's own switch stands on its own in its place.

import type { ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { PlayerMapStats } from "../../ipc/bindings";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

export function HistoryBar({
  stats,
  full,
  onLoadFull,
  children,
}: {
  stats: PlayerMapStats;
  full: boolean;
  onLoadFull: () => void;
  /** The tab's own control for the whole view, drawn at the bar's start. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  if (!stats.truncated) {
    return children ? <div className="player-history-switch">{children}</div> : null;
  }
  const scope = t("playerCard.history.gameCount.last", { count: formatNumber(stats.totalGames) });
  // Said plainly rather than hidden: the numbers cover a prefix of the
  // history, and even the whole scan, once asked for, has a ceiling.
  const explanation = full ? t("playerCard.maps.truncated") : t("playerCard.history.recentOnly");

  return (
    <div className="player-history-bar surface-panel">
      {children && <div className="player-history-bar-start">{children}</div>}
      <p className="player-history-bar-scope">
        <Icon name="hourglass" size={14} />
        <strong>{scope}</strong>
        <span className="player-history-bar-note">{explanation}</span>
      </p>
      {!full && (
        <Button className="player-history-bar-action" onClick={onLoadFull}>
          <Icon name="download" size={14} />
          {t("playerCard.history.loadAll")}
        </Button>
      )}
    </div>
  );
}
