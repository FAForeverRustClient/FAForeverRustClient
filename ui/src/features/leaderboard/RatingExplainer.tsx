import type { ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { ReadingLayout, type ReadingSection } from "../../shared/components/ReadingLayout";
import { useTranslation } from "../../i18n/useTranslation";
import { formatNumber, type MessageKey } from "../../i18n";
import { BellCurves, SkillChain, TrajectoryChart } from "./RatingFigures";

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

/// A drawn figure on its own quiet panel, with the sentence that says what to
/// look at under it.
function Figure({ children, caption }: { children: ReactNode; caption: ReactNode }) {
  return (
    <figure className="rating-figure">
      <div className="rating-figure-frame">{children}</div>
      <figcaption>{caption}</figcaption>
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
 * The figures follow the wiki's sequence but are drawn here (`RatingFigures`),
 * from the numbers the text gives, and two curves appear twice because the
 * wiki uses them twice: the same pair that explains a new account is what
 * explains why two equal ratings can still make a lopsided game.
 *
 * The one thing the client can check for itself is the formula: a player card
 * lists a rating beside its mean and deviation, and `2260 - 3 x 139.3 = 1842`
 * is that card's own arithmetic, drawn as its own figure.
 *
 * Laid out on the training tab's reading surface, the one its guides use: a
 * header like a guide page's, the text at a reading measure and the sections
 * as a contents column beside it. It opens as a dialog over the boards, so
 * whoever asks how the numbers work comes back to the row they were on.
 */
export function RatingExplainerPanel() {
  const { t } = useTranslation();
  const sections: ReadingSection[] = SECTIONS.map(([id, title]) => ({ id, text: t(title), depth: 1 }));
  const games = (count: number) => t("leaderboard.rating.figure.games", { count, formatted: formatNumber(count) });
  return (
    // Focusable, and so where the dialog it opens in puts the caret: its first
    // control is the wiki link at the very end, and focusing that opened the
    // page scrolled to the bottom. Focus here also lets the keys scroll it.
    <div className="rating-explainer" tabIndex={0}>
      {/* The title says what the page is; the label over it repeated the tab. */}
      <header className="rating-explainer-head">
        <h2>{t("leaderboard.rating.explainTitle")}</h2>
        <p className="rating-explainer-lede">{t("leaderboard.rating.lede")}</p>
      </header>

      <ReadingLayout sections={sections} contentsLabel={t("common.contents")}>
        <Heading id="rating-why-trueskill" />
        <p>{t("leaderboard.rating.whyTrueskillBody")}</p>
        <p>{t("leaderboard.rating.inflation")}</p>
        <Figure caption={t("leaderboard.rating.trajectoriesCaption")}>
          <TrajectoryChart ariaLabel={t("leaderboard.rating.trajectoriesAlt")} />
        </Figure>

        <Heading id="rating-two-numbers" />
        <p>{t("leaderboard.rating.twoNumbersBody")}</p>
        <p>{t("leaderboard.rating.meanAndDeviation")}</p>
        <p>{t("leaderboard.rating.newAccountBody")}</p>
        <Figure caption={t("leaderboard.rating.newPlayerCaption")}>
          <BellCurves
            curves={[{ mean: 1500, deviation: 500, label: t("leaderboard.rating.figure.newAccount"), tone: "focus" }]}
            domain={[0, 3000]}
            tickStep={500}
            ariaLabel={t("leaderboard.rating.newPlayerAlt")}
          />
        </Figure>
        <p>{t("leaderboard.rating.settledLead")}</p>
        {/* One axis for all three, so the narrowing is the picture: drawn
            apart, each to its own scale, they were the same curve three
            times. The new account stays as the yardstick, receded. */}
        <Figure
          caption={(
            <>
              <span>{t("leaderboard.rating.settledCaption")}</span>{" "}
              <span>{t("leaderboard.rating.afterThirtyCaption")}</span>
            </>
          )}
        >
          <BellCurves
            curves={[
              { mean: 1500, deviation: 500, label: t("leaderboard.rating.figure.newAccount"), labelAt: 2700, tone: "context" },
              { mean: 1188, deviation: 91, label: games(30), tone: "focus" },
              { mean: 2189, deviation: 57, label: games(500), tone: "focus" },
            ]}
            domain={[0, 3000]}
            tickStep={500}
            ariaLabel={`${t("leaderboard.rating.settledAlt")}. ${t("leaderboard.rating.afterThirtyAlt")}.`}
          />
        </Figure>

        <Heading id="rating-leaderboard-number" />
        <p className="rating-explainer-formula">
          <code>{t("leaderboard.rating.formula")}</code>
        </p>
        <p>{t("leaderboard.rating.formulaWhy")}</p>
        {/* The page's own example, drawn: the listed number is three
            deviations under the middle of the curve, which is the formula
            above as a picture. */}
        <Figure caption={t("leaderboard.rating.formulaExample")}>
          <BellCurves
            curves={[{ mean: 2260, deviation: 139.3, tone: "focus" }]}
            domain={[1500, 3000]}
            tickStep={250}
            markers={[
              { value: 2260, label: `${t("leaderboard.rating.figure.mean")} ${formatNumber(2260)}` },
              { value: 1842, label: `${t("leaderboard.rating.figure.listed")} ${formatNumber(1842)}` },
            ]}
            span={{ from: 1842, to: 2260, label: `3 × ${formatNumber(139.3)}` }}
            ariaLabel={t("leaderboard.rating.formulaExample")}
          />
        </Figure>
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
          <Figure caption={t("leaderboard.rating.balanceNewCaption")}>
            <BellCurves
              curves={[{ mean: 1500, deviation: 500, tone: "focus" }]}
              domain={[0, 3000]}
              tickStep={1000}
              width={300}
              ariaLabel={t("leaderboard.rating.newPlayerAlt")}
            />
          </Figure>
          <Figure caption={t("leaderboard.rating.balanceSettledCaption")}>
            <BellCurves
              curves={[{ mean: 1188, deviation: 91, tone: "focus" }]}
              domain={[0, 3000]}
              tickStep={1000}
              width={300}
              ariaLabel={t("leaderboard.rating.afterThirtyAlt")}
            />
          </Figure>
        </div>
        <p>{t("leaderboard.rating.balanceChainLead")}</p>
        <Figure caption={t("leaderboard.rating.skillChainCaption")}>
          <SkillChain ariaLabel={t("leaderboard.rating.skillChainAlt")} />
        </Figure>
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
