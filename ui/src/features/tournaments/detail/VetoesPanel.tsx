// The Vetoes tab: every match's ban and pick run, and its factions, in one
// place. The website's `drawVetoes`.
//
// A player sees their own matches first and can widen to all of them; an
// organiser, a caster or a spectator sees every one. Runs that still need
// something come first, newest round on top, and the settled ones follow, so
// the tab opens on what is waiting rather than on history.

import { memo, useContext, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import type { PlayerSummary, Tourney, TourneyMatch, VaultMap } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { byPlayOrder, matchLabel } from "../bracket/matchLabels";
import { TeamName } from "../bracket/matchParts";
import { isBye } from "../bracket/swissRecords";
import { VetoPanel, type VetoHandlers } from "../bracket/VetoPanel";
import { hasVeto, vetoSettled } from "../bracket/vetoPresentation";
import { MatchChatContext, mayOpenMatchChat } from "../bracket/matchChat";

interface VetoesPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  vault: VaultMap[];
  assetBase: string;
  busyMatchId: string | null;
  veto: VetoHandlers;
}

/** The matches this tab lists: a run to show, and two real sides. */
export function vetoMatches(event: Tourney): TourneyMatch[] {
  return event.matches.filter(
    (entry) => hasVeto(event, entry) && entry.team1 !== null && entry.team2 !== null && !isBye(entry),
  );
}

/** Memoised for the same reason as `BracketView`, and with the same props. */
export const VetoesPanel = memo(function VetoesPanel(props: VetoesPanelProps) {
  const { event } = props;
  const { t } = useTranslation();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const chat = useContext(MatchChatContext);

  const all = vetoMatches(event);
  const myTeam = event.viewer.memberTeamId;
  const scoped = !event.viewer.organiser && !event.viewer.caster && myTeam !== null;
  const mine = all.filter((entry) => entry.team1 === myTeam || entry.team2 === myTeam);
  const shown = scoped && scope === "mine" ? mine : all;
  // Newest round first: the one being played is the one people come for.
  const ordered = [...shown].sort((left, right) => byPlayOrder(right, left) || left.index - right.index);
  const pending = ordered.filter((entry) => !vetoSettled(event, entry));
  const settled = ordered.filter((entry) => vetoSettled(event, entry));

  const card = (entry: TourneyMatch) => {
    const tag =
      entry.veto !== null && entry.veto.done
        ? t("tournaments.vetoes.resultTag")
        : entry.status === "done"
          ? t("tournaments.vetoes.closedTag")
          : null;
    return (
      <article
        key={entry.id}
        className={vetoSettled(event, entry) ? "surface tournament-veto-card is-done" : "surface tournament-veto-card"}
      >
        <header className="tournament-veto-card-head">
          <h5>
            {tag !== null && <span className="tournament-badge">{tag}</span>}{" "}
            {matchLabel(event, entry, t)}
          </h5>
          <span className="tournament-veto-card-teams">
            <TeamName event={event} profiles={props.profiles} teamId={entry.team1} />
            <span className="muted"> {t("tournaments.swiss.vs")} </span>
            <TeamName event={event} profiles={props.profiles} teamId={entry.team2} />
          </span>
          {chat !== null && mayOpenMatchChat(event, entry) && (
            <button
              type="button"
              className="tournament-round-pool-toggle"
              title={t("tournaments.chat.matchChatHint")}
              onClick={() => chat.open(entry)}
            >
              <Icon name="chat" size={12} /> {t("tournaments.chat.matchChat")}
              {chat.unread(entry) > 0 && <span className="tournament-badge">{chat.unread(entry)}</span>}
            </button>
          )}
        </header>
        <VetoPanel
          event={event}
          entry={entry}
          vault={props.vault}
          assetBase={props.assetBase}
          profiles={props.profiles}
          busy={props.busyMatchId === entry.id}
          handlers={props.veto}
        />
      </article>
    );
  };

  return (
    <div className="tournament-vetoes">
      {scoped && (
        <div className="tournament-scope" role="group" aria-label={t("tournaments.section.vetoes")}>
          <button
            type="button"
            className={scope === "mine" ? "tournament-scope-button is-on" : "tournament-scope-button"}
            aria-pressed={scope === "mine"}
            onClick={() => setScope("mine")}
          >
            {t("tournaments.vetoes.mine", { count: mine.length })}
          </button>
          <button
            type="button"
            className={scope === "all" ? "tournament-scope-button is-on" : "tournament-scope-button"}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            {t("tournaments.vetoes.all", { count: all.length })}
          </button>
        </div>
      )}

      {shown.length === 0 && (
        <p className="muted">
          {scoped && scope === "mine"
            ? t("tournaments.vetoes.emptyMine")
            : t("tournaments.vetoes.empty")}
          {scoped && scope === "mine" && all.length > 0 && (
            <> {t("tournaments.vetoes.emptyMineOthers", { count: all.length })}</>
          )}
        </p>
      )}

      {event.status === "finished" && event.viewer.organiser && <VetoStats event={event} />}

      {pending.length > 0 && (
        <section className="tournament-vetoes-group">
          <h5 className="tournament-vetoes-label">{t("tournaments.vetoes.pending")}</h5>
          {pending.map(card)}
        </section>
      )}
      {settled.length > 0 && (
        <section className="tournament-vetoes-group">
          <h5 className="tournament-vetoes-label">{t("tournaments.vetoes.settled")}</h5>
          {settled.map(card)}
        </section>
      )}
    </div>
  );
});

/**
 * Which maps were banned most, and which were played most, once the event is
 * over. For the organiser tuning the next pool; the website's statistics panel.
 */
function VetoStats({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  const banned = new Map<string, number>();
  const played = new Map<string, number>();
  const bump = (counts: Map<string, number>, map: string) => counts.set(map, (counts.get(map) ?? 0) + 1);
  for (const entry of event.matches) {
    if (entry.veto === null) continue;
    for (const choice of entry.veto.banned) bump(banned, choice.map);
    for (const choice of entry.veto.picks) bump(played, choice.map);
    if (entry.veto.decider !== null) bump(played, entry.veto.decider.map);
  }
  if (banned.size === 0 && played.size === 0) return null;
  const nameOf = (mapId: string) => event.mapDb.find((held) => held.id === mapId)?.name ?? mapId;

  const column = (title: string, counts: Map<string, number>, kind: "ban" | "play") => {
    const rows = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
    const most = rows[0]?.[1] ?? 1;
    return (
      <div className="tournament-vstat-col">
        <h6>{title}</h6>
        {rows.map(([mapId, count]) => (
          <div className="tournament-vstat-row" key={mapId}>
            <span className="tournament-vstat-name">{nameOf(mapId)}</span>
            <span className="tournament-vstat-bar">
              <span className={`tournament-vstat-fill is-${kind}`} style={{ width: `${(count / most) * 100}%` }} />
            </span>
            <span className="mono">{count}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="surface tournament-vstat">
      <h5>{t("tournaments.vetoes.statsTitle")}</h5>
      <div className="tournament-vstat-cols">
        {column(t("tournaments.vetoes.mostBanned"), banned, "ban")}
        {column(t("tournaments.vetoes.mostPlayed"), played, "play")}
      </div>
    </section>
  );
}
