import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useTranslation } from "../../i18n/useTranslation";

/// The wiki's own page on the rating system, which is where the numbers this
/// panel deliberately does not quote are kept up to date.
const RATING_SYSTEM_WIKI = "https://wiki.faforever.com/en/Infrastructure/Rating-System";

/**
 * What the number on a leaderboard actually is.
 *
 * Everything stated here is arithmetic this client can see for itself: a
 * player card lists a rating beside its mean and deviation, and
 * `1842 = 2260 - 3 x 139.3` is that card's own numbers. Nothing in it is a
 * claim about the server the client cannot check, which is why it names no
 * starting values and no thresholds. Those live on the wiki, and the link at
 * the bottom is how a reader who wants them gets there.
 *
 * A third tab rather than a dialog: the issue asked for one, and prose that a
 * reader has to keep a modal open to consult is prose they will not consult.
 * It is not a `LeaderboardMode` though. That enum is a domain type mirrored
 * into the store and the conformance fixture, and this page fetches nothing,
 * has no status and cannot go stale.
 */
export function RatingExplainerPanel() {
  const { t } = useTranslation();
  return (
    <section className="rating-explainer surface-panel">
      <h2>{t("leaderboard.rating.explainTitle")}</h2>

      <section>
        <h3>{t("leaderboard.rating.twoNumbersTitle")}</h3>
        <p>{t("leaderboard.rating.twoNumbersBody")}</p>
        <p className="rating-explainer-formula">
          <code>{t("leaderboard.rating.formula")}</code>
        </p>
        <p className="muted">{t("leaderboard.rating.formulaExample")}</p>
      </section>

      <section>
        <h3>{t("leaderboard.rating.newAccountTitle")}</h3>
        <p>{t("leaderboard.rating.newAccountBody")}</p>
      </section>

      <section>
        <h3>{t("leaderboard.rating.perQueueTitle")}</h3>
        <p>{t("leaderboard.rating.perQueueBody")}</p>
      </section>

      <section>
        <h3>{t("leaderboard.rating.leaguesTitle")}</h3>
        <p>{t("leaderboard.rating.leaguesBody")}</p>
      </section>

      <div className="rating-explainer-actions">
        <p className="muted rating-explainer-more">{t("leaderboard.rating.moreOnTheWiki")}</p>
        <Button variant="primary" onClick={() => ipc.run(openHttpsUrl(RATING_SYSTEM_WIKI))}>
          <Icon name="external" size={15} /> {t("leaderboard.rating.openWiki")}
        </Button>
      </div>
    </section>
  );
}
