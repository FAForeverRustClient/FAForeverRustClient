// What changed in the build that is now running, once, on its first start
// after an update.
//
// Whether there is anything to say is the backend's to decide
// (`whats_new_on_startup` in the client-update slice): `clientUpdate.whatsNew`
// names the running version until the popup is dismissed, and only a
// dismissal records the version as seen. This file decides when it is shown,
// and keeps it back rather than losing it:
//
// - not before the notes have been read, and not in place of notes that could
//   not be: a failed read leaves the popup for the next start;
// - not over the update gate, which is the one dialog that must be answered;
// - not while a game is being joined, started or played, or a replay runs:
//   the game and its own dialogs are what matter then. It waits, and comes up
//   once the game is over.
//
// What it lists is `whatsNewChanges`'s choice: the release's highlights when
// it has them, its first few lines when it does not. A release with no
// changes to list (one published before the changelog snippets, or a body of
// prose only) is dismissed without being shown: a popup with nothing in it is
// worse than none.

import { useEffect, useMemo, useRef } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { ClientReleaseNotes, JoinState, MatchmakingState, ReplayStatus } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { ChangelogSpans } from "../../shared/components/ChangelogBlocks";
import { canOpenClientRelease, openClientRelease } from "../../shared/clientReleaseNotes";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { updateRequiredRelease } from "../../store/reducers/clientUpdate";
import { useAppStore } from "../../store/store";
import { whatsNewChanges, type WhatsNewChanges } from "./whatsNewChanges";
import "./updates.css";

const dismiss = () => ipc.send({ kind: "ClientUpdate", command: { type: "dismissWhatsNew" } });

const NOTHING: WhatsNewChanges = { shown: [], highlights: false, rest: 0 };

/**
 * A game on its way or running: a join from its first step to the game
 * window, a matchmaker search (its match-found prompt has a timer), or a
 * replay being watched. A join that failed is over, and does not count.
 */
function gameActive(
  join: JoinState["type"],
  matchmaking: MatchmakingState["type"],
  replay: ReplayStatus["type"],
): boolean {
  const joining = join !== "idle" && join !== "failed" && join !== "launchFailed";
  const searching = matchmaking !== "idle" && matchmaking !== "cancelled";
  const watching = replay === "connecting" || replay === "playing";
  return joining || searching || watching;
}

export function WhatsNewDialog() {
  const version = useAppStore((s) => s.state.clientUpdate.whatsNew);
  const notesStatus = useAppStore((s) => s.state.clientUpdate.notesStatus.type);
  const notes = useAppStore((s) => s.state.clientUpdate.notes);
  // The gate's own test, less the carve-outs it makes for a game, which are
  // this popup's anyway.
  const gateUp = useAppStore((s) => updateRequiredRelease(s.state.clientUpdate) !== null);
  const join = useAppStore((s) => s.state.lobby.join.type);
  const matchmaking = useAppStore((s) => s.state.lobby.matchmaking.type);
  const replay = useAppStore((s) => s.state.replays.status.type);
  const authMode = useAppStore((s) => s.state.auth.mode);

  const release = version === null ? undefined : notes.find((note) => note.version === version);
  const changes = useMemo(() => (release ? whatsNewChanges(release.blocks) : NOTHING), [release]);
  const nothingToSay = version !== null && notesStatus === "ready" && changes.shown.length === 0;

  useEffect(() => {
    if (nothingToSay) dismiss();
  }, [nothingToSay]);

  if (!release || notesStatus !== "ready" || changes.shown.length === 0) return null;
  if (gateUp || gameActive(join, matchmaking, replay)) return null;

  return (
    <WhatsNewPopup
      release={release}
      changes={changes}
      inClient={canOpenClientRelease(notes, authMode, release.version)}
    />
  );
}

interface PopupProps {
  release: ClientReleaseNotes;
  /** What to list, and how many changes that leaves out. */
  changes: WhatsNewChanges;
  /** Whether "See all changes" can open the client's own changelog. */
  inClient: boolean;
}

/** The popup itself, given what it shows. */
export function WhatsNewPopup({ release, changes, inClient }: PopupProps) {
  const { t } = useTranslation();
  const actionsRef = useRef<HTMLDivElement>(null);
  const { shown, highlights, rest } = changes;
  const title = t("updates.whatsNew.title", { version: release.version });
  // A session that cannot open the Changelog tab reads the release page.
  const pageUrl = inClient ? null : optionalHttpsUrl(release.notesUrl);

  // The caret on "See all changes". Left to the dialog, it went to the first
  // control inside, which is the first issue link in the list, and Enter
  // opened a page on GitHub. This runs after the dialog's own placement.
  useEffect(() => {
    actionsRef.current?.querySelector<HTMLElement>(".btn-primary")?.focus();
  }, []);

  const seeAll = () => {
    dismiss();
    if (inClient) openClientRelease(release.version);
    else if (pageUrl) void openHttpsUrl(pageUrl);
  };

  return (
    <Modal className="whats-new" onClose={dismiss} ariaLabel={title}>
      <h2 className="whats-new-title">{title}</h2>
      <ul className="whats-new-changes">
        {shown.map((change, index) => (
          <li key={index}>
            <ChangelogSpans spans={change.spans} />
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="whats-new-more">
          {t(highlights ? "updates.whatsNew.fullNotes" : "updates.whatsNew.more", { count: rest })}
        </p>
      )}
      <div className="whats-new-actions" ref={actionsRef}>
        <Button onClick={dismiss}>{t("common.close")}</Button>
        {(inClient || pageUrl) && (
          <Button variant="primary" onClick={seeAll}>
            {t("updates.whatsNew.seeAll")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
