// The line under a player's history saying how much of it is on screen.
//
// A profile scans the most recent games first (#440): a long history is
// dozens of API requests, and the reader who opened the card to look at one
// recent game should not wait for all of them. The rest is one click away.

import { Button } from "../../design-system/Button";
import type { PlayerMapStats } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

export function HistoryScopeNote({
  stats,
  full,
  onLoadFull,
}: {
  stats: PlayerMapStats;
  full: boolean;
  onLoadFull: () => void;
}) {
  const { t } = useTranslation();
  if (!stats.truncated) return null;
  if (full) {
    // Said plainly rather than hidden: even the whole scan has a ceiling.
    return <p className="player-maps-note muted">{t("playerCard.maps.truncated")}</p>;
  }
  return (
    <p className="player-maps-note muted player-history-scope">
      {t("playerCard.history.recentOnly")}{" "}
      <Button onClick={onLoadFull}>{t("playerCard.history.loadAll")}</Button>
    </p>
  );
}
