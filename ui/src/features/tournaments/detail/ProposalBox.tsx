// A tournament proposal's box on its event (#569), as the website's
// `proposalBannerHTML` decides it: for its proposer and organisers while it is
// built, waits and once it is taken over, and for a tournament director who
// may take it over or decline it. Sits where the publish banner does, which
// stays away while the proposal holds the event back.
//
// Drawn as the client's own cards and dialogs are now (the launch overlays):
// a raised head saying what this is and where it stands, the body, and a foot
// with the actions, the main one last. Choices are option cards, not bare
// checkboxes under an all-caps label.

import { useState, type ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import { Icon, type IconName } from "../../../design-system/Icon";
import { Modal } from "../../../design-system/Modal";
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

type Tone = "draft" | "waiting" | "taken" | "director";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** One proposal card: a raised head with where it stands, the body, the actions. */
function ProposalCard({ tone, state, children, actions }: {
  tone: Tone;
  state: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="proposal-card" data-tone={tone} role="status">
      <header className="proposal-card-head">
        <span className="proposal-icon" aria-hidden="true">
          <Icon name="flag" size={18} />
        </span>
        <div className="proposal-heading">
          <span className="proposal-eyebrow">{t("tournaments.proposal.head")}</span>
          <strong>{state}</strong>
        </div>
      </header>
      <div className="proposal-card-body">{children}</div>
      {actions && <footer className="proposal-card-foot">{actions}</footer>}
    </section>
  );
}

/** A note somebody wrote, or what came of the proposal last, set apart from the prose. */
function Note({ children, tone, icon = "note" }: { children: ReactNode; tone?: "warn" | "error"; icon?: IconName }) {
  return (
    <p className="proposal-note" data-tone={tone}>
      <Icon name={icon} size={15} />
      <span>{children}</span>
    </p>
  );
}

/** What the proposer asked: the two locks and who runs it, one line each. */
function Answers({ proposal, you }: { proposal: TourneyProposal; you: boolean }) {
  const { t } = useTranslation();
  const name = proposal.byName || t("tournaments.proposal.theProposer");
  return (
    <ul className="proposal-answers">
      <li data-kept={proposal.lockMaps || undefined}>
        <Icon name={proposal.lockMaps ? "lock" : "check"} size={14} />
        {t(proposal.lockMaps ? "tournaments.proposal.answerMapsKeep" : "tournaments.proposal.answerMapsFree")}
      </li>
      <li data-kept={proposal.lockFormat || undefined}>
        <Icon name={proposal.lockFormat ? "lock" : "check"} size={14} />
        {t(proposal.lockFormat ? "tournaments.proposal.answerFormatKeep" : "tournaments.proposal.answerFormatFree")}
      </li>
      <li>
        <Icon name="user" size={14} />
        {you
          ? t(proposal.keep ? "tournaments.proposal.youKeep" : "tournaments.proposal.youHandOver")
          : t(proposal.keep ? "tournaments.proposal.theyKeep" : "tournaments.proposal.theyHandOver", { name })}
      </li>
    </ul>
  );
}

/** The dialogs' frame: the launch overlays' three bands. */
function ProposalDialog({ eyebrow, name, onClose, children, actions }: {
  eyebrow: string;
  name: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Modal className="proposal-dialog" onClose={onClose} ariaLabel={eyebrow}>
      <header className="proposal-dialog-head">
        <span className="proposal-icon" aria-hidden="true">
          <Icon name="flag" size={20} />
        </span>
        <div className="proposal-heading">
          <h2 className="proposal-eyebrow">{eyebrow}</h2>
          <strong title={name}>{name}</strong>
        </div>
      </header>
      <div className="proposal-dialog-body">{children}</div>
      <footer className="proposal-dialog-foot">{actions}</footer>
    </Modal>
  );
}

/** One section of a dialog: a heading, its choices, and what they mean. */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="proposal-section">
      <h3>{title}</h3>
      <div className="proposal-options">{children}</div>
      {hint && <p className="proposal-hint">{hint}</p>}
    </section>
  );
}

/** A choice as a card: the box or the dot, a title, and a line under it. */
function Option({ type, name, checked, onChange, title, hint }: {
  type: "checkbox" | "radio";
  name?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  hint?: string;
}) {
  return (
    <label className={checked ? "proposal-option is-chosen" : "proposal-option"}>
      <input type={type} name={name} checked={checked} onChange={(changed) => onChange(changed.target.checked)} />
      <span className="proposal-option-copy">
        <strong>{title}</strong>
        {hint && <span>{hint}</span>}
      </span>
    </label>
  );
}

