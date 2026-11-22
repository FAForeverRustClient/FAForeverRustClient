// The Swiss stage: one compact panel with round controls in its header,
// hairline match rows aligned on a shared score centerline, and score groups
// marked cleanly in the left gutter without repeating dividers and chips.
//
// Each match carries the record both sides brought into the round ("2-1", or
// "2-1 vs 1-2" for a floated pairing), and rounds are ordered best score group
// first. Byes follow the matches, the final sits first where no playoff
// bracket follows, and unplanned future rounds appear under "All rounds" so
// organisers can prepare their pools before pairing.

import { useContext, useState, type ReactNode } from "react";
import type { PlayerSummary, Tourney, TourneyMatch, MapSummary } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayReport, maySubmit, roundKeyOf } from "../../../shared/rules/tourneyRules";
import { useTourneyDisplay } from "../display";
import { isMyMatch, myTeamId } from "../tourneyPresentation";
import { MatchChatContext, mayOpenMatchChat } from "./matchChat";
import { MatchActions, TeamName, teamNameOf } from "./matchParts";
import { ReplayMenu } from "./ReplayMenu";
import { PoolPanel, PoolToggle } from "./RoundPool";
import {
  BYE,
  isBye,
  isSwissMatch,
  plannedSwissRounds,
  swissGroupOf,
  swissMatchRecord,
  swissRecordsBefore,
  swissRoundOrder,
} from "./swissRecords";
import { hasVeto, myVetoSteps } from "./vetoPresentation";
import type { VetoHandlers } from "./VetoPanel";
import { VetoOverlay } from "./VetoOverlay";

interface SwissRoundsProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busyMatchId: string | null;
  /** Optional stage heading when playoffs sit above the Swiss stage. */
  title?: string;
  /** Division switcher placed inline in the toolbar when divisions share no playoffs above. */
  divisionNav?: ReactNode;
  /** Whether the Swiss final belongs here, which it does unless a playoff bracket follows. */
  withFinal: boolean;
  /** Leave out the rounds not paired yet: the playoffs have taken over. */
  hideUpcoming?: boolean;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
  onWatchReplay?: (uid: number) => void;
  vault: MapSummary[];
  assetBase: string;
  veto: VetoHandlers;
}

/** Whether a match row renders any action tool, and whether any is a labelled primary step. */
function rowToolShape(
  event: Tourney,
  entry: TourneyMatch,
  masked: boolean,
  hasChat: boolean,
  hasReplayHandler: boolean,
): { any: boolean; wide: boolean } {
  const hasReplay = hasReplayHandler && entry.replayIds.length + entry.drawReplayIds.length > 0;
  if (masked) return { any: hasReplay, wide: false };
  if (isBye(entry)) return { any: false, wide: false };
  const mine = myTeamId(event);
  const pending = entry.pendingReport;
  const mayAnswer = pending !== null && isMyMatch(event, entry) && pending.byTeam !== mine;
  const reportable = mayReport(event, entry);
  const submittable = !reportable && maySubmit(event, entry);
  const playable =
    (entry.status === "ready" || entry.status === "live") &&
    entry.team1 !== null &&
    entry.team2 !== null;
  const mayHost = playable && (isMyMatch(event, entry) || event.viewer.organiser);
  const chatBtn = hasChat && mayOpenMatchChat(event, entry);
  const vetoBtn = hasVeto(event, entry);
  const owed = myVetoSteps(event, entry);
  const any = hasReplay || mayAnswer || chatBtn || mayHost || vetoBtn || reportable || submittable;
  const wide = mayAnswer || (reportable && entry.status !== "done") || submittable || owed > 0;
  return { any, wide };
}

