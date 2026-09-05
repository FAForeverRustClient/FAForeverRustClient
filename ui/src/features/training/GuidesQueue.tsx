// Pending submissions, and the verdict on them.
//
// Its own tab, and a closed one: a player who cannot act on the queue has no
// use for a list of other people's unreviewed guides, so the tab explains what
// it is and how to be let in rather than showing a list nobody asked for. The
// underlying issues are public either way; this is about whose screen they
// belong on.
//
// The gate is GitHub's, not this client's. Being signed in draws the controls
// and `canCommit` decides the wording, but the authorisation is the answer
// GitHub gives to the write itself: a commit from a non-collaborator is
// refused, and that sentence is shown verbatim, because "Resource not
// accessible by personal access token" tells a maintainer which permission is
// missing and "not allowed" tells them nothing.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { GuideSubmission, GuidesCommand, GuidesState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { Markdown } from "./markdown";
import { RejectDialog } from "./RejectDialog";

const dispatch = (command: GuidesCommand) => ipc.send({ kind: "Guides", command });

interface Props {
  state: GuidesState;
  /** Where to ask for access, when the viewer has none. */
  discordUrl: string;
}

export function GuidesQueue({ state, discordUrl }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<GuideSubmission | null>(null);

  const busy = busyNumber(state);
  const failure = state.write.type === "failed" ? state.write.payload : null;
  const me = state.auth.type === "signedIn" ? state.auth.payload.identity : null;

  // The gate is being signed in, not being a collaborator.
  //
  // It was `canCommit` at first, and that was too tight in the wrong way:
  // `canCommit` comes from a second request that can fail on its own (a rate
  // limit, a token that reads users but not repositories), and when it did the
  // queue vanished for somebody who was signed in and could in fact commit.
  // Whether a write is allowed is GitHub's answer to the write, so a wrong
  // guess here should cost a warning line, never the whole tab.
  if (me === null) {
    return <NoAccess state={state} discordUrl={discordUrl} />;
  }

  return (
    <section className="surface-panel training-queue">
      <header className="training-section-head">
        <div>
          <h3>{t("training.queue.title")}</h3>
          <p className="muted">
            {state.repo
              ? t("training.queue.lead", { repo: state.repo })
              : t("training.queue.leadUnknown")}
          </p>
        </div>
        <div className="training-queue-account">
          <Button
            onClick={() => dispatch({ type: "loadQueue" })}
            disabled={state.status.type === "loading"}
          >
            <Icon name="refresh" size={15} /> {t("training.queue.refresh")}
          </Button>
          <Account state={state} />
        </div>
      </header>

      {!me.canCommit && (
        // Not a refusal, a warning: GitHub has not told us this account may
        // commit here, and it is the one that decides. The controls stay, and
        // if it turns out to be right the refusal arrives with its own reason.
        <p className="muted training-form-problem">
          {t("training.queue.notMaintainer", { login: me.login, repo: state.repo })}
        </p>
      )}

      {state.status.type === "failed" && (
        <p className="muted training-form-problem">
          {t("training.queue.loadFailed", { reason: state.status.payload.reason })}
        </p>
      )}

      {failure && (
        // GitHub's own words. This is the one place where the sentence a
        // maintainer needs is not one this client could have written.
        <p className="muted training-form-problem">
          {t("training.queue.writeFailed", {
            number: failure.number,
            reason: failure.reason,
          })}
        </p>
      )}

      {state.submissions.length === 0 ? (
        <p className="muted training-queue-empty">
          {state.status.type === "loading"
            ? t("training.queue.loading")
            : t("training.queue.empty")}
        </p>
      ) : (
        <ul className="training-queue-list">
          {state.submissions.map((submission) => {
            const expanded = open === submission.number;
            const working = busy === submission.number;
            return (
              <li key={submission.number} className="training-queue-row">
                <div className="training-queue-head">
                  <button
                    type="button"
                    className="training-queue-title"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : submission.number)}
                  >
                    <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
                    <span>{submission.title}</span>
                  </button>
                  <span className="muted training-queue-by">
                    {t("training.queue.by", {
                      author: submission.author || t("training.queue.someone"),
                    })}
                  </span>
                  {submission.entry === null && (
                    // Worth listing and worth answering; there is simply
                    // nothing to copy into the catalogue in one step.
                    <span className="training-chip">{t("training.queue.needsHand")}</span>
                  )}
                </div>

                {expanded && (
                  <div className="training-queue-detail">
                    {submission.summary && (
                      <Markdown source={submission.summary} className="training-queue-summary" />
                    )}
                    {submission.entry && <EntryFacts entry={submission.entry} />}
                    {submission.guide !== null && (
                      <details className="training-queue-guide">
                        <summary>{t("training.queue.readGuide")}</summary>
                        <Markdown source={submission.guide} />
                      </details>
                    )}
                  </div>
                )}

                <div className="training-queue-actions">
                  {submission.url && (
                    <Button onClick={() => void openHttpsUrl(submission.url)}>
                      <Icon name="external" size={14} /> {t("training.queue.onGithub")}
                    </Button>
                  )}
                  <>
                    <Button
                      variant="primary"
                      disabled={working || submission.entry === null || busy !== null}
                      title={
                        submission.entry === null ? t("training.queue.needsHandHint") : undefined
                      }
                      onClick={() =>
                        dispatch({ type: "accept", payload: { number: submission.number } })
                      }
                    >
                      <Icon name="check" size={14} />{" "}
                      {t(working ? "training.queue.working" : "training.queue.accept")}
                    </Button>
                    <Button
                      disabled={working || busy !== null}
                      onClick={() => setRejecting(submission)}
                    >
                      <Icon name="close" size={14} /> {t("training.queue.reject")}
                    </Button>
                  </>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rejecting && (
        <RejectDialog
          submission={rejecting}
          onConfirm={(reason, note) => {
            dispatch({
              type: "reject",
              payload: { number: rejecting.number, reason, note },
            });
            setRejecting(null);
          }}
          onClose={() => setRejecting(null)}
        />
      )}
    </section>
  );
}

/** Who is acting, and the way out. Only drawn past the gate. */
function Account({ state }: { state: GuidesState }) {
  const { t } = useTranslation();
  if (state.auth.type !== "signedIn") return null;
  const me = state.auth.payload.identity;

  return (
    <div className="training-queue-me">
      {me.avatarUrl && <img src={me.avatarUrl} alt="" aria-hidden loading="lazy" />}
      <div>
        <strong>{me.login}</strong>
        <small className="muted">
          {t(me.canCommit ? "training.queue.maintainer" : "training.queue.signedInOnly")}
        </small>
      </div>
      <Button onClick={() => dispatch({ type: "signOut" })}>
        {t("training.queue.signOut")}
      </Button>
    </div>
  );
}

/**
 * The tab for everybody who is not signed in.
 *
 * Several reasons to be here, and they want different sentences: telling
 * somebody on a build with no OAuth app that they lack permission, or telling
 * somebody mid-login to start one, would send them looking in the wrong place.
 */
function NoAccess({ state, discordUrl }: { state: GuidesState; discordUrl: string }) {
  const { t } = useTranslation();

  const [reason, action] = (() => {
    switch (state.auth.type) {
      case "unconfigured":
        // A deployment fact, not something the reader did wrong.
        return [t("training.queue.unconfigured"), null] as const;

      case "waiting": {
        const { userCode, verificationUri } = state.auth.payload.login;
        return [
          t("training.queue.deviceLead"),
          <div className="training-device-login" key="waiting">
            {/* The code is the whole point of the flow: it is typed by hand on
                GitHub, so it is large, spaced and selectable, and it stays on
                screen for as long as it is valid. */}
            <div className="training-device-code">
              <code>{userCode}</code>
              <Button
                title={t("training.queue.copyCode")}
                onClick={() => void navigator.clipboard?.writeText(userCode)}
              >
                <Icon name="copy" size={14} />
              </Button>
            </div>
            <div className="training-queue-actions">
              <Button variant="primary" onClick={() => void openHttpsUrl(verificationUri)}>
                <Icon name="external" size={14} /> {t("training.queue.openGithub")}
              </Button>
              <Button onClick={() => dispatch({ type: "cancelSignIn" })}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>,
        ] as const;
      }

      case "failed":
        return [
          state.auth.payload.reason,
          <Button key="retry" variant="primary" onClick={() => dispatch({ type: "signIn" })}>
            <Icon name="github" size={15} /> {t("training.queue.tryAgain")}
          </Button>,
        ] as const;

      default:
        return [
          t("training.queue.signedOutLead"),
          <Button key="in" variant="primary" onClick={() => dispatch({ type: "signIn" })}>
            <Icon name="github" size={15} /> {t("training.queue.signIn")}
          </Button>,
        ] as const;
    }
  })();

  return (
    <section className="surface-panel training-no-access">
      <Icon name="lock" size={26} />
      <h3>{t("training.queue.noAccess")}</h3>
      <p className="muted">{reason}</p>
      <div className="training-queue-actions">
        {action}
        {discordUrl && (
          <Button onClick={() => void openHttpsUrl(discordUrl)}>
            <Icon name="chat" size={15} /> {t("training.queue.requestAccess")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** What the catalogue would gain, in the terms the library filters on. */
function EntryFacts({ entry }: { entry: NonNullable<GuideSubmission["entry"]> }) {
  const { t } = useTranslation();
  const facts: Array<[string, string]> = [];
  facts.push([t("training.queue.entryId"), entry.id]);
  if (entry.level) facts.push([t("training.detail.level"), entry.level]);
  if (entry.gameModes.length > 0) facts.push([t("training.detail.modes"), entry.gameModes.join(", ")]);
  if (entry.maps.length > 0) facts.push([t("training.detail.maps"), entry.maps.join(", ")]);
  if (entry.topics.length > 0) facts.push([t("training.contribute.topics"), entry.topics.join(", ")]);
  if (entry.ratingMin !== null || entry.ratingMax !== null) {
    facts.push([
      t("training.detail.rating"),
      `${entry.ratingMin ?? ""}${entry.ratingMin !== null && entry.ratingMax !== null ? " to " : ""}${entry.ratingMax ?? ""}`,
    ]);
  }

  return (
    <dl className="training-detail-meta">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Twin of `GuidesWrite::busy_number`: only the row being written is busy. */
function busyNumber(state: GuidesState): number | null {
  if (state.write.type === "accepting" || state.write.type === "rejecting") {
    return state.write.payload.number;
  }
  return null;
}
