import { Modal } from "../../design-system/Modal";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MatchmakerQueue } from "../../ipc/bindings";
import { openHttpsUrl } from "../../shared/externalLinks";
import { formatClockDuration } from "../../shared/durations";
import { queueTitle } from "./MatchmakerQueueCard";
import { playersPerMatch, queuedRatingBands } from "./queueExplainer";
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
 * Asked for by somebody who plays custom games and has never queued. The
 * questions it is written to answer are about *matching*, not about settings:
 *
 * - how does the server decide who I play?
 * - how far apart can two ratings be and still be one game?
 * - eight people are queued for 3v3, so why has nothing started?
 *
 * The settings section is short because there is little to say: every
 * matchmaker game is full share and rated, and nothing else about the lobby is
 * yours to change. The rest of the dialog is the matching.
 *
 * The prose is prose. The one thing that would go stale, the rating bands, is
 * read off the server's own data instead: see `queueExplainer.ts` for why a
 * band is reported as a width and not as two ratings.
 *
 * A dialog rather than a fourth panel on a screen that already has three: this
 * is read once, by somebody who has just arrived, and then never again.
 */
export function MatchmakerExplainer({
  queues,
  onClose,
}: {
  queues: MatchmakerQueue[];
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
          <p>{t("lobby.matchmaker.explain.howQuality")}</p>
        </Section>

        {/* The question people actually ask, and the one the client is in the
            best position to answer, because it can show the numbers. */}
        <Section title="lobby.matchmaker.explain.stuckTitle">
          <p>{t("lobby.matchmaker.explain.stuckBody")}</p>
          <ul>
            <li>{t("lobby.matchmaker.explain.stuckCount")}</li>
            <li>{t("lobby.matchmaker.explain.stuckBalance")}</li>
            <li>{t("lobby.matchmaker.explain.stuckParty")}</li>
          </ul>
          <p>{t("lobby.matchmaker.explain.stuckWait")}</p>
        </Section>

        <Section title="lobby.matchmaker.explain.gapTitle">
          <p>{t("lobby.matchmaker.explain.gapBody")}</p>
        </Section>

        <Section title="lobby.matchmaker.explain.queuesTitle">
          {queues.length === 0 ? (
            <p className="muted">{t("lobby.matchmaker.explain.noQueues")}</p>
          ) : (
            <ul className="matchmaker-explainer-queues">
              {queues.map((queue) => {
                const bands = queuedRatingBands(queue);
                return (
                  <li key={queue.queueName}>
                    <strong>{queueTitle(queue)}</strong>
                    <span className="matchmaker-explainer-facts">
                      {/* How many it takes and how many are there: half the
                          answer to "why has nothing started" is arithmetic. */}
                      <span>
                        {t("lobby.matchmaker.explain.needs", {
                          players: playersPerMatch(queue),
                          waiting: queue.numPlayers,
                        })}
                      </span>
                      <span>
                        {t("lobby.matchmaker.explain.popEvery", {
                          duration: formatClockDuration(queue.queuePopTimeSeconds),
                        })}
                      </span>
                      {/* And the other half: how far apart the people waiting
                          are willing to be matched. */}
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
            <li>{t("lobby.matchmaker.explain.settingShare")}</li>
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
