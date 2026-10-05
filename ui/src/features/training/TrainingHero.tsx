// The top of the hub: the two things a player who wants to improve should be
// offered before anything else.
//
// A replay review, because it is the highest-value thing FAF's training
// community does and the hardest to reach (find the Discord, find the channel,
// read the pinned template, fill it in, dig out the replay id). And the
// community itself, because the client is a discovery layer over it and not a
// replacement for it: the human half of training is not something a tab can do.
//
// Built the way the replay detail is: a headline block with the way in on it,
// and under a hairline the facts it rests on, as one strip of labelled values
// rather than a box of lists beside it.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { TrainingLinks, TrainingProfile } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { MapThumbnail } from "../../shared/components/MapThumbnail";
import { mapPresentation } from "../../shared/mapPresentation";
import { useAppStore } from "../../store/store";

interface Props {
  links: TrainingLinks;
  profile: TrainingProfile;
  onRequestReview: () => void;
  /** Jump to the recommendation rail, for the "not sure where to start" line. */
  onShowRecommended: () => void;
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
  hasRecommendations,
}: Props) {
  const { t } = useTranslation();
  const ratings = ratingEntries(profile, t);
  // Past reviews live in the review channel itself: that is where they are
  // asked for and answered, and there is no archive of them anywhere else.
  // The invite is the fallback, for a catalogue that names no channel.
  const reviewsUrl = links.replayReviewChannel || links.discordUrl;

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
          {/* Named for where it goes. This is FAF's whole community server,
              not a training room, and a button that only reveals it opens
              Discord once it has been pressed is a surprise. Only drawn when
              the catalogue names an invite: a guessed one is worse than none. */}
          {links.discordUrl && (
            <Button
              onClick={() => void openHttpsUrl(links.discordUrl)}
              title={t("training.hero.openDiscordHint")}
            >
              <Icon name="discord" size={16} /> {t("training.hero.openDiscord")}
              <Icon name="external" size={12} className="training-hero-external" />
            </Button>
          )}
          {reviewsUrl && (
            <Button onClick={() => void openHttpsUrl(reviewsUrl)}>
              <Icon name="discord" size={16} /> {t("training.hero.pastReviews")}
              <Icon name="external" size={12} className="training-hero-external" />
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

          The replay detail's facts strip: a label over each value, hairlines
          between them, and the sentence saying where it was read from on the
          strip's own heading line. */}
      <section className="training-basis" aria-labelledby="training-basis-title">
        <header className="training-basis-head">
          <h3 id="training-basis-title">{t("training.profile.title")}</h3>
          <span className="muted">
            {profile.gamesSeen === 0
              ? t("training.profile.noGames")
              : t("training.profile.basis", { count: profile.gamesSeen })}
          </span>
        </header>

        <dl className="training-basis-facts">
          {ratings.length > 0 ? (
            ratings.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))
          ) : (
            <div>
              <dt>{t("training.profile.rating")}</dt>
              <dd className={profile.rating === null ? "is-unknown" : undefined}>
                {profile.rating === null ? t("training.profile.unknown") : profile.rating}
              </dd>
            </div>
          )}
          <div className="training-basis-modes">
            <dt>{t("training.profile.modes")}</dt>
            <dd className={profile.gameModes.length === 0 ? "is-unknown" : undefined}>
              {profile.gameModes.length === 0
                ? t("training.profile.unknown")
                : profile.gameModes.slice(0, 4).join(" · ")}
            </dd>
          </div>
        </dl>

        <div className="training-basis-maps">
          <span className="training-basis-label">{t("training.profile.maps")}</span>
          {profile.maps.length === 0 ? (
            <span className="muted">{t("training.profile.unknown")}</span>
          ) : (
            <ul>
              {profile.maps.slice(0, 3).map((map) => (
                <RecentMap key={map} map={map} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </section>
  );
}

/**
 * One map the player has been on, as the replay list shows a map: its preview
 * and its name.
 *
 * The profile names a vault map by the folder its replay recorded
 * (`setons_clutch_-_faf_version.v0004`), which is an address rather than a
 * name. The vault and the base-game table turn it into the one a player reads,
 * the same lookup every other map label in the client goes through.
 */
function RecentMap({ map }: { map: string }) {
  const vault = useAppStore((store) => store.state.maps.vault);
  const name = mapPresentation(vault, map).displayName;
  return (
    <li title={name}>
      <MapThumbnail
        mapName={map}
        vault={vault}
        className="training-basis-map-thumb"
        placeholderClassName="training-basis-map-thumb is-empty"
        iconSize={14}
      />
      <span>{name}</span>
    </li>
  );
}
