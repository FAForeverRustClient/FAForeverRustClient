// The Swiss stage, drawn the way the website draws it: one block per round,
// the newest on top, and each round a list rather than a bracket column.
//
// A column of cards said nothing about why two teams met, because in Swiss the
// reason is not a line from an earlier match: it is the record. So each match
// carries the record both sides brought into the round ("2-1", or "2-1 vs 1-2"
// for a floated pairing), and a round is listed best score group first. Read
// top to bottom, a round explains its own pairings.
//
// Byes follow the matches, the final (where there is one and no playoff
// bracket) sits above everything, and rounds that are planned but not paired
// yet are listed so their pools can be set before they open.

import { Fragment, useState } from "react";
import type { PlayerSummary, Tourney, TourneyMatch, VaultMap } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { roundKeyOf } from "../../../shared/rules/tourneyRules";
import { myTeamId } from "../tourneyPresentation";
import { MatchActions, TeamName, teamNameOf } from "./matchParts";
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
import { hasVeto } from "./vetoPresentation";
import { VetoPanel, type VetoHandlers } from "./VetoPanel";

interface SwissRoundsProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busyMatchId: string | null;
  /** Whether the Swiss final belongs here, which it does unless a playoff bracket follows. */
  withFinal: boolean;
  /** Leave out the rounds not paired yet: the playoffs have taken over. */
  hideUpcoming?: boolean;
  onReport: (entry: TourneyMatch) => void;
  onAnswer: (entry: TourneyMatch, accept: boolean) => void;
  onHost: (entry: TourneyMatch) => void;
  vault: VaultMap[];
  assetBase: string;
  veto: VetoHandlers;
}

export function SwissRounds(props: SwissRoundsProps) {
  const { event, withFinal } = props;
  const { t } = useTranslation();
  const [openPool, setOpenPool] = useState<string | null>(null);
  const [openVeto, setOpenVeto] = useState<string | null>(null);

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

  const cutLabel = (): string =>
    cuts.wins > 0 && cuts.losses > 0
      ? t("tournaments.swiss.cutBoth", { wins: cuts.wins, losses: cuts.losses })
      : cuts.wins > 0
        ? t("tournaments.swiss.cutWins", { wins: cuts.wins })
        : t("tournaments.swiss.cutLosses", { losses: cuts.losses });

  const head = (title: string, roundKey: string, note?: string) => (
    <header className="tournament-swiss-head">
      <h5>{title}</h5>
      {note !== undefined && <span className="muted">{note}</span>}
      <PoolToggle
        event={event}
        roundKey={roundKey}
        open={openPool === roundKey}
        onToggle={(key) => setOpenPool((held) => (held === key ? null : key))}
      />
    </header>
  );

  /**
   * One round's rows. From round 2 on, each score group opens with its own
   * divider, so the reason two teams meet is read off the list rather than
   * worked out from the chips: everyone under "2-0" came in with two wins.
   */
  const list = (
    entries: TourneyMatch[],
    records: ReturnType<typeof swissRecordsBefore>,
    grouped: boolean,
  ) => {
    let group: string | null = null;
    return (
      <ol className="tournament-swiss-list">
        {entries.map((entry) => {
          if (isBye(entry)) {
            return <ByeRow key={entry.id} {...props} entry={entry} record={records} />;
          }
          const own = swissGroupOf(entry, records);
          const divider = grouped && own !== group;
          group = own;
          return (
            <Fragment key={entry.id}>
              {divider && (
                <li className="tournament-swiss-group" aria-hidden>
                  {t("tournaments.swiss.group", { record: own })}
                </li>
              )}
              <MatchRow
                {...props}
                entry={entry}
                record={swissMatchRecord(entry, records)}
                vetoOpen={openVeto === entry.id}
                onToggleVeto={() => setOpenVeto((held) => (held === entry.id ? null : entry.id))}
              />
            </Fragment>
          );
        })}
      </ol>
    );
  };

  return (
    <div className="tournament-swiss">
      {finals.length > 0 && (
        <section className="tournament-swiss-round">
          {head(t("tournaments.swiss.final"), roundKeyOf("grandFinal", 1))}
          {list(finals, new Map(), false)}
        </section>
      )}

      {upcoming.map((round) => (
        <section className="tournament-swiss-round is-upcoming" key={`next-${round}`}>
          {head(
            withCuts
              ? t("tournaments.bracket.round", { round })
              : t("tournaments.swiss.roundOf", { round, total: planned }),
            roundKeyOf("swiss", round),
            t("tournaments.swiss.notStarted"),
          )}
          {event.viewer.organiser && (
            <p className="muted tournament-swiss-note">{t("tournaments.swiss.prepHint")}</p>
          )}
        </section>
      ))}

      {rounds.map((round, index) => {
        const records = swissRecordsBefore(swiss, round);
        const inRound = swiss.filter((entry) => entry.round === round);
        const matches = swissRoundOrder(
          inRound.filter((entry) => !isBye(entry)),
          records,
        );
        const byes = inRound.filter(isBye);
        return (
          <section className="tournament-swiss-round" key={round}>
            {head(
              withCuts
                ? t("tournaments.bracket.round", { round })
                : t("tournaments.swiss.roundOf", { round, total: planned }),
              roundKeyOf("swiss", round),
            )}
            {/* The cut once, on the round being played: it is what the
                records on its matches are measured against. */}
            {withCuts && index === 0 && (
              <p className="muted tournament-swiss-note">{cutLabel()}</p>
            )}
            {list([...matches, ...byes], records, round > 1)}
          </section>
        );
      })}

      {openPool !== null && (
        <PoolPanel
          event={event}
          vault={props.vault}
          assetBase={props.assetBase}
          roundKey={openPool}
          onClose={() => setOpenPool(null)}
        />
      )}
    </div>
  );
}