export function SwissRounds(props: SwissRoundsProps) {
  const { event, title, divisionNav, withFinal } = props;
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const chat = useContext(MatchChatContext);
  const [openPool, setOpenPool] = useState<string | null>(null);
  const [openVeto, setOpenVeto] = useState<string | null>(null);
  /** The round on screen, the final, or all of them; unset until chosen. */
  const [view, setView] = useState<"all" | "final" | number | null>(null);

  const swiss = event.matches.filter(isSwissMatch);
  const played = swiss.reduce((most, entry) => Math.max(most, entry.round), 0);
  const planned = Math.max(plannedSwissRounds(event), played);
  const cuts = event.swissCuts;
  const withCuts = cuts.wins > 0 || cuts.losses > 0;
  const finals = withFinal ? event.matches.filter((entry) => entry.bracket === "grandFinal") : [];

  // Rounds that exist in the plan but have not been paired yet, while the
  // stage is still running: highest first, above the ones being played.
  const upcoming: number[] = [];
  if (event.status === "running" && props.hideUpcoming !== true) {
    for (let round = planned; round > played; round -= 1) upcoming.push(round);
  }
  const rounds: number[] = [];
  for (let round = played; round >= 1; round -= 1) rounds.push(round);

  // One round at a time, the newest first: the rounds are a long list of
  // results, and the one a reader came for is almost always the latest.
  const shown: "all" | "final" | number = view ?? (finals.length > 0 ? "final" : (rounds[0] ?? "all"));
  const tabs: { key: "all" | "final" | number; label: string }[] = [
    { key: "all", label: t("tournaments.bracket.allRounds") },
    ...[...rounds].reverse().map((round) => ({ key: round, label: t("tournaments.bracket.round", { round }) })),
    ...(finals.length > 0 ? [{ key: "final" as const, label: t("tournaments.swiss.final") }] : []),
  ];

  const roundLabel = (round: number): string =>
    withCuts
      ? t("tournaments.bracket.round", { round })
      : t("tournaments.swiss.roundOf", { round, total: planned });

  const cutLabel = (): string =>
    cuts.wins > 0 && cuts.losses > 0
      ? t("tournaments.swiss.cutBoth", { wins: cuts.wins, losses: cuts.losses })
      : cuts.wins > 0
        ? t("tournaments.swiss.cutWins", { wins: cuts.wins })
        : t("tournaments.swiss.cutLosses", { losses: cuts.losses });

  const singleRoundKey =
    shown === "final"
      ? roundKeyOf("grandFinal", 1)
      : typeof shown === "number"
        ? roundKeyOf("swiss", shown)
        : null;

  const singleRoundTitle =
    shown === "final"
      ? t("tournaments.swiss.final")
      : typeof shown === "number"
        ? roundLabel(shown)
        : null;

  const allSectionCount =
    (finals.length > 0 ? 1 : 0) + upcoming.length + rounds.length;
  const multiRoundView = shown === "all" && allSectionCount > 1;

  const roundSubHead = (heading: string, roundKey: string, note?: string) => (
    <header className="tournament-swiss-head">
      <h5>{heading}</h5>
      {note !== undefined && <span className="tournament-swiss-head-note muted">{note}</span>}
      <PoolToggle
        event={event}
        roundKey={roundKey}
        open={openPool === roundKey}
        onToggle={(key) => setOpenPool((held) => (held === key ? null : key))}
      />
    </header>
  );

  /**
   * One round's rows. From round 2 on, the left gutter marks the first row of
   * each score group (and every floated pairing) so every match explains why
   * its two sides met without burning full-width divider rows for single games.
   */
  const list = (
    entries: TourneyMatch[],
    records: ReturnType<typeof swissRecordsBefore>,
    grouped: boolean,
  ) => {
    const hasRecord = grouped || entries.some((entry) => isBye(entry) && entry.round > 1);
    const hasFloat =
      hasRecord &&
      entries.some((entry) => {
        const record = swissMatchRecord(entry, records);
        return record !== null && record.includes(" ");
      });
    let hasActions = false;
    let hasWideActions = false;
    for (const entry of entries) {
      const shape = rowToolShape(
        event,
        entry,
        display.masked(entry),
        chat !== null,
        props.onWatchReplay !== undefined,
      );
      if (shape.any) hasActions = true;
      if (shape.wide) hasWideActions = true;
    }

    const listClasses = [
      "tournament-swiss-list",
      hasRecord ? "has-record" : "",
      hasFloat ? "has-float" : "",
      hasActions ? "has-actions" : "",
      hasWideActions ? "has-wide-actions" : "",
    ]
      .filter(Boolean)
      .join(" ");

    let prevGroup: string | null = null;
    let shownGroupLabel = false;
    let seenMatch = false;
    let seenBye = false;

    return (
      <ol className={listClasses}>
        {entries.map((entry) => {
          if (isBye(entry)) {
            const byeBoundary = seenMatch && !seenBye;
            seenBye = true;
            return (
              <ByeRow
                key={entry.id}
                {...props}
                entry={entry}
                record={records}
                hasRecord={hasRecord}
                hasActions={hasActions}
                groupStart={byeBoundary}
              />
            );
          }
          seenMatch = true;
          const own = swissGroupOf(entry, records);
          const record = swissMatchRecord(entry, records);
          const groupStart = grouped && prevGroup !== null && own !== prevGroup;
          if (own !== prevGroup) {
            prevGroup = own;
            shownGroupLabel = false;
          }
          const floated = record !== null && record !== own;
          let shownRecord: string | null = null;
          if (grouped) {
            if (floated) {
              shownRecord = record;
            } else if (!shownGroupLabel) {
              shownRecord = own;
              shownGroupLabel = true;
            }
          } else {
            shownRecord = record;
          }
          return (
            <MatchRow
              key={entry.id}
              {...props}
              entry={entry}
              record={shownRecord}
              floated={floated}
              hasRecord={hasRecord}
              hasActions={hasActions}
              groupStart={groupStart}
              vetoOpen={openVeto === entry.id}
              onToggleVeto={() => setOpenVeto((held) => (held === entry.id ? null : entry.id))}
            />
          );
        })}
      </ol>
    );
  };

  const renderRoundBody = (round: number, showHeader: boolean) => {
    const records = swissRecordsBefore(swiss, round);
    const inRound = swiss.filter((entry) => entry.round === round);
    const ordered = swissRoundOrder(
      inRound.filter((entry) => !isBye(entry)),
      records,
    );
    const byes = inRound.filter(isBye);
    return (
      <section className="tournament-swiss-round" key={round}>
        {showHeader && roundSubHead(roundLabel(round), roundKeyOf("swiss", round))}
        {withCuts && round === played && (
          <p className="muted tournament-swiss-note">{cutLabel()}</p>
        )}
        {list([...ordered, ...byes], records, round > 1)}
      </section>
    );
  };

  const vetoEntry = openVeto === null ? undefined : event.matches.find((candidate) => candidate.id === openVeto);

  const heading = title ?? singleRoundTitle ?? t("tournaments.bracket.swiss");
  const meta =
    title !== undefined
      ? (singleRoundTitle ?? (rounds.length > 0 ? t("tournaments.bracket.roundCount", { count: rounds.length }) : null))
      : shown === "all" && rounds.length > 0
        ? t("tournaments.bracket.roundCount", { count: rounds.length })
        : null;

  return (
    <section
      className={
        multiRoundView
          ? "tournament-panel tournament-swiss-panel is-all"
          : "tournament-panel tournament-swiss-panel"
      }
    >
      <header className="tournament-swiss-toolbar">
        <div className="tournament-swiss-toolbar-lead">
          <h4>{heading}</h4>
          {meta !== null && <span className="tournament-swiss-toolbar-meta">{meta}</span>}
          {divisionNav}
        </div>
        {(tabs.length > 2 || singleRoundKey !== null) && (
          <div className="tournament-swiss-toolbar-tools">
            {tabs.length > 2 && (
              <nav className="tournament-round-nav" aria-label={t("tournaments.bracket.roundNav")}>
                {tabs.map((tab) => (
                  <button
                    type="button"
                    key={tab.key}
                    className={shown === tab.key ? "is-active" : undefined}
                    aria-pressed={shown === tab.key}
                    onClick={() => setView(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
            )}
            {singleRoundKey !== null && (
              <PoolToggle
                event={event}
                roundKey={singleRoundKey}
                open={openPool === singleRoundKey}
                onToggle={(key) => setOpenPool((held) => (held === key ? null : key))}
              />
            )}
          </div>
        )}
      </header>

      {shown === "all" ? (
        <div className={multiRoundView ? "tournament-swiss-rounds-grid is-multi-round" : "tournament-swiss-rounds-grid"}>
          {finals.length > 0 && (
            <section className="tournament-swiss-round">
              {roundSubHead(t("tournaments.swiss.final"), roundKeyOf("grandFinal", 1))}
              {list(finals, new Map(), false)}
            </section>
          )}
          {upcoming.map((round) => (
            <section className="tournament-swiss-round is-upcoming" key={`next-${round}`}>
              {roundSubHead(roundLabel(round), roundKeyOf("swiss", round), t("tournaments.swiss.notStarted"))}
              {event.viewer.organiser && (
                <p className="muted tournament-swiss-note">{t("tournaments.swiss.prepHint")}</p>
              )}
            </section>
          ))}
          {rounds.map((round) => renderRoundBody(round, true))}
        </div>
      ) : shown === "final" ? (
        finals.length > 0 && (
          <section className="tournament-swiss-round">
            {list(finals, new Map(), false)}
          </section>
        )
      ) : (
        renderRoundBody(shown, false)
      )}

      {openPool !== null && (
        <PoolPanel
          event={event}
          vault={props.vault}
          assetBase={props.assetBase}
          roundKey={openPool}
          onClose={() => setOpenPool(null)}
        />
      )}

      {vetoEntry !== undefined && hasVeto(event, vetoEntry) && (
        <VetoOverlay
          event={event}
          entry={vetoEntry}
          vault={props.vault}
          assetBase={props.assetBase}
          profiles={props.profiles}
          busy={props.busyMatchId === vetoEntry.id}
          handlers={props.veto}
          onClose={() => setOpenVeto(null)}
        />
      )}
    </section>
  );
}

interface RowProps extends SwissRoundsProps {
  entry: TourneyMatch;
  hasRecord: boolean;
  hasActions: boolean;
  groupStart: boolean;
}

function MatchRow({
  entry,
  record,
  floated,
  hasRecord,
  hasActions,
  groupStart,
  vetoOpen,
  onToggleVeto,
  ...props
}: RowProps & {
  record: string | null;
  floated: boolean;
  vetoOpen: boolean;
  onToggleVeto: () => void;
}) {
  const { event, profiles, onWatchReplay } = props;
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const masked = display.masked(entry);
  const mine = myTeamId(event);
  const busy = props.busyMatchId === entry.id;
  const pending = entry.pendingReport;
  const replays = [...entry.replayIds, ...entry.drawReplayIds];
  const state = masked ? "ready" : entry.status;

  const classes = ["tournament-swiss-match", `is-${state}`];
  if (mine !== null && (entry.team1 === mine || entry.team2 === mine)) classes.push("is-mine");
  if (groupStart) classes.push("is-group-start");

  const isWinner = (teamId: string | null) => !masked && entry.winner !== null && entry.winner === teamId;

  const side = (teamId: string | null, align: "left" | "right") => (
    <span
      className={[
        "tournament-swiss-side",
        `is-${align}`,
        isWinner(teamId) ? "is-winner" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <TeamName event={event} profiles={profiles} teamId={teamId} asPlayers={display.showPlayers} />
    </span>
  );

  /** A walkover stores the absent side at -1, which is not a score. */
  const score = (teamId: string | null, value: number | null): string =>
    value === null
      ? ""
      : teamId !== null && entry.forfeit === teamId && value < 0
        ? t("tournaments.match.forfeitShort")
        : String(value);

  const hasScore = !masked && (entry.score1 !== null || entry.score2 !== null);

  return (
    <li className={classes.join(" ")}>
      {hasRecord && (
        <span
          className={[
            "tournament-swiss-record",
            "mono",
            floated ? "is-float" : "",
            record === null ? "is-continuation" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={record !== null ? t("tournaments.swiss.recordHint") : undefined}
        >
          {record ?? ""}
        </span>
      )}
      <div className="tournament-swiss-main">
        <div className="tournament-swiss-matchup">
          {side(entry.team1, "left")}
          {masked ? (
            <span className="tournament-swiss-score is-masked">{t("tournaments.display.played")}</span>
          ) : hasScore ? (
            <span
              className={
                entry.status === "live"
                  ? "tournament-swiss-score is-scored is-live mono"
                  : "tournament-swiss-score is-scored mono"
              }
              dir="ltr"
            >
              <span className={isWinner(entry.team1) ? "is-win" : undefined}>
                {score(entry.team1, entry.score1)}
              </span>
              <span className="tournament-swiss-dash" aria-hidden>
                {" – "}
              </span>
              <span className={isWinner(entry.team2) ? "is-win" : undefined}>
                {score(entry.team2, entry.score2)}
              </span>
            </span>
          ) : entry.status === "live" ? (
            <span className="tournament-swiss-score is-live">{t("tournaments.swiss.live")}</span>
          ) : (
            <span className="tournament-swiss-vs">{t("tournaments.swiss.vs")}</span>
          )}
          {side(entry.team2, "right")}
        </div>
        {pending !== null && !masked && (
          <div className="tournament-swiss-pending">
            {t("tournaments.match.awaiting", {
              who: pending.byName || (teamNameOf(event, pending.byTeam) ?? ""),
              score: `${pending.score1}–${pending.score2}`,
            })}
          </div>
        )}
      </div>
      {hasActions && (
        <span className="tournament-swiss-actions">
          {onWatchReplay !== undefined && replays.length > 0 && (
            <ReplayMenu ids={replays} onWatch={onWatchReplay} />
          )}
          {!masked && (
            <MatchActions
              event={event}
              entry={entry}
              busy={busy}
              onReport={() => props.onReport(entry)}
              onAnswer={(accept) => props.onAnswer(entry, accept)}
              onHost={() => props.onHost(entry)}
              vetoOpen={vetoOpen}
              onToggleVeto={onToggleVeto}
            />
          )}
        </span>
      )}
    </li>
  );
}

function ByeRow({
  entry,
  record,
  hasRecord,
  hasActions,
  groupStart,
  ...props
}: RowProps & { record: ReturnType<typeof swissRecordsBefore> }) {
  const { event, profiles } = props;
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const who = entry.team1 !== BYE ? entry.team1 : entry.team2;
  const brought = entry.round > 1 && who !== null ? record.get(who) : undefined;
  const label = entry.round > 1 ? `${brought?.wins ?? 0}-${brought?.losses ?? 0}` : null;
  return (
    <li className={groupStart ? "tournament-swiss-match is-done is-bye is-group-start" : "tournament-swiss-match is-done is-bye"}>
      {hasRecord && (
        <span
          className={label === null ? "tournament-swiss-record mono is-continuation" : "tournament-swiss-record mono"}
          title={label !== null ? t("tournaments.swiss.recordHint") : undefined}
        >
          {label ?? ""}
        </span>
      )}
      <div className="tournament-swiss-main">
        <div className="tournament-swiss-matchup">
          <span className="tournament-swiss-side is-left is-winner">
            <TeamName event={event} profiles={profiles} teamId={who} asPlayers={display.showPlayers} />
          </span>
          <span className="tournament-swiss-vs is-bye">{t("tournaments.swiss.bye")}</span>
          <span className="tournament-swiss-side is-right muted">{t("tournaments.swiss.freeWin")}</span>
        </div>
      </div>
      {hasActions && <span className="tournament-swiss-actions" />}
    </li>
  );
}
