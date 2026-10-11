// Who else runs this event, and who the players are told about.
//
// Two lists that look like one. `organisers` is the public one and carries
// names only; `organiserAccounts` names FAF accounts and says which of them
// chose to stay off the public list. An organiser who hides is still an
// organiser: hiding changes the credit, not the rights.
//
// Adding and removing are both here. Any organiser may remove any other, or
// leave: the people who can add a co-organiser are the people who can remove
// one. It was the site admin's alone once, which turned every change to the
// team into a support request. The last organiser is never offered the button:
// the service refuses to leave an event with nobody to run it.
//
// Casters sit underneath because they are the same kind of decision made about
// a different kind of person: an organiser runs the event, a caster watches all
// of it. What the role actually grants is every match chat, not only the ones
// they play in. It replaced a secret link carrying a token, which is why it
// could not be offered here until the service made it an account role.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { AccountSearch, Tourney } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayRemoveOrganiser } from "../../../shared/rules/tourneyRules";
import { AccountPicker } from "./AccountPicker";

interface OrganiserPanelProps {
  event: Tourney;
  accountSearch: AccountSearch;
  busy: boolean;
  onSearchAccounts: (query: string) => void;
  onAdd: (fafId: number, name: string) => void;
  onSetVisibility: (fafId: number, hidden: boolean) => void;
  onSetCaster: (fafId: number, name: string, casting: boolean) => void;
  /** Strip organiser rights, this account's own included. */
  onRemove: (fafId: number) => void;
}

export function OrganiserPanel(props: OrganiserPanelProps) {
  const { event, busy } = props;
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [addingCaster, setAddingCaster] = useState(false);

  return (
    <div className="tournament-organisers">
      <ul className="tournament-organiser-list">
        {event.organiserAccounts.map((organiser) => (
          <li key={organiser.fafId} className="tournament-organiser">
            <span>{organiser.name}</span>
            {/* Hidden is about the public credit, not about rights, which is
                why it reads as a checkbox on the row rather than as a state the
                row is in. */}
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={organiser.hidden}
                disabled={busy}
                onChange={(changed) =>
                  props.onSetVisibility(organiser.fafId, changed.target.checked)
                }
              />
              <span>{t("tournaments.organisers.hidden")}</span>
            </label>
            {mayRemoveOrganiser(event, organiser.fafId) && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  const self = organiser.fafId === event.viewer.fafId;
                  const question = self
                    ? t("tournaments.organisers.leaveConfirm")
                    : t("tournaments.organisers.removeConfirm", { name: organiser.name });
                  if (window.confirm(question)) props.onRemove(organiser.fafId);
                }}
              >
                {t(
                  organiser.fafId === event.viewer.fafId
                    ? "tournaments.organisers.leave"
                    : "tournaments.organisers.remove",
                )}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {event.organiserAccounts.length === 1 && (
        <p className="muted">{t("tournaments.organisers.lastOne")}</p>
      )}

      {/* The website's "add myself". Manage is open to whoever has organiser
          rights, and a director on an official event or a site admin has them
          without being on the list; one click puts their own account on it,
          addressed by the id the service already told us. */}
      {event.viewer.fafId !== null &&
        !event.organiserAccounts.some((organiser) => organiser.fafId === event.viewer.fafId) && (
          <Button
            type="button"
            disabled={busy}
            title={t("tournaments.organisers.addMyselfHint")}
            onClick={() => {
              if (event.viewer.fafId !== null) props.onAdd(event.viewer.fafId, event.viewer.fafName);
            }}
          >
            {t("tournaments.organisers.addMyself")}
          </Button>
        )}

      {adding ? (
        <AccountPicker
          label={t("tournaments.organisers.fafName")}
          placeholder={t("tournaments.organisers.fafNamePlaceholder")}
          search={props.accountSearch}
          busy={busy}
          submitLabel={t("tournaments.organisers.add")}
          onQueryChange={props.onSearchAccounts}
          onPick={(login) => {
            // `add_organizer` is addressed by account, not by name, so the id
            // is resolved from the results the choice was made in. A login with
            // no match is not sendable, and the picker only offers matches.
            const account = props.accountSearch.matches.find(
              (match) => match.login.toLowerCase() === login.toLowerCase(),
            );
            if (account === undefined) return;
            props.onAdd(account.id, account.login);
            setAdding(false);
          }}
        />
      ) : (
        <Button type="button" disabled={busy} onClick={() => setAdding(true)}>
          {t("tournaments.organisers.add")}
        </Button>
      )}

      <h5>{t("tournaments.casters.heading")}</h5>
      <p className="muted">{t("tournaments.casters.hint")}</p>
      {event.casters.length > 0 && (
        <ul className="tournament-organiser-list">
          {event.casters.map((caster) => (
            <li key={caster.fafId} className="tournament-organiser">
              <span>{caster.name}</span>
              <Button
                type="button"
                disabled={busy}
                onClick={() => props.onSetCaster(caster.fafId, caster.name, false)}
              >
                {t("tournaments.casters.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {addingCaster ? (
        <AccountPicker
          label={t("tournaments.organisers.fafName")}
          placeholder={t("tournaments.organisers.fafNamePlaceholder")}
          search={props.accountSearch}
          busy={busy}
          submitLabel={t("tournaments.casters.add")}
          onQueryChange={props.onSearchAccounts}
          onPick={(login) => {
            const account = props.accountSearch.matches.find(
              (match) => match.login.toLowerCase() === login.toLowerCase(),
            );
            if (account === undefined) return;
            props.onSetCaster(account.id, account.login, true);
            setAddingCaster(false);
          }}
        />
      ) : (
        <Button type="button" disabled={busy} onClick={() => setAddingCaster(true)}>
          {t("tournaments.casters.add")}
        </Button>
      )}
    </div>
  );
}