interface RowProps extends SwissRoundsProps {
  entry: TourneyMatch;
}

function MatchRow({
  entry,
  record,
  vetoOpen,
  onToggleVeto,
  ...props
}: RowProps & { record: string | null; vetoOpen: boolean; onToggleVeto: () => void }) {
  const { event, profiles } = props;
  const { t } = useTranslation();
  const mine = myTeamId(event);
  const busy = props.busyMatchId === entry.id;
  const pending = entry.pendingReport;
  const classes = ["tournament-swiss-match", `is-${entry.status}`];
  if (mine !== null && (entry.team1 === mine || entry.team2 === mine)) classes.push("is-mine");

  const side = (teamId: string | null) => (
    <span
      className={
        entry.winner !== null && entry.winner === teamId
          ? "tournament-swiss-side is-winner"
          : "tournament-swiss-side"
      }
    >
      <TeamName event={event} profiles={profiles} teamId={teamId} />
    </span>
  );

  /** A walkover stores the absent side at -1, which is not a score. */
  const score = (teamId: string | null, value: number | null): string =>
    value === null
      ? ""
      : teamId !== null && entry.forfeit === teamId && value < 0
        ? t("tournaments.match.forfeitShort")
        : String(value);

  return (
    <>
      <li className={classes.join(" ")}>
        <span className="tournament-swiss-record mono" title={t("tournaments.swiss.recordHint")}>
          {record ?? ""}
        </span>
        <span className="tournament-swiss-teams">
          {side(entry.team1)}
          <span className="tournament-swiss-vs mono">{t("tournaments.swiss.vs")}</span>
          {side(entry.team2)}
        </span>
        <span className="tournament-swiss-score mono">
          {entry.score1 !== null || entry.score2 !== null
            ? `${score(entry.team1, entry.score1)} – ${score(entry.team2, entry.score2)}`
            : ""}
        </span>
        {entry.status === "live" && (
          <span className="tournament-badge is-running">{t("tournaments.swiss.live")}</span>
        )}
        {pending !== null && (
          <span className="tournament-match-pending muted">
            {t("tournaments.match.awaiting", {
              who: pending.byName || (teamNameOf(event, pending.byTeam) ?? ""),
              score: `${pending.score1}–${pending.score2}`,
            })}
          </span>
        )}
        <span className="tournament-swiss-actions">
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
        </span>
      </li>
      {/* The run opens under its own row: a list has the room a bracket
          column does not. */}
      {vetoOpen && hasVeto(event, entry) && (
        <li className="tournament-swiss-veto surface">
          <VetoPanel
            event={event}
            entry={entry}
            vault={props.vault}
            assetBase={props.assetBase}
            profiles={profiles}
            busy={busy}
            handlers={props.veto}
          />
        </li>
      )}
    </>
  );
}

function ByeRow({
  entry,
  record,
  ...props
}: RowProps & { record: ReturnType<typeof swissRecordsBefore> }) {
  const { event, profiles } = props;
  const { t } = useTranslation();
  const who = entry.team1 !== BYE ? entry.team1 : entry.team2;
  const brought = entry.round > 1 && who !== null ? record.get(who) : undefined;
  return (
    <li className="tournament-swiss-match is-done is-bye">
      <span className="tournament-swiss-record mono" title={t("tournaments.swiss.recordHint")}>
        {entry.round > 1 ? `${brought?.wins ?? 0}-${brought?.losses ?? 0}` : ""}
      </span>
      <span className="tournament-swiss-teams">
        <span className="tournament-swiss-side">
          <TeamName event={event} profiles={profiles} teamId={who} />
        </span>
        <span className="tournament-swiss-vs mono">{t("tournaments.swiss.bye")}</span>
      </span>
      <span className="tournament-swiss-score muted">{t("tournaments.swiss.freeWin")}</span>
    </li>
  );
}
