import { useMemo, useState } from "react";
import type { PlayerAchievement } from "../../ipc/bindings";
import { formatDate } from "../../shared/dates";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

function AchievementCard({ achievement }: { achievement: PlayerAchievement }) {
  const { t } = useTranslation();
  const unlocked = achievement.state === "unlocked";
  const icon = unlocked ? achievement.unlockedIconUrl : achievement.revealedIconUrl;
  const progress = achievement.totalSteps
    ? Math.min(100, (achievement.currentSteps / achievement.totalSteps) * 100)
    : unlocked ? 100 : 0;
  return (
    <article className={`player-achievement surface-panel${unlocked ? " is-unlocked" : ""}`}>
      {icon
        ? <img src={icon} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
        : <div className="player-achievement-placeholder" aria-hidden>★</div>}
      <div className="player-achievement-body">
        <header><h4>{achievement.name}</h4><span>{achievement.experiencePoints} XP</span></header>
        <p>{achievement.description}</p>
        {achievement.incremental && achievement.totalSteps !== null && (
          <div className="player-achievement-progress">
            <div><span style={{ width: `${progress}%` }} /></div>
            <small>{t("playerCard.achievements.progress", {
              current: formatNumber(achievement.currentSteps),
              total: formatNumber(achievement.totalSteps),
            })}</small>
          </div>
        )}
        {(achievement.unlockersCount !== null || achievement.unlockersPercent !== null) && (
          <small className="muted">
            {t("playerCard.achievements.unlockers", {
              count: achievement.unlockersCount === null ? "N/A" : formatNumber(achievement.unlockersCount),
            })}
            {achievement.unlockersPercent !== null ? ` (${achievement.unlockersPercent.toFixed(1)}%)` : ""}
          </small>
        )}
      </div>
    </article>
  );
}

export function PlayerAchievements({ achievements }: { achievements: PlayerAchievement[] }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const unlocked = useMemo(() => achievements
    .filter((achievement) => achievement.state === "unlocked")
    .filter((achievement) => achievement.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [achievements, filter]);
  const locked = useMemo(() => achievements
    .filter((achievement) => achievement.state === "locked")
    .filter((achievement) => achievement.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [achievements, filter]);
  const mostRecent = [...unlocked]
    .filter((achievement) => achievement.updatedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const earnedXp = unlocked.reduce((sum, achievement) => sum + achievement.experiencePoints, 0);
  const totalXp = achievements.reduce((sum, achievement) => sum + achievement.experiencePoints, 0);

  return (
    <div className="player-achievements-view">
      <div className="player-achievement-summary surface-panel">
        <div><strong>{unlocked.length}</strong><span>{t("playerCard.achievements.unlocked")}</span></div>
        <div><strong>{locked.length}</strong><span>{t("playerCard.achievements.locked")}</span></div>
        <div><strong>{t("playerCard.achievements.progress", { current: formatNumber(earnedXp), total: formatNumber(totalXp) })}</strong><span>{t("playerCard.achievements.experience")}</span></div>
        {mostRecent && <div className="player-recent-achievement"><span>{t("playerCard.achievements.mostRecent")}</span><strong>{mostRecent.name}</strong><small className="muted">{formatDate(mostRecent.updatedAt)}</small></div>}
      </div>
      <label className="player-card-search"><span>{t("playerCard.achievements.filter")}</span><input value={filter} placeholder={t("playerCard.achievements.filterPlaceholder")} onChange={(event) => setFilter(event.target.value)} /></label>
      <h3>{t("playerCard.achievements.unlockedHeading", { count: unlocked.length })}</h3>
      <div className="player-achievement-grid">{unlocked.map((achievement) => <AchievementCard key={achievement.id} achievement={achievement} />)}</div>
      <h3>{t("playerCard.achievements.lockedHeading", { count: locked.length })}</h3>
      <div className="player-achievement-grid">{locked.map((achievement) => <AchievementCard key={achievement.id} achievement={achievement} />)}</div>
    </div>
  );
}
