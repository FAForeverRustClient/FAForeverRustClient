import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { ReadingLayout, type ReadingSection } from "../../shared/components/ReadingLayout";
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

/// The page's sections in order, as the contents list them: each one's anchor
/// and its title.
const SECTIONS: Array<[id: string, title: MessageKey]> = [
  ["rating-why-trueskill", "leaderboard.rating.whyTrueskillTitle"],
  ["rating-two-numbers", "leaderboard.rating.twoNumbersTitle"],
  ["rating-leaderboard-number", "leaderboard.rating.leaderboardNumberTitle"],
  ["rating-nothing-for-a-win", "leaderboard.rating.nothingForAWinTitle"],
  ["rating-teams", "leaderboard.rating.teamsTitle"],
  ["rating-balance", "leaderboard.rating.balanceTitle"],
  ["rating-which-games", "leaderboard.rating.whichGamesTitle"],
];

/// A figure from the wiki page, with the caption that says what to look at.
///
/// Loaded lazily, and sized to the image rather than to a frame, so a wide
/// chart and a square histogram both arrive without letterboxing.
function Figure({ src, alt, caption }: { src: string; alt: MessageKey; caption: MessageKey }) {
  const { t } = useTranslation();
  return (
    <figure>
      <img src={src} alt={t(alt)} loading="lazy" decoding="async" />
      <figcaption>{t(caption)}</figcaption>
    </figure>
  );
}

/// A section's heading, ranked as a guide's sections are so the page reads
/// the way the training tab's guides do.
function Heading({ id }: { id: string }) {
  const { t } = useTranslation();
  const title = SECTIONS.find(([section]) => section === id)?.[1];
  if (!title) return null;
  return <h3 id={id} className="reading-heading is-rank-1">{t(title)}</h3>;
}

/**
 * How the number on a leaderboard is arrived at.
 *
 * The FAF wiki's rating page, in the client's voice and in the wiki's own
 * order: why TrueSkill at all, then what the two numbers are, then what the
 * leaderboard does with them, then the questions people actually ask about
 * their own rating, then the balance figure, then which games count.
 *
 * The figures are the wiki's, in its sequence, and two of them appear twice
 * because the wiki uses them twice: the same pair of curves that explains a
 * new account is what explains why two equal ratings can still make a lopsided
 * game.
 *
 * The one thing the client can check for itself is the formula: a player card
 * lists a rating beside its mean and deviation, and `2260 - 3 x 139.3 = 1842`
 * is that card's own arithmetic.
 *
 * Laid out on the training tab's reading surface, the one its guides use: a
 * header like a guide page's, the text at a reading measure and the sections
 * as a contents column beside it. It opens as a dialog over the boards, so
 * whoever asks how the numbers work comes back to the row they were on.
 */
export function RatingExplainerPanel() {
  const { t } = useTranslation();
  const sections: ReadingSection[] = SECTIONS.map(([id, title]) => ({ id, text: t(title), depth: 1 }));
  return (
    // Focusable, and so where the dialog it opens in puts the caret: its first
    // control is the wiki link at the very end, and focusing that opened the
    // page scrolled to the bottom. Focus here also lets the keys scroll it.
    <div className="rating-explainer" tabIndex={0}>
      <header className="rating-explainer-head">
        <span className="rating-explainer-eyebrow">
          <Icon name="leaderboard" size={13} /> {t("leaderboard.view.ratings")}
        </span>
        <h2>{t("leaderboard.rating.explainTitle")}</h2>
        <p className="rating-explainer-lede">{t("leaderboard.rating.lede")}</p>
      </header>

      <ReadingLayout sections={sections} contentsLabel={t("common.contents")}>
        <Heading id="rating-why-trueskill" />
        <p>{t("leaderboard.rating.whyTrueskillBody")}</p>
        <p>{t("leaderboard.rating.inflation")}</p>
        <Figure
          src={trajectories}
          alt="leaderboard.rating.trajectoriesAlt"
          caption="leaderboard.rating.trajectoriesCaption"
        />

        <Heading id="rating-two-numbers" />
        <p>{t("leaderboard.rating.twoNumbersBody")}</p>
        <p>{t("leaderboard.rating.meanAndDeviation")}</p>
        <p>{t("leaderboard.rating.newAccountBody")}</p>
        <Figure
          src={newPlayerCurve}
          alt="leaderboard.rating.newPlayerAlt"
          caption="leaderboard.rating.newPlayerCaption"
        />
        <p>{t("leaderboard.rating.settledLead")}</p>
        <div className="rating-explainer-figure-pair reading-wide">
          <Figure
            src={settledPlayerCurve}
            alt="leaderboard.rating.settledAlt"
            caption="leaderboard.rating.settledCaption"
          />
          <Figure
            src={afterThirtyGamesCurve}
            alt="leaderboard.rating.afterThirtyAlt"
            caption="leaderboard.rating.afterThirtyCaption"
          />
        </div>

        <Heading id="rating-leaderboard-number" />
        <p className="rating-explainer-formula">
          <code>{t("leaderboard.rating.formula")}</code>
        </p>
        <p>{t("leaderboard.rating.formulaWhy")}</p>
        <p className="rating-explainer-aside">{t("leaderboard.rating.formulaExample")}</p>
        <p>{t("leaderboard.rating.thirtyGames")}</p>

        <Heading id="rating-nothing-for-a-win" />
        <p>{t("leaderboard.rating.nothingForAWinBody")}</p>
        <p>{t("leaderboard.rating.wentDownOnAWin")}</p>

        <Heading id="rating-teams" />
        <p>{t("leaderboard.rating.teamsBody")}</p>

        <Heading id="rating-balance" />
        <p>{t("leaderboard.rating.balanceBody")}</p>
        <p>{t("leaderboard.rating.balanceDeviation")}</p>
        <div className="rating-explainer-figure-pair reading-wide">
          <Figure
            src={newPlayerCurve}
            alt="leaderboard.rating.newPlayerAlt"
            caption="leaderboard.rating.balanceNewCaption"
          />
          <Figure
            src={afterThirtyGamesCurve}
            alt="leaderboard.rating.afterThirtyAlt"
            caption="leaderboard.rating.balanceSettledCaption"
          />
        </div>
        <p>{t("leaderboard.rating.balanceChainLead")}</p>
        <Figure
          src={skillChain}
          alt="leaderboard.rating.skillChainAlt"
          caption="leaderboard.rating.skillChainCaption"
        />
        <p className="rating-explainer-aside">{t("leaderboard.rating.balanceCaveat")}</p>

        <Heading id="rating-which-games" />
        <p>{t("leaderboard.rating.whichGamesBody")}</p>
        <p>{t("leaderboard.rating.unratedLead")}</p>
        <ul>
          <li>{t("leaderboard.rating.unratedSettings")}</li>
          <li>{t("leaderboard.rating.unratedMap")}</li>
          <li>{t("leaderboard.rating.unratedTeams")}</li>
          <li>{t("leaderboard.rating.unratedShort")}</li>
          <li>{t("leaderboard.rating.unratedSimMods")}</li>
          <li>{t("leaderboard.rating.unratedDesyncs")}</li>
        </ul>

        <div className="rating-explainer-actions reading-wide">
          <p>{t("leaderboard.rating.moreOnTheWiki")}</p>
          <Button variant="primary" onClick={() => ipc.run(openHttpsUrl(RATING_SYSTEM_WIKI))}>
            <Icon name="external" size={15} /> {t("leaderboard.rating.openWiki")}
          </Button>
        </div>
      </ReadingLayout>
    </div>
  );
}
