// The training team, as tiles.
//
// A list, not a matching service. Who coaches, what they are good at and
// roughly which players they coach fits on a card; the actual arrangement
// happens between two people on Discord. Anything more would need every
// trainer to keep a profile current, which is the maintenance burden this tab
// exists to avoid.
//
// What the client adds over a forum post of the same list is the `fafId`: with
// it a tile is a person the client already knows things about, so the player
// card opens and a private message can be sent without leaving the client.
// Same reason a tournament entrant carries one.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { Trainer } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { topicLabel } from "./trainingPresentation";

interface Props {
  trainers: Trainer[];
  /** The training Discord, when the catalogue names one. */
  discordUrl: string;
  /** True until the catalogue has arrived. */
  loading: boolean;
}

const openPlayerCard = (trainer: Trainer) =>
  ipc.send({
    kind: "PlayerCard",
    command: { type: "open", payload: { playerId: trainer.fafId, login: trainer.name } },
  });

export function TrainerTiles({ trainers, discordUrl, loading }: Props) {
  const { t } = useTranslation();
  // The handles are what a player types into Discord's search, so they are
  // copied rather than retyped. Which one was copied last, for the feedback.
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copyHandle = (trainer: Trainer) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(trainer.discord).then(() => {
      setCopied(trainer.id);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1_500);
    });
  };
  const openDiscord = discordUrl ? () => void openHttpsUrl(discordUrl) : null;

  // An empty team is said out loud rather than drawn as a blank page with a
  // zero on its tab. The list comes with the catalogue, so the usual reason is
  // that it could not be fetched; the Discord is where the team is either way.
  if (trainers.length === 0) {
    return (
      <section className="surface-panel training-soon" aria-live="polite">
        <Icon name="users" size={26} />
        <h3>{loading ? t("training.loading") : t("training.trainers.emptyTitle")}</h3>
        {!loading && (
          <p className="muted">
            {t(openDiscord ? "training.trainers.emptyDiscord" : "training.trainers.empty")}
          </p>
        )}
        {!loading && openDiscord && (
          <div className="training-queue-actions">
            <Button variant="primary" onClick={openDiscord}>
              <Icon name="discord" size={15} /> {t("training.trainers.openDiscord")}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="training-trainers">
      <header className="training-section-head">
        <div>
          <h3>{t("training.trainers.title")}</h3>
          <p className="muted">{t("training.trainers.lead")}</p>
        </div>
        {/* A way in rather than a claim: "reachable in the training Discord"
            with no link left the reader to find the server themselves. */}
        {openDiscord && (
          <Button onClick={openDiscord}>
            <Icon name="discord" size={15} /> {t("training.trainers.openDiscord")}
          </Button>
        )}
      </header>

      <div className="training-trainer-grid">
        {trainers.map((trainer) => {
          const band = bandLabel(trainer, t);
          return (
            <article
              className={trainer.accepting ? "training-trainer" : "training-trainer is-paused"}
              key={trainer.id}
            >
              <header>
                {trainer.avatarUrl ? (
                  <img src={trainer.avatarUrl} alt="" loading="lazy" aria-hidden />
                ) : (
                  <span className="training-trainer-avatar is-empty" aria-hidden />
                )}
                <div>
                  <strong>{trainer.name}</strong>
                </div>
                {trainer.role && <span className="training-chip is-role">{trainer.role}</span>}
              </header>

              {/* The role is the only tag. Everything else a tile used to
                  carry as chips (topics, modes, the rating band, languages)
                  was a row of fragments the reader had to assemble into "what
                  is this person for"; the heading answers that directly and
                  the note says the rest. */}
              {(trainer.focus || band) && (
                <h4 className="training-trainer-focus">{trainer.focus || band}</h4>
              )}

              {trainer.note && <p className="training-trainer-note">{trainer.note}</p>}

              {/* The facts behind the heading, as labelled lines rather than
                  chips: which language a coach speaks is the one thing a
                  reader cannot work around, and it was not shown anywhere. */}
              {(trainer.topics.length > 0 ||
                trainer.gameModes.length > 0 ||
                trainer.languages.length > 0) && (
                <dl className="training-trainer-meta">
                  {trainer.topics.length > 0 && (
                    <div>
                      <dt>{t("training.trainers.topics")}</dt>
                      <dd>{trainer.topics.map((topic) => t(topicLabel(topic))).join(", ")}</dd>
                    </div>
                  )}
                  {trainer.gameModes.length > 0 && (
                    <div>
                      <dt>{t("training.trainers.modes")}</dt>
                      <dd>{trainer.gameModes.join(", ")}</dd>
                    </div>
                  )}
                  {trainer.languages.length > 0 && (
                    <div>
                      <dt>{t("training.trainers.languages")}</dt>
                      <dd>{trainer.languages.join(", ")}</dd>
                    </div>
                  )}
                </dl>
              )}

              {!trainer.accepting && (
                // Listed rather than hidden: "this person coaches, just not
                // right now" is more useful than a name that vanished.
                <p className="muted training-trainer-paused">{t("training.trainers.paused")}</p>
              )}

              <footer className="training-card-actions">
                {trainer.fafId !== null && (
                  <Button onClick={() => openPlayerCard(trainer)}>
                    <Icon name="users" size={15} /> {t("training.trainers.profile")}
                  </Button>
                )}
                {trainer.discord && (
                  <span className="training-trainer-discord">
                    <span
                      className="muted training-trainer-handle"
                      title={t("training.trainers.discordHandle")}
                    >
                      <Icon name="chat" size={13} /> {trainer.discord}
                    </span>
                    <button
                      type="button"
                      className="training-trainer-copy"
                      aria-label={t("training.trainers.copyHandle", { handle: trainer.discord })}
                      title={t("training.trainers.copyHandle", { handle: trainer.discord })}
                      onClick={() => copyHandle(trainer)}
                    >
                      <Icon name={copied === trainer.id ? "check" : "copy"} size={13} />
                    </button>
                    {/* Announced, since the icon swap alone says nothing to a
                        screen reader. */}
                    <span className="training-visually-hidden" aria-live="polite">
                      {copied === trainer.id ? t("training.trainers.copied") : null}
                    </span>
                  </span>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The rating range this trainer coaches.
 *
 * Its own wording rather than the library's `training.band.*`: on a resource
 * "1800 and up" describes the material, and on a person beside their name it
 * reads as a claim about how good *they* are. "Coaches 1800+" says whose rating
 * the number is.
 */
function bandLabel(trainer: Trainer, t: ReturnType<typeof useTranslation>["t"]): string | null {
  const { ratingMin: min, ratingMax: max } = trainer;
  if (min === null && max === null) return null;
  if (min === null) return t("training.trainers.band.upTo", { max: max as number });
  if (max === null) return t("training.trainers.band.from", { min });
  return t("training.trainers.band.between", { min, max });
}
