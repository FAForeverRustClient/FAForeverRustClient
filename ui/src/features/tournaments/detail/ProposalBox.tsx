// A tournament proposal's box on its event (#569), as the website's
// `proposalBannerHTML` draws it: for its proposer and organisers while it is
// built, waits and once it is taken over, and for a tournament director who
// may take it over or decline it. Sits where the publish banner does, which
// stays away while the proposal holds the event back.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { ConfirmDialog } from "../../../design-system/ConfirmDialog";
import type { Tourney, TourneyAdmin, TourneyCategory, TourneyProposal } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { askConfirm, askText } from "../tourneyDialogs";
import { formatMoment } from "../tourneyPresentation";
import { daysLeftText, lastStepKey, lockSentenceKey } from "../proposals";

interface ProposalBoxProps {
  event: Tourney;
  busy: boolean;
  /** This account is a site admin with its powers on. */
  siteAdmin: boolean;
  admin: (change: TourneyAdmin) => void;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** What the proposer asked, as a list: the two locks and who runs it. */
function Answers({ proposal, you }: { proposal: TourneyProposal; you: boolean }) {
  const { t } = useTranslation();
  const name = proposal.byName || t("tournaments.proposal.theProposer");
  return (
    <ul className="tournament-proposal-answers">
      <li className={proposal.lockMaps ? "is-kept" : "is-free"}>
        {t(proposal.lockMaps ? "tournaments.proposal.answerMapsKeep" : "tournaments.proposal.answerMapsFree")}
      </li>
      <li className={proposal.lockFormat ? "is-kept" : "is-free"}>
        {t(proposal.lockFormat ? "tournaments.proposal.answerFormatKeep" : "tournaments.proposal.answerFormatFree")}
      </li>
      <li>
        {you
          ? t(proposal.keep ? "tournaments.proposal.youKeep" : "tournaments.proposal.youHandOver")
          : t(proposal.keep ? "tournaments.proposal.theyKeep" : "tournaments.proposal.theyHandOver", { name })}
      </li>
    </ul>
  );
}

/** Propose it to the TD team: the two locks, who runs it, and a note. */
function SubmitDialog({ proposal, days, onSubmit, onCancel }: {
  proposal: TourneyProposal;
  days: number;
  onSubmit: (change: TourneyAdmin) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // Ticked means the director may change it, as on the website; a lock is the
  // box left unticked.
  const [mapsFree, setMapsFree] = useState(!proposal.lockMaps);
  const [formatFree, setFormatFree] = useState(!proposal.lockFormat);
  const [keep, setKeep] = useState(proposal.keep);
  const [note, setNote] = useState(proposal.note);
  return (
    <ConfirmDialog
      title={t("tournaments.proposal.submitTitle")}
      confirmLabel={t("tournaments.proposal.propose")}
      onCancel={onCancel}
      onConfirm={() =>
        onSubmit({
          type: "proposalSubmit",
          payload: { lockMaps: !mapsFree, lockFormat: !formatFree, keep, note },
        })
      }
      body={
        <div className="tournament-proposal-dialog">
          <p className="muted">{t("tournaments.proposal.submitIntro", { days })}</p>
          <fieldset>
            <legend>{t("tournaments.proposal.mayChange")}</legend>
            <label className="tournament-check">
              <input type="checkbox" checked={mapsFree} onChange={(changed) => setMapsFree(changed.target.checked)} />
              {t("tournaments.proposal.mayChangeMaps")}
            </label>
            <label className="tournament-check">
              <input type="checkbox" checked={formatFree} onChange={(changed) => setFormatFree(changed.target.checked)} />
              {t("tournaments.proposal.mayChangeFormat")}
            </label>
            <p className="muted">{t("tournaments.proposal.mayChangeHint")}</p>
          </fieldset>
          <fieldset>
            <legend>{t("tournaments.proposal.after")}</legend>
            <label className="tournament-check">
              <input type="radio" name="tournament-proposal-keep" checked={!keep} onChange={() => setKeep(false)} />
              {t("tournaments.proposal.handOver")}
            </label>
            <label className="tournament-check">
              <input type="radio" name="tournament-proposal-keep" checked={keep} onChange={() => setKeep(true)} />
              {t("tournaments.proposal.keepMe")}
            </label>
          </fieldset>
          <label className="tournament-field">
            <span>{t("tournaments.proposal.noteLabel")}</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={note}
              placeholder={t("tournaments.proposal.notePlaceholder")}
              onChange={(changed) => setNote(changed.target.value)}
            />
          </label>
          <p className="muted">{t("tournaments.proposal.frozenHint")}</p>
        </div>
      }
    />
  );
}

/**
 * Take a proposal over: run it as official or community, with a note to its
 * proposer. Shared with the console's Proposals tab.
 */
export function TakeDialog({ name, by, keep, lockMaps, lockFormat, onTake, onCancel }: {
  name: string;
  by: string;
  keep: boolean;
  lockMaps: boolean;
  lockFormat: boolean;
  onTake: (change: TourneyAdmin) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<TourneyCategory>("official");
  const [note, setNote] = useState("");
  const locks = lockSentenceKey({ lockMaps, lockFormat });
  return (
    <ConfirmDialog
      title={t("tournaments.proposal.takeTitle", { name })}
      confirmLabel={t("tournaments.proposal.takeConfirm")}
      onCancel={onCancel}
      onConfirm={() => onTake({ type: "proposalTake", payload: { category, note } })}
      body={
        <div className="tournament-proposal-dialog">
          <p>{t(keep ? "tournaments.proposal.takeKeep" : "tournaments.proposal.takeHandOver", { by })}</p>
          <p className={lockMaps || lockFormat ? "tournament-proposal-warn" : "muted"}>{t(locks, { by })}</p>
          <fieldset>
            <legend>{t("tournaments.proposal.runAs")}</legend>
            <label className="tournament-check">
              <input
                type="radio"
                name="tournament-proposal-category"
                checked={category === "official"}
                onChange={() => setCategory("official")}
              />
              {t("tournaments.proposal.runOfficial")}
            </label>
            <label className="tournament-check">
              <input
                type="radio"
                name="tournament-proposal-category"
                checked={category === "community"}
                onChange={() => setCategory("community")}
              />
              {t("tournaments.proposal.runCommunity")}
            </label>
          </fieldset>
          <label className="tournament-field">
            <span>{t("tournaments.proposal.takeNoteLabel", { by })}</span>
            <input
              maxLength={300}
              value={note}
              placeholder={t("tournaments.proposal.takeNotePlaceholder")}
              onChange={(changed) => setNote(changed.target.value)}
            />
          </label>
          <p className="muted">{t("tournaments.proposal.takePublishHint")}</p>
        </div>
      }
    />
  );
}

export function ProposalBox({ event, busy, siteAdmin, admin }: ProposalBoxProps) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<"submit" | "take" | null>(null);
  const proposal = event.proposal;
  if (proposal === null || proposal.state === null) return null;
  const { mine, organizer } = proposal;
  const runs = organizer || siteAdmin;
  const name = proposal.byName || t("tournaments.proposal.theProposer");
  const when = (seconds: number | null) => formatMoment(seconds, "");
  const left = daysLeftText(proposal.until, nowSeconds(), t);
  const days = proposal.days > 0 ? proposal.days : 28;
  const close = () => setDialog(null);
  const send = (change: TourneyAdmin) => {
    close();
    admin(change);
  };

  const boxes = [];

  if (proposal.state === "draft" && (mine || organizer)) {
    const last = lastStepKey(proposal);
    boxes.push(
      <section key="draft" className="surface tournament-proposal-box" role="status">
        <strong className="tournament-proposal-head">{t("tournaments.proposal.head")}</strong>
        <p>{t("tournaments.proposal.draftIntro")}</p>
        {last !== null && proposal.last !== null && (
          <p className={`tournament-proposal-last is-${proposal.last.act}`}>
            {t(last, {
              name: proposal.last.byName,
              when: when(proposal.last.at),
              reason: proposal.last.reason,
            })}
          </p>
        )}
        <div className="tournament-detail-actions">
          {proposal.canSubmit && (
            <Button variant="primary" disabled={busy} onClick={() => setDialog("submit")}>
              {t("tournaments.proposal.submit")}
            </Button>
          )}
          {proposal.canDrop && (
            <Button
              disabled={busy}
              onClick={() => askConfirm(t("tournaments.proposal.dropConfirm"), () => admin({ type: "proposalDrop" }))}
            >
              {t("tournaments.proposal.drop")}
            </Button>
          )}
        </div>
      </section>,
    );
  }

  if (proposal.state === "proposed" && (mine || organizer)) {
    boxes.push(
      <section key="waiting" className="surface tournament-proposal-box is-waiting" role="status">
        <strong className="tournament-proposal-head">{t("tournaments.proposal.headWaiting")}</strong>
        <p>
          {t("tournaments.proposal.waitingText", {
            proposed: when(proposal.proposedAt),
            until: when(proposal.until),
            left,
          })}
        </p>
        <Answers proposal={proposal} you={mine} />
        {proposal.note !== "" && <p>{t("tournaments.proposal.yourNote", { note: proposal.note })}</p>}
        {proposal.canWithdraw && (
          <div className="tournament-detail-actions">
            <Button
              disabled={busy}
              onClick={() =>
                askConfirm(t("tournaments.proposal.withdrawConfirm"), () => admin({ type: "proposalWithdraw" }))
              }
            >
              {t("tournaments.proposal.withdraw")}
            </Button>
          </div>
        )}
      </section>,
    );
  }

  if (proposal.state === "taken" && (mine || runs)) {
    const taken = {
      name: proposal.takenByName,
      when: when(proposal.takenAt),
      note: proposal.takeNote,
      by: name,
    };
    const unlock = (area: "maps" | "format") => {
      const change = (reason: string): TourneyAdmin => ({ type: "proposalUnlock", payload: { area, reason } });
      if (mine) {
        askConfirm(
          t(area === "maps" ? "tournaments.proposal.unlockConfirmMaps" : "tournaments.proposal.unlockConfirmFormat"),
          () => admin(change("")),
        );
      } else {
        askText(
          t(area === "maps" ? "tournaments.proposal.unlockReasonMaps" : "tournaments.proposal.unlockReasonFormat", { name }),
          "",
          (reason) => admin(change(reason)),
          { maxLength: 300 },
        );
      }
    };
    boxes.push(
      <section key="taken" className="surface tournament-proposal-box is-taken" role="status">
        <strong className="tournament-proposal-head">{t("tournaments.proposal.headTaken")}</strong>
        <p>
          {mine
            ? t(taken.note ? "tournaments.proposal.takenMineNote" : "tournaments.proposal.takenMine", taken)
            : t(taken.note ? "tournaments.proposal.takenOtherNote" : "tournaments.proposal.takenOther", taken)}
        </p>
        {/* Its own line: the director's note before it ends in whatever
            punctuation they gave it, often none. */}
        <p className="muted">
          {mine && `${t("tournaments.proposal.theyRunIt")} `}
          {t("tournaments.proposal.secondDirector")}
        </p>
        {proposal.lockMaps && (
          <p>
            {mine ? t("tournaments.proposal.lockMineMaps") : t("tournaments.proposal.lockOtherMaps", { name })}{" "}
            {proposal.canUnlock && (
              <Button disabled={busy} onClick={() => unlock("maps")}>
                {t(mine ? "tournaments.proposal.unlockMineMaps" : "tournaments.proposal.liftAdmin")}
              </Button>
            )}
          </p>
        )}
        {proposal.lockFormat && (
          <p>
            {mine ? t("tournaments.proposal.lockMineFormat") : t("tournaments.proposal.lockOtherFormat", { name })}{" "}
            {proposal.canUnlock && (
              <Button disabled={busy} onClick={() => unlock("format")}>
                {t(mine ? "tournaments.proposal.unlockMineFormat" : "tournaments.proposal.liftAdmin")}
              </Button>
            )}
          </p>
        )}
        {proposal.canRelease && (
          <div className="tournament-detail-actions">
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                askText(
                  t("tournaments.proposal.releaseReason", { name }),
                  "",
                  (reason) =>
                    askConfirm(
                      t("tournaments.proposal.releaseConfirm", { name }),
                      () => admin({ type: "proposalRelease", payload: { reason } }),
                      { danger: true },
                    ),
                  { maxLength: 300 },
                )
              }
            >
              {t("tournaments.proposal.release", { name })}
            </Button>
          </div>
        )}
      </section>,
    );
  }

  if (proposal.state === "proposed" && proposal.canDecide) {
    boxes.push(
      <section key="decide" className="surface tournament-proposal-box is-director" role="status">
        <strong className="tournament-proposal-head">{t("tournaments.proposal.headDirector")}</strong>
        <p>
          {t("tournaments.proposal.directorText", {
            name,
            proposed: when(proposal.proposedAt),
            until: when(proposal.until),
            left,
          })}
        </p>
        {proposal.note !== "" && <p>{t("tournaments.proposal.theirNote", { note: proposal.note })}</p>}
        <Answers proposal={proposal} you={false} />
        <p className="muted">{t("tournaments.proposal.directorHint")}</p>
        <div className="tournament-detail-actions">
          <Button variant="primary" disabled={busy} onClick={() => setDialog("take")}>
            {t("tournaments.proposal.take")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              askText(
                t("tournaments.proposal.declineReason", { name }),
                "",
                (reason) => admin({ type: "proposalDecline", payload: { reason } }),
                { maxLength: 300 },
              )
            }
          >
            {t("tournaments.proposal.decline")}
          </Button>
        </div>
      </section>,
    );
  }

  if (boxes.length === 0) return null;
  return (
    <>
      {boxes}
      {dialog === "submit" && <SubmitDialog proposal={proposal} days={days} onSubmit={send} onCancel={close} />}
      {dialog === "take" && (
        <TakeDialog
          name={event.name}
          by={name}
          keep={proposal.keep}
          lockMaps={proposal.lockMaps}
          lockFormat={proposal.lockFormat}
          onTake={send}
          onCancel={close}
        />
      )}
    </>
  );
}

/** "Proposed by X and run by the TD team", on a published event's Overview. */
export function ProposalCredit({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  const proposal = event.proposal;
  if (proposal === null || proposal.credit === "" || !event.published) return null;
  if (proposal.state !== null && proposal.state !== "taken") return null;
  return <p className="muted tournament-proposal-credit">{t("tournaments.proposal.credit", { name: proposal.credit })}</p>;
}
