// Who this event's organisers keep out of it.
//
// Removing somebody was always possible and never enough: nothing stopped them
// entering again the same minute. A ban here refuses their signup, an
// organiser's add and an invite alike, on this event only. A series ban or a
// site ban is somebody else's to set, and is not in this list.
//
// The person is chosen from FAF accounts rather than typed, for the same reason
// every other add in Manage works that way: the service keys a ban by account,
// and a misspelt name would ban nobody while looking as though it had.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { AccountSearch, PlayerSummary, Tourney, TourneyAdmin } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { formatDay } from "../tourneyPresentation";
import { AccountPicker } from "./AccountPicker";

interface BansPanelProps {
  event: Tourney;
  accountSearch: AccountSearch;
  busy: boolean;
  onSearchAccounts: (query: string) => void;
  onAdmin: (change: TourneyAdmin) => void;
}

/** A `YYYY-MM-DD` from the date field as midnight UTC, the way the service reads it. */
function dayToSeconds(day: string): number | null {
  if (day === "") return null;
  const millis = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

export function BansPanel({ event, accountSearch, busy, onSearchAccounts, onAdmin }: BansPanelProps) {
  const { t } = useTranslation();
  /** The account chosen to ban, before the reason and expiry are filled in. */
  const [picked, setPicked] = useState<PlayerSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");

  const reset = () => {
    setPicked(null);
    setAdding(false);
    setReason("");
    setExpires("");
  };

  return (
    <div className="tournament-bans">
      <p className="muted">{t("tournaments.bans.hint")}</p>

      {event.bans.length === 0 ? (
        <p className="muted">{t("tournaments.bans.none")}</p>
      ) : (
        <ul className="tournament-organiser-list">
          {event.bans.map((ban) => (
            <li key={ban.fafId} className="tournament-organiser tournament-ban">
              <div className="tournament-ban-who">
                <span>{ban.name}</span>
                <span className="muted">
                  {ban.expires === null
                    ? t("tournaments.bans.noExpiry")
                    : t("tournaments.bans.until", { day: formatDay(ban.expires, "") })}
                  {ban.by !== "" && ` · ${t("tournaments.bans.by", { name: ban.by })}`}
                </span>
                {ban.reason !== "" && <span className="muted">{ban.reason}</span>}
              </div>
              {/* An expired ban keeps nobody out but stays listed until it is
                  lifted, so it says which it is rather than looking live. */}
              {ban.expired && <span className="tournament-badge">{t("tournaments.bans.expired")}</span>}
              <Button
                type="button"
                disabled={busy}
                onClick={() => onAdmin({ type: "unban", payload: { fafId: ban.fafId } })}
              >
                {t("tournaments.bans.lift")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {picked !== null ? (
        <form
          className="tournament-ban-form"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            onAdmin({
              type: "ban",
              payload: {
                fafId: picked.id,
                name: picked.login,
                reason,
                expires: dayToSeconds(expires),
              },
            });
            reset();
          }}
        >
          <p>{t("tournaments.bans.banning", { name: picked.login })}</p>
          <label className="tournament-field">
            <span>{t("tournaments.bans.reason")}</span>
            <input
              value={reason}
              maxLength={300}
              placeholder={t("tournaments.bans.reasonPlaceholder")}
              onChange={(changed) => setReason(changed.target.value)}
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.bans.expires")}</span>
            <input type="date" value={expires} onChange={(changed) => setExpires(changed.target.value)} />
            <small className="muted">{t("tournaments.bans.expiresHint")}</small>
          </label>
          <div className="tournament-detail-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              {t("tournaments.bans.add")}
            </Button>
            <Button type="button" disabled={busy} onClick={reset}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : adding ? (
        <AccountPicker
          label={t("tournaments.organisers.fafName")}
          placeholder={t("tournaments.organisers.fafNamePlaceholder")}
          search={accountSearch}
          busy={busy}
          submitLabel={t("tournaments.bans.choose")}
          onQueryChange={onSearchAccounts}
          onPick={(login) => {
            // Addressed by account, so the id comes from the results the choice
            // was made in; the picker only offers matches.
            const account = accountSearch.matches.find(
              (match) => match.login.toLowerCase() === login.toLowerCase(),
            );
            if (account !== undefined) setPicked(account);
          }}
        />
      ) : (
        <Button type="button" disabled={busy} onClick={() => setAdding(true)}>
          {t("tournaments.bans.add")}
        </Button>
      )}
    </div>
  );
}
