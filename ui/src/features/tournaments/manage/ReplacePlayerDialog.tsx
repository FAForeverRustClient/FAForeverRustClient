// Putting somebody else in an entrant's place.
//
// The replacement takes over the exact place: team, seed and every result so
// far stay with it, and every match that names the place keeps naming it. Two
// ways in, as on the website: somebody already signed up without a team, or
// anyone on FAF, because the person who can actually play the next match is
// often not somebody who happened to sign up as a reserve.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { AccountSearch, Replacement, Tourney, TourneyPlayer } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { AccountPicker } from "./AccountPicker";

interface ReplacePlayerDialogProps {
  event: Tourney;
  player: TourneyPlayer;
  accountSearch: AccountSearch;
  busy: boolean;
  onSearchAccounts: (query: string) => void;
  onReplace: (replacement: Replacement) => void;
  onClose: () => void;
}

export function ReplacePlayerDialog(props: ReplacePlayerDialogProps) {
  const { event, player, busy } = props;
  const { t } = useTranslation();
  const standby = event.players
    .filter((held) => held.teamId === null && held.id !== player.id && !held.pending)
    .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0));
  const [standbyId, setStandbyId] = useState(standby[0]?.id ?? "");
  const [rating, setRating] = useState("");
  const typed = Number(rating);
  // Only sent when typed: the service asks for one where FAF has none on the
  // board that counts, and always on an unrated event.
  const ratingValue = rating.trim() !== "" && Number.isInteger(typed) && typed >= 0 && typed <= 4000 ? typed : null;

  return (
    <Modal onClose={props.onClose} className="tournament-replace-dialog" ariaLabel={player.name}>
      <h3>{t("tournaments.replace.title", { name: player.name })}</h3>
      <p className="muted">{t("tournaments.replace.hint", { name: player.name })}</p>

      {standby.length > 0 ? (
        <div className="tournament-detail-actions">
          <label className="tournament-field">
            <span>{t("tournaments.replace.fromStandby")}</span>
            <select value={standbyId} disabled={busy} onChange={(changed) => setStandbyId(changed.target.value)}>
              {standby.map((held) => (
                <option key={held.id} value={held.id}>
                  {held.name}
                  {held.rating !== null ? ` (${held.rating})` : ""}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            disabled={busy || standbyId === ""}
            onClick={() => props.onReplace({ type: "standby", payload: { playerId: standbyId } })}
          >
            {t("tournaments.replace.replace")}
          </Button>
        </div>
      ) : (
        <p className="muted">{t("tournaments.replace.noStandby")}</p>
      )}

      {/* "Or" only reads right after something to choose instead. */}
      {standby.length > 0 && <h6>{t("tournaments.replace.fromFaf")}</h6>}
      <label className="tournament-field">
        <span>{t("tournaments.replace.rating")}</span>
        <input
          type="number"
          min={0}
          max={4000}
          value={rating}
          placeholder={t("tournaments.signup.ratingPlaceholder")}
          onChange={(changed) => setRating(changed.target.value)}
        />
        <small className="muted">
          {t(event.ratingKind === "none" ? "tournaments.replace.ratingNeeded" : "tournaments.replace.ratingIfNone")}
        </small>
      </label>
      <AccountPicker
        label={t("tournaments.organisers.fafName")}
        placeholder={t("tournaments.organisers.fafNamePlaceholder")}
        search={props.accountSearch}
        busy={busy || (event.ratingKind === "none" && ratingValue === null)}
        submitLabel={t("tournaments.replace.replace")}
        onQueryChange={props.onSearchAccounts}
        onPick={(login) => {
          const account = props.accountSearch.matches.find(
            (match) => match.login.toLowerCase() === login.toLowerCase(),
          );
          if (account !== undefined) {
            props.onReplace({ type: "account", payload: { fafId: account.id, rating: ratingValue } });
          }
        }}
      />

      <div className="tournament-form-actions">
        <Button onClick={props.onClose}>{t("common.cancel")}</Button>
      </div>
    </Modal>
  );
}
