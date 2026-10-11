import { useEffect, useState } from "react";
import { Modal } from "../../../design-system/Modal";
import { Button } from "../../../design-system/Button";
import { Icon, type IconName } from "../../../design-system/Icon";
import type { MatchmakerQueue } from "../../../ipc/bindings";
import { openHttpsUrl } from "../../../shared/externalLinks";
import { formatClockDuration } from "../../../shared/format/durations";
import { queueTitle } from "./MatchmakerQueueCard";
import { playersPerMatch } from "./queueExplainer";
import { secondsUntil } from "./queuePopClock";
import { useTranslation } from "../../../i18n/useTranslation";
import type { MessageKey } from "../../../i18n";

/// The wiki's own matchmaker page. Linked rather than transcribed: it covers
/// the server side too, and a client dialog that drifts from it is worse than
/// a client dialog that points at it.
const MATCHMAKER_WIKI = "https://wiki.faforever.com/en/Play/Matchmaker";

/** The three steps from queueing to a game, read left to right. */
const STEPS: [MessageKey, MessageKey][] = [
  ["lobby.matchmaker.explain.step1Title", "lobby.matchmaker.explain.step1Body"],
  ["lobby.matchmaker.explain.step2Title", "lobby.matchmaker.explain.step2Body"],
  ["lobby.matchmaker.explain.step3Title", "lobby.matchmaker.explain.step3Body"],
];

/** The three things that must all hold before a queue starts a game. */
const BLOCKERS: [IconName, MessageKey, MessageKey][] = [
  ["users", "lobby.matchmaker.explain.stuckPlayersTitle", "lobby.matchmaker.explain.stuckPlayersBody"],
  ["leaderboard", "lobby.matchmaker.explain.stuckBalanceTitle", "lobby.matchmaker.explain.stuckBalanceBody"],
  ["lock", "lobby.matchmaker.explain.stuckPartyTitle", "lobby.matchmaker.explain.stuckPartyBody"],
];

/** What the server sets on every matchmaker game, and nobody can change. */
const SETTINGS: MessageKey[] = [
  "lobby.matchmaker.explain.settingShare",
  "lobby.matchmaker.explain.settingRated",
  "lobby.matchmaker.explain.settingMapPool",
  "lobby.matchmaker.explain.settingTeams",
  "lobby.matchmaker.explain.settingFaction",
];

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
 * Asked for by somebody who plays custom games and has never queued. It
 * answers three questions, each in the shape that suits it rather than in
 * paragraphs: how a game comes about (three steps), why a queue with people in
 * it can sit idle (three conditions), and what the queues hold right now (a
 * table read off the server's own data, so it cannot go stale). The fixed
 * settings close it as a row of chips. The detail lives on the wiki page.
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
  // Counted down to the instant the server named, as the queue cards are
  // (#390): the delta it sent is only true at the moment it arrived.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Modal onClose={onClose} className="matchmaker-explainer-modal" ariaLabel={t("lobby.matchmaker.explain.title")}>
      <header className="matchmaker-explainer-head">
        <h2>{t("lobby.matchmaker.explain.title")}</h2>
        <p className="muted">{t("lobby.matchmaker.explain.lede")}</p>
      </header>

      <div className="matchmaker-explainer-body">
        <Section title="lobby.matchmaker.explain.howTitle">
          <ol className="matchmaker-explainer-steps">
            {STEPS.map(([title, body], index) => (
              <li key={title}>
                <span className="matchmaker-explainer-step-number" aria-hidden>{index + 1}</span>
                <strong>{t(title)}</strong>
                <span>{t(body)}</span>
              </li>
            ))}
          </ol>
          {/* Which rating "by rating" means. The number on the queue card and
              the profile is the cautious one, and players reading it as what
              they are matched on were surprised by every pairing. */}
          <p className="matchmaker-explainer-note">
            <Icon name="info" size={14} /> {t("lobby.matchmaker.explain.ratingNote")}
          </p>
        </Section>

        <Section title="lobby.matchmaker.explain.stuckTitle">
          <ul className="matchmaker-explainer-blockers">
            {BLOCKERS.map(([icon, title, body]) => (
              <li key={title}>
                <Icon name={icon} size={16} />
                <strong>{t(title)}</strong>
                <span>{t(body)}</span>
              </li>
            ))}
          </ul>
          <p className="matchmaker-explainer-note">
            <Icon name="hourglass" size={14} /> {t("lobby.matchmaker.explain.stuckWait")}
          </p>
        </Section>

        <Section title="lobby.matchmaker.explain.queuesTitle">
          {queues.length === 0 ? (
            <p className="matchmaker-explainer-note">{t("lobby.matchmaker.explain.noQueues")}</p>
          ) : (
            <table className="matchmaker-explainer-queues">
              <thead>
                <tr>
                  <th scope="col">{t("lobby.matchmaker.explain.colQueue")}</th>
                  <th scope="col">{t("lobby.matchmaker.explain.colWaiting")}</th>
                  <th scope="col">{t("lobby.matchmaker.explain.colNext")}</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((queue) => {
                  const needed = playersPerMatch(queue);
                  return (
                    <tr key={queue.queueName}>
                      <th scope="row">{queueTitle(queue)}</th>
                      {/* Waiting against needed: half the answer to "why has
                          nothing started" is arithmetic. Green once there are
                          enough for a game, the same meaning green has on the
                          queue cards. */}
                      <td className={queue.numPlayers >= needed ? "is-enough" : undefined}>
                        {t("lobby.matchmaker.explain.waiting", { waiting: queue.numPlayers, players: needed })}
                      </td>
                      <td>{formatClockDuration(secondsUntil(queue, clock))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="lobby.matchmaker.explain.settingsTitle">
          <ul className="matchmaker-explainer-chips">
            {SETTINGS.map((setting) => (
              <li key={setting}>
                <Icon name="check" size={13} /> {t(setting)}
              </li>
            ))}
          </ul>
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
