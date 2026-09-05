// The top of the hub: the two things a player who wants to improve should be
// offered before anything else.
//
// A replay review, because it is the highest-value thing FAF's training
// community does and the hardest to reach (find the Discord, find the channel,
// read the pinned template, fill it in, dig out the replay id). And the
// community itself, because the client is a discovery layer over it and not a
// replacement for it: the human half of training is not something a tab can do.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { TrainingLinks, TrainingProfile } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";

interface Props {
  links: TrainingLinks;
  profile: TrainingProfile;
  onRequestReview: () => void;
  /** Jump to the recommendation rail, for the "not sure where to start" line. */
  onShowRecommended: () => void;
  /** Jump to the trainer tiles, or `null` when the catalogue names none. */
  onFindTrainer: (() => void) | null;
  hasRecommendations: boolean;
}

/**
 * Every rating the client knows, most general first.
 *
 * Global leads because it is the number a player quotes about themselves; the
 * queue ratings follow in the order FAF lists its leaderboards. A mode the
 * account has never played is absent rather than shown as a zero.
 */
const RATING_ORDER = ["global", "1v1", "2v2", "3v3", "4v4"];

function ratingEntries(
  profile: TrainingProfile,
  t: ReturnType<typeof useTranslation>["t"],
): Array<[string, number]> {
  return RATING_ORDER.filter((mode) => profile.ratings[mode] !== undefined).map((mode) => [
    mode === "global" ? t("training.profile.global") : mode,
    profile.ratings[mode],
  ]);
}

export function TrainingHero({
  links,
  profile,
  onRequestReview,
  onShowRecommended,
  onFindTrainer,
  hasRecommendations,
}: Props) {
  const { t } = useTranslation();
  const ratings = ratingEntries(profile, t);

  return (
    <section className="surface-panel training-hero">
      <div className="training-hero-copy">
        <span className="training-eyebrow">{t("training.hero.eyebrow")}</span>
        <h2>{t("training.hero.title")}</h2>
        <p className="training-hero-lead">{t("training.hero.lead")}</p>

        <div className="training-hero-actions">
          <Button variant="primary" onClick={onRequestReview}>
            <Icon name="replays" size={16} /> {t("training.hero.requestReview")}
          </Button>
          {/* Only when there are tiles to scroll to. A button that jumps to an
              empty section is worse than no button. */}
          {onFindTrainer && (
            <Button onClick={onFindTrainer}>
              <Icon name="users" size={16} /> {t("training.hero.findTrainer")}
            </Button>
          )}
          {/* Only drawn when the catalogue names an invite. An empty one would
              be a button that goes nowhere, and a guessed one is worse. */}
          {links.discordUrl && (
            <Button onClick={() => void openHttpsUrl(links.discordUrl)}>
              <Icon name="chat" size={16} /> {t("training.hero.joinDiscord")}
            </Button>
          )}
        </div>

        {hasRecommendations && (
          <button type="button" className="training-hero-nudge" onClick={onShowRecommended}>
            {t("training.hero.nudge")}
          </button>
        )}
      </div>

      {/* What the client knows about this player, which is what makes the
          recommendations below more than a random list. Shown rather than
          implied: a rail nobody can account for reads as noise.

          Laid out as blocks rather than a description list, because the
          contents are lists themselves. Five ratings and three map names on
          one clipped line each was unreadable, and the ellipsis hid exactly
          the part that differs between accounts. */}
      <aside className="training-hero-profile">
        <h3>{t("training.profile.title")}</h3>

        <section className="training-profile-block">
          <h4>{t("training.profile.rating")}</h4>
          {ratings.length > 0 ? (
            // A grid, because these are five separate numbers a reader
            // compares against each other, not a sentence.
            <ul className="training-rating-grid">
              {ratings.map(([label, value]) => (
                <li key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted training-profile-empty">
              {profile.rating === null ? t("training.profile.unknown") : profile.rating}
            </p>
          )}
        </section>

        <section className="training-profile-block">
          <h4>{t("training.profile.modes")}</h4>
          {profile.gameModes.length === 0 ? (
            <p className="muted training-profile-empty">{t("training.profile.unknown")}</p>
          ) : (
            <div className="training-card-tags">
              {profile.gameModes.slice(0, 4).map((mode) => (
                <span className="training-tag" key={mode}>
                  {mode}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="training-profile-block">
          <h4>{t("training.profile.maps")}</h4>
          {profile.maps.length === 0 ? (
            <p className="muted training-profile-empty">{t("training.profile.unknown")}</p>
          ) : (
            // Wrapped, not clipped. A map name is what a reader recognises the
            // entry by, and half of one recognises nothing.
            <div className="training-card-tags">
              {profile.maps.slice(0, 3).map((map) => (
                <span className="training-tag" key={map}>
                  {map}
                </span>
              ))}
            </div>
          )}
        </section>

        <p className="muted training-hero-basis">
          {profile.gamesSeen === 0
            ? t("training.profile.noGames")
            : t("training.profile.basis", { count: profile.gamesSeen })}
        </p>
      </aside>
    </section>
  );
}
