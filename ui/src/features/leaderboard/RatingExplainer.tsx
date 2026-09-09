import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useTranslation } from "../../i18n/useTranslation";
import { type MessageKey } from "../../i18n";
import newPlayerCurve from "./assets/distribution-new-player.png";
import settledPlayerCurve from "./assets/distribution-settled-player.png";
import afterThirtyGamesCurve from "./assets/distribution-after-30-games.png";
import trajectories from "./assets/trueskill-trajectories.png";
import skillChain from "./assets/skill-chain.png";

/// The wiki's own page, which is where this text comes from and where it stays
/// current. Linked rather than copied wholesale: the page also covers the API
/// and the server, and a client tab that drifts from it is worse than no tab.
const RATING_SYSTEM_WIKI = "https://wiki.faforever.com/en/Infrastructure/Rating-System";

/// A figure from the wiki page, with the caption that says what to look at.
///
/// Loaded lazily and given fixed room by an aspect ratio, so opening the tab
/// does not reflow as five PNGs arrive.
function Figure({ src, alt, caption }: { src: string; alt: MessageKey; caption: MessageKey }) {
  const { t } = useTranslation();
  return (
    <figure className="rating-explainer-figure">
      <img src={src} alt={t(alt)} loading="lazy" decoding="async" />
      <figcaption>{t(caption)}</figcaption>
    </figure>
  );
}

function Section({ title, children }: { title: MessageKey; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="rating-explainer-section">
      <h3>{t(title)}</h3>
      {children}
    </section>
  );
}

/**
 * How the number on a leaderboard is arrived at.
 *
 * Written from the FAF wiki's own rating page, which the maintainers pointed
 * at, and kept in the client's voice rather than pasted: the wiki page is also
 * about the server and the API, and half of it answers questions a leaderboard
 * reader is not asking. What is here is what that reader asks, in the order
 * they ask it, and the link at the bottom goes to the page itself.
 *
 * The one thing the client can check for itself is the formula: a player card
 * lists a rating beside its mean and deviation, and `2260 - 3 x 139.3 = 1842`
 * is that card's own arithmetic.
 *
 * A third tab rather than a dialog: prose a reader has to hold a modal open to
 * consult is prose they will not consult. It is not a `LeaderboardMode` though.
 * That enum is a domain type mirrored into the store and the conformance
 * fixture, and this page fetches nothing, has no status and cannot go stale.
 */
export function RatingExplainerPanel() {
  const { t } = useTranslation();
  return (
    <article className="rating-explainer surface-panel">
      <header>
        <h2>{t("leaderboard.rating.explainTitle")}</h2>
        <p className="muted">{t("leaderboard.rating.lede")}</p>
      </header>

      <Section title="leaderboard.rating.twoNumbersTitle">
        <p>{t("leaderboard.rating.twoNumbersBody")}</p>
        <p>{t("leaderboard.rating.meanAndDeviation")}</p>
        <p className="rating-explainer-formula">
          <code>{t("leaderboard.rating.formula")}</code>
        </p>
        <p>{t("leaderboard.rating.formulaWhy")}</p>
        <p className="muted">{t("leaderboard.rating.formulaExample")}</p>
      </Section>

      <Section title="leaderboard.rating.newAccountTitle">
        <p>{t("leaderboard.rating.newAccountBody")}</p>
        <Figure
          src={newPlayerCurve}
          alt="leaderboard.rating.newPlayerAlt"
          caption="leaderboard.rating.newPlayerCaption"
        />
        <p>{t("leaderboard.rating.thirtyGames")}</p>
        <div className="rating-explainer-figure-pair">
          <Figure
            src={afterThirtyGamesCurve}
            alt="leaderboard.rating.afterThirtyAlt"
            caption="leaderboard.rating.afterThirtyCaption"
          />
          <Figure
            src={settledPlayerCurve}
            alt="leaderboard.rating.settledAlt"
            caption="leaderboard.rating.settledCaption"
          />
        </div>
      </Section>

      <Section title="leaderboard.rating.nothingForAWinTitle">
        <p>{t("leaderboard.rating.nothingForAWinBody")}</p>
        <p>{t("leaderboard.rating.wentDownOnAWin")}</p>
      </Section>

      <Section title="leaderboard.rating.teamsTitle">
        <p>{t("leaderboard.rating.teamsBody")}</p>
      </Section>

      <Section title="leaderboard.rating.whichGamesTitle">
        <p>{t("leaderboard.rating.whichGamesBody")}</p>
        <p>{t("leaderboard.rating.unratedLead")}</p>
        <ul className="rating-explainer-list">
          <li>{t("leaderboard.rating.unratedSettings")}</li>
          <li>{t("leaderboard.rating.unratedMap")}</li>
          <li>{t("leaderboard.rating.unratedTeams")}</li>
          <li>{t("leaderboard.rating.unratedShort")}</li>
          <li>{t("leaderboard.rating.unratedSimMods")}</li>
          <li>{t("leaderboard.rating.unratedDesyncs")}</li>
        </ul>
      </Section>

      <Section title="leaderboard.rating.balanceTitle">
        <p>{t("leaderboard.rating.balanceBody")}</p>
        <p>{t("leaderboard.rating.balanceDeviation")}</p>
        <Figure
          src={skillChain}
          alt="leaderboard.rating.skillChainAlt"
          caption="leaderboard.rating.skillChainCaption"
        />
        <p className="muted">{t("leaderboard.rating.balanceCaveat")}</p>
      </Section>

      <Section title="leaderboard.rating.whyTrueskillTitle">
        <p>{t("leaderboard.rating.whyTrueskillBody")}</p>
        <Figure
          src={trajectories}
          alt="leaderboard.rating.trajectoriesAlt"
          caption="leaderboard.rating.trajectoriesCaption"
        />
      </Section>

      <div className="rating-explainer-actions">
        <p className="muted rating-explainer-more">{t("leaderboard.rating.moreOnTheWiki")}</p>
        <Button variant="primary" onClick={() => ipc.run(openHttpsUrl(RATING_SYSTEM_WIKI))}>
          <Icon name="external" size={15} /> {t("leaderboard.rating.openWiki")}
        </Button>
      </div>
    </article>
  );
}
