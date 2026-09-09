import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * What the number on a leaderboard actually is.
 *
 * Everything here is a fact about data this client already holds and already
 * shows: a player card lists a rating beside its mean and deviation, and
 * `1842 = 2260 - 3 x 139.3` is that card's own arithmetic. Nothing in this
 * panel is a claim about the server that the client cannot see for itself,
 * which is why it names no thresholds and quotes no constants.
 *
 * A panel rather than a third leaderboard mode: `LeaderboardMode` is a domain
 * type, mirrored into the store and the conformance fixture, and a page of
 * prose is not a thing the backend has an opinion about.
 */
export function RatingExplainerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal className="rating-explainer-modal" onClose={onClose} ariaLabel={t("leaderboard.rating.explainTitle")}>
      <div className="rating-explainer">
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

        <p className="muted rating-explainer-more">{t("leaderboard.rating.moreOnTheWiki")}</p>

        <div className="rating-explainer-actions">
          <Button variant="primary" onClick={onClose}>{t("leaderboard.rating.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}

export function RatingExplainerButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      className="rating-explainer-button"
      onClick={onOpen}
      title={t("leaderboard.rating.explainTitle")}
    >
      <Icon name="info" size={15} /> {t("leaderboard.rating.explainShort")}
    </Button>
  );
}
