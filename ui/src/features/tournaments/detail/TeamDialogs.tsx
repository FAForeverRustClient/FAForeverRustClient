// The small choices the Teams section asks for: who becomes captain, which
// entering team a waiting one replaces, and which free agent a new team starts
// around. Each is one select and one button, so they share a shape.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { TourneyPlayer, TourneyTeam } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";

interface ChoiceDialogProps {
  title: string;
  hint: string;
  label: string;
  options: { id: string; label: string }[];
  confirm: string;
  busy: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

function ChoiceDialog({ title, hint, label, options, confirm, busy, onPick, onClose }: ChoiceDialogProps) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState(options[0]?.id ?? "");
  return (
    <Modal onClose={onClose} className="tournament-choice-dialog" ariaLabel={title}>
      <h3>{title}</h3>
      <p className="muted">{hint}</p>
      <label className="tournament-field">
        <span>{label}</span>
        <select value={chosen} disabled={busy} onChange={(changed) => setChosen(changed.target.value)}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="tournament-form-actions">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy || chosen === ""} onClick={() => onPick(chosen)}>
          {confirm}
        </Button>
      </div>
    </Modal>
  );
}

/** Hand the captaincy to another member. A real transfer, not a label. */
export function ChangeCaptainDialog(props: {
  team: TourneyTeam;
  teamName: string;
  members: TourneyPlayer[];
  busy: boolean;
  onPick: (playerId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const current = props.members.find((member) => member.id === props.team.captainId)?.name ?? "";
  return (
    <ChoiceDialog
      title={t("tournaments.teams.changeCaptainTitle", { team: props.teamName })}
      hint={t("tournaments.teams.changeCaptainHint", { name: current })}
      label={t("tournaments.teams.newCaptain")}
      options={props.members
        .filter((member) => member.id !== props.team.captainId)
        .map((member) => ({ id: member.id, label: member.name }))}
      confirm={t("tournaments.teams.makeCaptain")}
      busy={props.busy}
      onPick={props.onPick}
      onClose={props.onClose}
    />
  );
}

/** Put a waiting team in the place of one that is entering. */
export function SwapInDialog(props: {
  teamName: string;
  participants: { id: string; label: string }[];
  busy: boolean;
  onPick: (outId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceDialog
      title={t("tournaments.teams.swapTitle", { team: props.teamName })}
      hint={t("tournaments.teams.swapHint")}
      label={t("tournaments.teams.swapOut")}
      options={props.participants}
      confirm={t("tournaments.teams.swap")}
      busy={props.busy}
      onPick={props.onPick}
      onClose={props.onClose}
    />
  );
}

/** Start a team around a free agent, who becomes its captain. */
export function TeamFromFreeAgentDialog(props: {
  freeAgents: TourneyPlayer[];
  busy: boolean;
  onCreate: (playerId: string, name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [playerId, setPlayerId] = useState(props.freeAgents[0]?.id ?? "");
  const [name, setName] = useState("");
  return (
    <Modal onClose={props.onClose} className="tournament-choice-dialog" ariaLabel={t("tournaments.teams.fromFreeAgent")}>
      <h3>{t("tournaments.teams.fromFreeAgent")}</h3>
      <label className="tournament-field">
        <span>{t("tournaments.teams.fromFreeAgentPlayer")}</span>
        <select value={playerId} disabled={props.busy} onChange={(changed) => setPlayerId(changed.target.value)}>
          {props.freeAgents.map((player) => (
            <option key={player.id} value={player.id}>
              {player.name}
            </option>
          ))}
        </select>
      </label>
      <label className="tournament-field">
        <span>{t("tournaments.teams.fromFreeAgentName")}</span>
        <input value={name} maxLength={30} onChange={(changed) => setName(changed.target.value)} />
      </label>
      <div className="tournament-form-actions">
        <Button onClick={props.onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={props.busy || playerId === ""}
          onClick={() => props.onCreate(playerId, name)}
        >
          {t("tournaments.teams.create")}
        </Button>
      </div>
    </Modal>
  );
}
