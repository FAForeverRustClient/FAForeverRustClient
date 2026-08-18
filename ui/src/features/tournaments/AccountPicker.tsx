// Choosing a FAF account by name.
//
// The reason this exists rather than a text field: the tournament server matches
// names *exactly* and refuses anything it cannot find, so a typed name is a
// guess that fails after the fact. Here the organiser sees who they are about to
// add (avatar, login, rating) and clicks the person.
//
// It reuses what the client already has rather than adding a lookup of its own:
// `PlayerCardPort::search_players` (the same batch account search behind the
// player card's picker) and `PlayerChip` (the same row the entrant lists and the
// bracket draw). Nothing here is tournament-specific except which field it fills.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { AccountSearch, PlayerSummary } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";

/**
 * How long after the last keystroke the search goes out.
 *
 * Per-keystroke would be one API request per letter for a result nobody has read
 * yet. A quarter of a second is below the point a list feels laggy and well
 * above a typing burst.
 */
const TYPING_PAUSE_MS = 250;

interface AccountPickerProps {
  /** Shown above the field. */
  label: string;
  placeholder?: string;
  /** The shared search state: one field is open at a time, so one slice serves all. */
  search: AccountSearch;
  busy: boolean;
  /** Label for the button that commits the chosen account. */
  submitLabel: string;
  onQueryChange: (query: string) => void;
  onPick: (login: string) => void;
}

export function AccountPicker(props: AccountPickerProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  // Held in a ref rather than state: it is a timer handle, and re-rendering
  // because one was scheduled would be pointless work.
  const pending = useRef<number | null>(null);

  // Debounce the query, and cancel on unmount so a search cannot land after the
  // section closed.
  useEffect(() => {
    return () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, []);

  const changed = (value: string) => {
    setTyped(value);
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => props.onQueryChange(value), TYPING_PAUSE_MS);
  };

  const pick = (login: string) => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    props.onPick(login);
    setTyped("");
  };

  // The search state is shared: the add field and the invite field are two of
  // these, and one slice serves both. So a picker shows results only while they
  // belong to *its* box, otherwise typing a name to add would drop a list of
  // clickable matches under the invite field as well.
  //
  // Prefix rather than equality, because the query is debounced and therefore
  // lags a letter or two behind the box. On equality the list would blink out on
  // every keystroke and back in when the answer caught up. A prefix still tells
  // the two fields apart: the other one holds either nothing or a different word.
  const query = props.search.query.trim().toLowerCase();
  const box = typed.trim().toLowerCase();
  const mine = box !== "" && query !== "" && box.startsWith(query);

  // Only offer the typed text directly when nothing was found: the server may
  // still know a name FAF's own search spells differently, so the escape hatch
  // stays, but as the fallback, not the primary path.
  const searched = mine;
  const found = mine ? props.search.matches : [];
  const loading = mine && props.search.status.type === "loading";
  const failed =
    mine && props.search.status.type === "failed" ? props.search.status.payload : null;

  return (
    <div className="tournament-account-picker">
      <label className="tournament-field">
        <span>{props.label}</span>
        <input
          value={typed}
          onChange={(changedEvent) => changed(changedEvent.target.value)}
          placeholder={props.placeholder}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {loading && <p className="tournament-form-hint muted">{t("tournaments.admin.searching")}</p>}

      {/* The server's own sentence: it distinguishes an expired session from a
          name nobody has, and an empty list would send the organiser hunting
          for a typo that is not there. */}
      {failed !== null && <p className="tournament-form-hint is-error">{failed.reason}</p>}

      {found.length > 0 && (
        <ul className="tournament-account-matches">
          {found.map((account: PlayerSummary) => (
            <li key={account.id}>
              <button
                type="button"
                className="tournament-account-match"
                disabled={props.busy}
                onClick={() => pick(account.login)}
              >
                <PlayerChip player={account} />
                <span className="tournament-account-add muted">{props.submitLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {searched && !loading && failed === null && found.length === 0 && (
        <div className="tournament-account-none">
          <p className="tournament-form-hint muted">{t("tournaments.admin.noAccountFound")}</p>
          {/* The tournament server has its own player table and may resolve a
              spelling FAF's search does not, so sending the name as typed is
              still allowed rather than blocked. */}
          <Button disabled={props.busy || typed.trim() === ""} onClick={() => pick(typed)}>
            <Icon name="plus" size={16} /> {t("tournaments.admin.addAnyway", { name: typed.trim() })}
          </Button>
        </div>
      )}
    </div>
  );
}
