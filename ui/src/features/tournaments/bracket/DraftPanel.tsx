// The captains draft: who is on the clock, and who is left to pick.
//
// The order is the service's and is walked, not rebuilt: captains pick
// concurrently, so a locally computed turn would disagree with whoever picked
// last. Everything here reads `event.draft`.
//
// Two states, and they are different screens rather than the same one greyed
// out: before the draft, an organiser chooses the captains, by hand or as the
// top so many by rating; during it, whoever is on the clock picks from the
// pool.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { CaptainMode, PlayerSummary, Tourney, TourneyPlayer } from "../../../ipc/bindings";
import type { OrganiserActions, TeamActions } from "../tourneyActions";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerChip } from "../PlayerChip";
import {
  draftTurn,
  isLegalFrom,
  mayPick,
  mayUndoPick,
  profileOf,
  undrafted,
} from "../../../shared/rules/tourneyRules";

interface DraftPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  /** Picking, undoing a pick, and naming the captains. */
  teams: Pick<TeamActions, "draftPick" | "draftUndo" | "setCaptains">;
  /** Starting the draft, and the organiser's single-call changes. */
  organiser: Pick<OrganiserActions, "advance" | "admin">;
}

export function DraftPanel(props: DraftPanelProps) {
  const { event, busy } = props;
  const { t } = useTranslation();
  const [captains, setCaptains] = useState<string[]>(event.pendingCaptains);
  const [mode, setMode] = useState<CaptainMode>(event.captainMode);
  const [count, setCount] = useState(event.captainCount >= 2 ? String(event.captainCount) : "");

  const nameOf = (player: TourneyPlayer) => {
    const profile = profileOf(props.profiles, player);
    return profile ? <PlayerChip player={profile} overrideName={player.name} /> : player.name;
  };

  const teamName = (teamId: string) => {
    const team = event.teams.find((held) => held.id === teamId);
    const named = team?.name.trim() ?? "";
    if (named !== "") return named;
    const captain = event.players.find((player) => player.id === team?.captainId);
    return captain?.name ?? teamId;
  };

  // Before it starts: an organiser marks the captains and closes signups.
  if (event.draft === null) {
    if (!event.viewer.organiser || !isLegalFrom("startDraft", event.status)) return null;
    const eligible = event.players.filter((player) => !player.pending);
    // Worked out by the service at the moment the draft starts, so this is a
    // preview: late signups and rating corrections still move it.
    const ranked = [...eligible].sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0));
    const wanted = Number.parseInt(count, 10);
    const validCount = Number.isInteger(wanted) && wanted >= 2 && wanted <= 64;
    const teams = mode === "rating" ? (validCount ? wanted : 0) : captains.length;
    const ready = mode === "rating" ? validCount && ranked.length >= wanted : captains.length >= 2;
    const saveMode = (next: CaptainMode, typed: string) => {
      const parsed = Number.parseInt(typed, 10);
      props.organiser.admin({
        type: "setCaptainMode",
        payload: { mode: next, count: Number.isInteger(parsed) ? parsed : 0 },
      });
    };
    return (
      <section className="tournament-draft">
        <h5>{t("tournaments.draft.captainsHeading")}</h5>
        <p className="muted">
          {t("tournaments.draft.captainsAreTeams")}{" "}
          {t(event.draftSnakes ? "tournaments.draft.orderSnake" : "tournaments.draft.orderLinear")}{" "}
          {t("tournaments.draft.teamOf", { size: event.teamSize })}
        </p>
        <label className="tournament-field">
          <span>{t("tournaments.draft.howChosen")}</span>
          <select
            value={mode}
            disabled={busy}
            onChange={(changed) => {
              const next = changed.target.value as CaptainMode;
              setMode(next);
              saveMode(next, count);
            }}
          >
            <option value="manual">{t("tournaments.draft.modeManual")}</option>
            <option value="rating">{t("tournaments.draft.modeRating")}</option>
          </select>
        </label>
        {mode === "rating" ? (
          <>
            <label className="tournament-field">
              <span>{t("tournaments.draft.howMany")}</span>
              <input
                type="number"
                min={2}
                max={64}
                value={count}
                placeholder="8"
                onChange={(changed) => setCount(changed.target.value)}
                onBlur={() => {
                  if (validCount && wanted !== event.captainCount) saveMode(mode, count);
                }}
              />
              <small className="muted">{t("tournaments.draft.howManyHint")}</small>
            </label>
            <p className="muted">
              {!validCount
                ? t("tournaments.draft.previewEnter")
                : ranked.length < wanted
                  ? t("tournaments.draft.previewShort", { have: ranked.length, more: wanted - ranked.length })
                  : t("tournaments.draft.previewWould", {
                      names: ranked
                        .slice(0, wanted)
                        .map((player) => `${player.name} (${player.rating ?? "–"})`)
                        .join(", "),
                    })}
            </p>
          </>
        ) : (
          <p className="muted">{t("tournaments.draft.captainsHint")}</p>
        )}
        {mode === "manual" && (
          <ul className="tournament-entrant-list">
            {eligible.map((player) => (
              <li className="tournament-entrant" key={player.id}>
                <label className="tournament-checkbox">
                  <input
                    type="checkbox"
                    checked={captains.includes(player.id)}
                    onChange={() =>
                      setCaptains((held) =>
                        held.includes(player.id)
                          ? held.filter((id) => id !== player.id)
                          : [...held, player.id],
                      )
                    }
                  />
                  <span>{nameOf(player)}</span>
                </label>
                {player.rating !== null && <span className="muted">{player.rating}</span>}
              </li>
            ))}
          </ul>
        )}
        {teams >= 2 && (
          <p className="muted">
            {t("tournaments.draft.bracketPreview", { teams, size: event.teamSize, needed: teams * event.teamSize })}
            {eligible.length < teams * event.teamSize &&
              ` ${t("tournaments.draft.moreNeeded", { have: eligible.length, more: teams * event.teamSize - eligible.length })}`}
          </p>
        )}
        <div className="tournament-detail-actions">
          {mode === "manual" && (
            <Button disabled={busy} onClick={() => props.teams.setCaptains(captains)}>
              {t("tournaments.draft.saveCaptains")}
            </Button>
          )}
          {/* The service wants at least two, and says so. Checking here keeps
              the refusal off a button that looks ready. */}
          <Button
            variant="primary"
            disabled={busy || !ready}
            onClick={() => props.organiser.advance("startDraft")}
          >
            {t("tournaments.draft.start")}
          </Button>
        </div>
      </section>
    );
  }

  const turn = draftTurn(event);
  const pool = undrafted(event);
  const mine = mayPick(event);

  return (
    <section className="tournament-draft">
      <header className="tournament-draft-head">
        <h5>{t("tournaments.draft.heading")}</h5>
        {turn === null ? (
          <span className="muted">{t("tournaments.draft.finished")}</span>
        ) : (
          <span>
            {t("tournaments.draft.onTheClock", { team: teamName(turn) })}
            {mine && <strong> {t("tournaments.draft.yours")}</strong>}
            <span className="muted">
              {" "}
              {t("tournaments.draft.remaining", {
                count: event.draft.order.length - event.draft.current,
              })}
            </span>
          </span>
        )}
        {mayUndoPick(event) && (
          <Button disabled={busy} onClick={props.teams.draftUndo}>
            {t("tournaments.draft.undo")}
          </Button>
        )}
      </header>

      {pool.length === 0 ? (
        <p className="muted">{t("tournaments.draft.poolEmpty")}</p>
      ) : (
        <ul className="tournament-entrant-list">
          {pool.map((player) => (
            <li className="tournament-entrant" key={player.id}>
              <span className="tournament-entrant-name">{nameOf(player)}</span>
              {player.rating !== null && <span className="muted">{player.rating}</span>}
              {/* Live only for whoever is on the clock. Everyone else reads the
                  same pool, which is how a draft is followed. */}
              {mine && (
                <Button disabled={busy} onClick={() => props.teams.draftPick(player.id)}>
                  {t("tournaments.draft.pick")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