/** Propose it to the TD team: the two locks, who runs it, and a note. */
function SubmitDialog({ name, proposal, days, onSubmit, onCancel }: {
  name: string;
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
    <ProposalDialog
      eyebrow={t("tournaments.proposal.submitTitle")}
      name={name}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() =>
              onSubmit({
                type: "proposalSubmit",
                payload: { lockMaps: !mapsFree, lockFormat: !formatFree, keep, note },
              })
            }
          >
            {t("tournaments.proposal.propose")}
          </Button>
        </>
      }
    >
      <p className="proposal-lead">{t("tournaments.proposal.submitIntro", { days })}</p>
      <Section title={t("tournaments.proposal.mayChange")} hint={t("tournaments.proposal.mayChangeHint")}>
        <Option
          type="checkbox"
          checked={mapsFree}
          onChange={setMapsFree}
          title={t("tournaments.proposal.mayChangeMaps")}
        />
        <Option
          type="checkbox"
          checked={formatFree}
          onChange={setFormatFree}
          title={t("tournaments.proposal.mayChangeFormatShort")}
          hint={t("tournaments.proposal.mayChangeFormatHint")}
        />
      </Section>
      <Section title={t("tournaments.proposal.after")}>
        <Option
          type="radio"
          name="proposal-keep"
          checked={!keep}
          onChange={() => setKeep(false)}
          title={t("tournaments.proposal.handOverShort")}
          hint={t("tournaments.proposal.handOverHint")}
        />
        <Option
          type="radio"
          name="proposal-keep"
          checked={keep}
          onChange={() => setKeep(true)}
          title={t("tournaments.proposal.keepMe")}
        />
      </Section>
      <label className="proposal-field">
        <span>{t("tournaments.proposal.noteLabel")}</span>
        <textarea
          rows={3}
          maxLength={1000}
          value={note}
          placeholder={t("tournaments.proposal.notePlaceholder")}
          onChange={(changed) => setNote(changed.target.value)}
        />
      </label>
      <Note icon="lock">{t("tournaments.proposal.frozenHint")}</Note>
    </ProposalDialog>
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
  const locked = lockMaps || lockFormat;
  return (
    <ProposalDialog
      eyebrow={t("tournaments.proposal.takeConfirm")}
      name={name}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => onTake({ type: "proposalTake", payload: { category, note } })}>
            {t("tournaments.proposal.takeConfirm")}
          </Button>
        </>
      }
    >
      <p className="proposal-lead">
        {t(keep ? "tournaments.proposal.takeKeep" : "tournaments.proposal.takeHandOver", { by })}
      </p>
      <Note tone={locked ? "warn" : undefined} icon={locked ? "lock" : "check"}>
        {t(lockSentenceKey({ lockMaps, lockFormat }), { by })}
      </Note>
      <Section title={t("tournaments.proposal.runAs")}>
        <Option
          type="radio"
          name="proposal-category"
          checked={category === "official"}
          onChange={() => setCategory("official")}
          title={t("tournaments.proposal.runOfficialShort")}
          hint={t("tournaments.proposal.runOfficialHint")}
        />
        <Option
          type="radio"
          name="proposal-category"
          checked={category === "community"}
          onChange={() => setCategory("community")}
          title={t("tournaments.proposal.runCommunity")}
        />
      </Section>
      <label className="proposal-field">
        <span>{t("tournaments.proposal.takeNoteLabel", { by })}</span>
        <input
          maxLength={300}
          value={note}
          placeholder={t("tournaments.proposal.takeNotePlaceholder")}
          onChange={(changed) => setNote(changed.target.value)}
        />
      </label>
      <p className="proposal-hint">{t("tournaments.proposal.takePublishHint")}</p>
    </ProposalDialog>
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

  const cards = [];

  if (proposal.state === "draft" && (mine || organizer)) {
    const last = lastStepKey(proposal);
    cards.push(
      <ProposalCard
        key="draft"
        tone="draft"
        state={t("tournaments.proposal.stateDraft")}
        actions={(proposal.canSubmit || proposal.canDrop) && (
          <>
            {proposal.canDrop && (
              <Button
                disabled={busy}
                onClick={() => askConfirm(t("tournaments.proposal.dropConfirm"), () => admin({ type: "proposalDrop" }))}
              >
                {t("tournaments.proposal.drop")}
              </Button>
            )}
            {proposal.canSubmit && (
              <Button variant="primary" disabled={busy} onClick={() => setDialog("submit")}>
                {t("tournaments.proposal.submit")}
              </Button>
            )}
          </>
        )}
      >
        <p>{t("tournaments.proposal.draftIntro")}</p>
        {last !== null && proposal.last !== null && (
          <Note
            tone={proposal.last.act === "declined" ? "error" : proposal.last.act === "withdrawn" ? undefined : "warn"}
            icon={proposal.last.act === "withdrawn" ? "info" : "alert"}
          >
            {t(last, {
              name: proposal.last.byName,
              when: when(proposal.last.at),
              reason: proposal.last.reason,
            })}
          </Note>
        )}
      </ProposalCard>,
    );
  }

  if (proposal.state === "proposed" && (mine || organizer)) {
    cards.push(
      <ProposalCard
        key="waiting"
        tone="waiting"
        state={t("tournaments.proposal.headWaiting")}
        actions={proposal.canWithdraw && (
          <Button
            disabled={busy}
            onClick={() =>
              askConfirm(t("tournaments.proposal.withdrawConfirm"), () => admin({ type: "proposalWithdraw" }))
            }
          >
            {t("tournaments.proposal.withdraw")}
          </Button>
        )}
      >
        <p>
          {t("tournaments.proposal.waitingText", {
            proposed: when(proposal.proposedAt),
            until: when(proposal.until),
            left,
          })}
        </p>
        <Answers proposal={proposal} you={mine} />
        {proposal.note !== "" && <Note>{t("tournaments.proposal.yourNote", { note: proposal.note })}</Note>}
      </ProposalCard>,
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
    const lock = (area: "maps" | "format") => {
      const mineKey = area === "maps" ? "tournaments.proposal.lockMineMaps" : "tournaments.proposal.lockMineFormat";
      const otherKey = area === "maps" ? "tournaments.proposal.lockOtherMaps" : "tournaments.proposal.lockOtherFormat";
      const liftKey = mine
        ? area === "maps" ? "tournaments.proposal.unlockMineMaps" : "tournaments.proposal.unlockMineFormat"
        : "tournaments.proposal.liftAdmin";
      return (
        <div className="proposal-lock" key={area}>
          <Icon name="lock" size={14} />
          <span>{mine ? t(mineKey) : t(otherKey, { name })}</span>
          {proposal.canUnlock && (
            <Button disabled={busy} onClick={() => unlock(area)}>
              {t(liftKey)}
            </Button>
          )}
        </div>
      );
    };
    cards.push(
      <ProposalCard
        key="taken"
        tone="taken"
        state={t("tournaments.proposal.headTaken")}
        actions={proposal.canRelease && (
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
        )}
      >
        <p>
          {mine
            ? t(taken.note ? "tournaments.proposal.takenMineNote" : "tournaments.proposal.takenMine", taken)
            : t(taken.note ? "tournaments.proposal.takenOtherNote" : "tournaments.proposal.takenOther", taken)}
        </p>
        {/* Its own line: the director's note before it ends in whatever
            punctuation they gave it, often none. */}
        <p className="proposal-hint">
          {mine && `${t("tournaments.proposal.theyRunIt")} `}
          {t("tournaments.proposal.secondDirector")}
        </p>
        {proposal.lockMaps && lock("maps")}
        {proposal.lockFormat && lock("format")}
      </ProposalCard>,
    );
  }

  if (proposal.state === "proposed" && proposal.canDecide) {
    cards.push(
      <ProposalCard
        key="decide"
        tone="director"
        state={t("tournaments.proposal.headDirector")}
        actions={
          <>
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
            <Button variant="primary" disabled={busy} onClick={() => setDialog("take")}>
              {t("tournaments.proposal.take")}
            </Button>
          </>
        }
      >
        <p>
          {t("tournaments.proposal.directorText", {
            name,
            proposed: when(proposal.proposedAt),
            until: when(proposal.until),
            left,
          })}
        </p>
        <Answers proposal={proposal} you={false} />
        {proposal.note !== "" && <Note>{t("tournaments.proposal.theirNote", { note: proposal.note })}</Note>}
        <p className="proposal-hint">{t("tournaments.proposal.directorHint")}</p>
      </ProposalCard>,
    );
  }

  if (cards.length === 0) return null;
  return (
    <>
      {cards}
      {dialog === "submit" && (
        <SubmitDialog name={event.name} proposal={proposal} days={days} onSubmit={send} onCancel={close} />
      )}
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
  return (
    <p className="proposal-credit">
      <Icon name="flag" size={13} />
      {t("tournaments.proposal.credit", { name: proposal.credit })}
    </p>
  );
}
