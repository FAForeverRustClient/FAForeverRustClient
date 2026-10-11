// A list of bans with a way to add one, for any of the three scopes: a whole
// series, or every official tournament (the console's). The website's
// `banPanel`, shared by both; an event's own bans keep their own panel.
//
// Accounts are chosen from FAF's own search rather than typed, as everywhere
// else an account is added: the service keys a ban by FAF id.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { AccountSearch, PlayerSummary, TourneyBan } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { AccountPicker } from "../manage/AccountPicker";

/** A `YYYY-MM-DD` as midnight UTC, the way the service reads an expiry. */
function dayToSeconds(day: string): number | null {
  if (day === "") return null;
  const millis = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

/** Pick one FAF account from the shared search, then act on it. */
export function AccountAdder({
  label,
  submitLabel,
  search,
  busy,
  onSearch,
  onAdd,
}: {
  label: string;
  submitLabel: string;
  search: AccountSearch;
  busy: boolean;
  onSearch: (query: string) => void;
  onAdd: (account: PlayerSummary) => void;
}) {
  return (
    <AccountPicker
      label={label}
      search={search}
      busy={busy}
      submitLabel={submitLabel}
      onQueryChange={onSearch}
      onPick={(login) => {
        const account = search.matches.find((match) => match.login.toLowerCase() === login.toLowerCase());
        if (account !== undefined) onAdd(account);
      }}
    />
  );
}

interface BanListProps {
  title: string;
  hint: string;
  addLabel: string;
  bans: TourneyBan[];
  search: AccountSearch;
  busy: boolean;
  onSearch: (query: string) => void;
  onBan: (account: { fafId: number; name: string }, reason: string, expires: number | null) => void;
  onLift: (fafId: number) => void;
}

export function BanList(props: BanListProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<PlayerSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const active = props.bans.filter((ban) => !ban.expired).length;
  const expired = props.bans.length - active;
  const reset = () => {
    setPicked(null);
    setAdding(false);
    setReason("");
    setExpires("");
  };
  return (
    <section className="surface tournament-site-panel">
      <h3>
        {props.title}{" "}
        <span className="muted">
          {expired > 0 ? t("tournaments.bans.countExpired", { active, expired }) : `(${active})`}
        </span>
      </h3>
      <p className="muted">{props.hint}</p>
      {props.bans.length === 0 ? (
        <p className="muted">{t("tournaments.bans.none")}</p>
      ) : (
        <table className="tournament-standings">
          <thead>
            <tr>
              <th>{t("tournaments.hall.player")}</th>
              <th>{t("tournaments.bans.reason")}</th>
              <th>{t("tournaments.bans.byColumn")}</th>
              <th>{t("tournaments.bans.expires")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.bans.map((ban) => (
              <tr key={ban.fafId}>
                <td>
                  {ban.name} {ban.expired && <span className="tournament-badge">{t("tournaments.bans.expired")}</span>}
                </td>
                <td className="muted">{ban.reason}</td>
                <td className="muted">{ban.by}</td>
                <td>
                  {/* Changeable in place, as on the website; the service keeps
                      the reason when a change sends none. */}
                  <input
                    type="date"
                    value={ban.expires === null ? "" : new Date(ban.expires * 1000).toISOString().slice(0, 10)}
                    disabled={props.busy}
                    onChange={(changed) =>
                      props.onBan({ fafId: ban.fafId, name: ban.name }, "", dayToSeconds(changed.target.value))
                    }
                  />
                  {ban.expires === null && <span className="muted"> {t("tournaments.bans.noExpiry")}</span>}
                </td>
                <td>
                  <Button
                    disabled={props.busy}
                    onClick={() => {
                      if (window.confirm(t("tournaments.bans.liftConfirm"))) props.onLift(ban.fafId);
                    }}
                  >
                    {t("tournaments.bans.lift")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {picked !== null ? (
        <form
          className="tournament-ban-form"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            props.onBan({ fafId: picked.id, name: picked.login }, reason, dayToSeconds(expires));
            reset();
          }}
        >
          <p>{t("tournaments.bans.banning", { name: picked.login })}</p>
          <label className="tournament-field">
            <span>{t("tournaments.bans.reason")}</span>
            <input value={reason} maxLength={300} onChange={(changed) => setReason(changed.target.value)} />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.bans.expires")}</span>
            <input type="date" value={expires} onChange={(changed) => setExpires(changed.target.value)} />
          </label>
          <div className="tournament-detail-actions">
            <Button type="submit" variant="primary" disabled={props.busy}>
              {props.addLabel}
            </Button>
            <Button onClick={reset}>{t("common.cancel")}</Button>
          </div>
        </form>
      ) : adding ? (
        <AccountAdder
          label={t("tournaments.organisers.fafName")}
          submitLabel={t("tournaments.bans.choose")}
          search={props.search}
          busy={props.busy}
          onSearch={props.onSearch}
          onAdd={setPicked}
        />
      ) : (
        <Button disabled={props.busy} onClick={() => setAdding(true)}>
          {props.addLabel}
        </Button>
      )}
    </section>
  );
}
