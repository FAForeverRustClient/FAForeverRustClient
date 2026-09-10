import { Modal } from "../../design-system/Modal";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";
import { openHttpsUrl } from "../../shared/externalLinks";
import { formatClockDuration } from "../../shared/durations";
import { ratingForQueue } from "./matchmakerRatings";
import { queueTitle } from "./MatchmakerQueueCard";
import { queuedRatingBands, shareConditionFor } from "./queueExplainer";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";

/// The wiki's own matchmaker page. Linked rather than transcribed: it covers
/// the server side too, and a client dialog that drifts from it is worse than
/// a client dialog that points at it.
const MATCHMAKER_WIKI = "https://wiki.faforever.com/en/Play/Matchmaker";

function Section({ title, children }: { title: MessageKey; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="matchmaker-explainer-section">
      <h3>{t(title)}</h3>
      {children}
    </section>
  );
}

/**
 * What a queue is, and what it will do to you.
 *
 * Asked for by somebody who plays custom games and has never queued: the
 * settings a matchmaker game runs under are not written anywhere in the
 * client, and neither is the answer to "how far apart can my opponent and I
 * be". Both are the sort of thing an experienced player forgets is invisible.
 *
 * The prose is prose. The two things that would go stale, the share condition
 * and the rating bands, are read off the server's own data instead: see
 * `queueExplainer.ts` for why a band is reported as a width and not as two
 * ratings, and why a queue whose name says nothing about sharing gets no line
 * rather than a guess.
 *
 * A dialog rather than a fourth panel on a screen that already has three: this
 * is read once, by somebody who has just arrived, and then never again.
 */
export function MatchmakerExplainer({
  queues,
  ratings,
  onClose,
}: {
  queues: MatchmakerQueue[];
  ratings: PlayerRatingSummary[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal onClose={onClose} className="matchmaker-explainer-modal" ariaLabel={t("lobby.matchmaker.explain.title")}>
      <header className="matchmaker-explainer-head">
        <h2>{t("lobby.matchmaker.explain.title")}</h2>
        <p className="muted">{t("lobby.matchmaker.explain.lede")}</p>
      </header>

      <div className="matchmaker-explainer-body">
        <Section title="lobby.matchmaker.explain.howTitle">
          <p>{t("lobby.matchmaker.explain.howBody")}</p>
          <p>{t("lobby.matchmaker.explain.howWidening")}</p>
        </Section>

        <Section title="lobby.matchmaker.explain.queuesTitle">
          {queues.length === 0 ? (
            <p className="muted">{t("lobby.matchmaker.explain.noQueues")}</p>
          ) : (
            <ul className="matchmaker-explainer-queues">
              {queues.map((queue) => {
                const rating = ratingForQueue(ratings, queue.queueName);
                const share = shareConditionFor(rating);
                const bands = queuedRatingBands(queue);
                return (
                  <li key={queue.queueName}>
                    <strong>{queueTitle(queue)}</strong>
                    <span className="matchmaker-explainer-facts">
                      <span>{t("lobby.matchmaker.explain.teamSize", { count: queue.teamSize })}</span>
                      {share && (
                        <span>
                          {t(share === "fullShare"
                            ? "lobby.matchmaker.explain.fullShare"
                            : "lobby.matchmaker.explain.shareUntilDeath")}
                        </span>
                      )}
                      <span>
                        {t("lobby.matchmaker.explain.popEvery", {
                          duration: formatClockDuration(queue.queuePopTimeSeconds),
                        })}
                      </span>
                      {/* The concrete answer to the question that started this:
                          how far apart two ratings in one game can be. */}
                      <span>
                        {bands
                          ? t("lobby.matchmaker.explain.bands", {
                              narrowest: bands.narrowest,
                              widest: bands.widest,
                              searches: bands.searches,
                            })
                          : t("lobby.matchmaker.explain.noBands")}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted">{t("lobby.matchmaker.explain.bandsNote")}</p>
        </Section>

        <Section title="lobby.matchmaker.explain.settingsTitle">
          <p>{t("lobby.matchmaker.explain.settingsBody")}</p>
          <ul>
            <li>{t("lobby.matchmaker.explain.settingRated")}</li>
            <li>{t("lobby.matchmaker.explain.settingMapPool")}</li>
            <li>{t("lobby.matchmaker.explain.settingTeams")}</li>
            <li>{t("lobby.matchmaker.explain.settingFaction")}</li>
          </ul>
        </Section>

        <Section title="lobby.matchmaker.explain.partyTitle">
          <p>{t("lobby.matchmaker.explain.partyBody")}</p>
        </Section>
      </div>

      <footer className="matchmaker-explainer-foot">
        <Button onClick={() => void openHttpsUrl(MATCHMAKER_WIKI)}>
          <Icon name="external" size={14} /> {t("lobby.matchmaker.explain.wiki")}
        </Button>
        <Button variant="primary" onClick={onClose}>{t("lobby.matchmaker.explain.close")}</Button>
      </footer>
    </Modal>
  );
}
