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

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { Trainer } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  trainers: Trainer[];
  /** The training Discord, when the catalogue names one. */
  discordUrl: string;
}

const openPlayerCard = (trainer: Trainer) =>
  ipc.send({
    kind: "PlayerCard",
    command: { type: "open", payload: { playerId: trainer.fafId, login: trainer.name } },
  });

export function TrainerTiles({ trainers, discordUrl }: Props) {
  const { t } = useTranslation();
  if (trainers.length === 0) return null;

  return (
    <section className="training-trainers">
      <header className="training-section-head">
        <div>
          <h3>{t("training.trainers.title")}</h3>
          <p className="muted">{t("training.trainers.lead")}</p>
        </div>
        {discordUrl && (
          <span className="muted training-count">{t("training.trainers.viaDiscord")}</span>
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

              {!trainer.accepting && (
                // Listed rather than hidden: "this person coaches, just not
                // right now" is more useful than a name that vanished.
                <p className="muted training-trainer-paused">{t("training.trainers.paused")}</p>
              )}

              <footer className="training-card-actions">
                {trainer.fafId !== null ? (
                  <Button onClick={() => openPlayerCard(trainer)}>
                    <Icon name="users" size={15} /> {t("training.trainers.profile")}
                  </Button>
                ) : (
                  trainer.discord && (
                    <span className="muted training-trainer-handle">
                      <Icon name="chat" size={13} /> {trainer.discord}
                    </span>
                  )
                )}
                {trainer.fafId !== null && trainer.discord && (
                  <span className="muted training-trainer-handle" title={t("training.trainers.discordHandle")}>
                    <Icon name="chat" size={13} /> {trainer.discord}
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
