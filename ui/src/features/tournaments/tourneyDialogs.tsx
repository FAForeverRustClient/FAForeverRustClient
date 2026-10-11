// The tournament tab's questions, asked in the client's own dialogs.
//
// The tab used to ask with `window.confirm` and `window.prompt`, which in the
// client are the webview's bare boxes: unstyled, headed "localhost:5173 says"
// and nothing like the rest of the app. These are drop-in replacements a
// click handler can call the same way, `askConfirm(question, run)` and
// `askText(question, value, save)`, answered by one `TourneyDialogHost` the tab
// mounts once.

import { useState, useSyncExternalStore } from "react";
import { Button } from "../../design-system/Button";
import { ConfirmDialog } from "../../design-system/ConfirmDialog";
import { Modal } from "../../design-system/Modal";
import { useTranslation } from "../../i18n/useTranslation";

interface ConfirmAsk {
  kind: "confirm";
  question: string;
  danger: boolean;
  run: () => void;
}

interface TextAsk {
  kind: "text";
  /** A short heading, when the question itself is a sentence. */
  title: string | null;
  question: string;
  value: string;
  numeric: boolean;
  maxLength: number;
  save: (value: string) => void;
}

type Ask = ConfirmAsk | TextAsk;

let current: Ask | null = null;
const listeners = new Set<() => void>();

function show(ask: Ask | null): void {
  current = ask;
  for (const listener of listeners) listener();
}

/**
 * Ask a yes-or-no question and run `run` on yes. `danger` paints the answer
 * red, for what cannot be taken back.
 */
export function askConfirm(question: string, run: () => void, options: { danger?: boolean } = {}): void {
  show({ kind: "confirm", question, danger: options.danger ?? false, run });
}

/**
 * Ask for a line of text, prefilled with `value`, and hand a non-empty
 * answer to `save`. `numeric` asks for a number; `title` heads a question
 * that is a whole sentence.
 */
export function askText(
  question: string,
  value: string,
  save: (value: string) => void,
  options: { title?: string; numeric?: boolean; maxLength?: number } = {},
): void {
  show({
    kind: "text",
    title: options.title ?? null,
    question,
    value,
    numeric: options.numeric ?? false,
    maxLength: options.maxLength ?? 60,
    save,
  });
}

/** Test seam: an unanswered question would otherwise outlive its test. */
export function resetTourneyDialogs(): void {
  show(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Draws whichever question is open. Mounted once, by the tab. */
export function TourneyDialogHost() {
  const ask = useSyncExternalStore(subscribe, () => current);
  if (ask === null) return null;
  if (ask.kind === "confirm") {
    return <ConfirmQuestion ask={ask} />;
  }
  // Keyed by the question, so a second one starts from its own value.
  return <TextQuestion key={`${ask.question}\n${ask.value}`} ask={ask} />;
}

function ConfirmQuestion({ ask }: { ask: ConfirmAsk }) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      title={t("tournaments.dialog.confirmTitle")}
      body={ask.question}
      confirmLabel={t("tournaments.dialog.confirm")}
      danger={ask.danger}
      onConfirm={() => {
        show(null);
        ask.run();
      }}
      onCancel={() => show(null)}
    />
  );
}

function TextQuestion({ ask }: { ask: TextAsk }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(ask.value);
  const ready = value.trim() !== "";
  return (
    <Modal className="confirm-modal tournament-ask" onClose={() => show(null)} ariaLabel={ask.question}>
      <form
        className="confirm-dialog-content"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (!ready) return;
          show(null);
          ask.save(value.trim());
        }}
      >
        <h2>{ask.title ?? ask.question}</h2>
        {ask.title !== null && <p>{ask.question}</p>}
        <label className="tournament-field">
          <input
            value={value}
            inputMode={ask.numeric ? "numeric" : undefined}
            maxLength={ask.maxLength}
            aria-label={ask.question}
            autoFocus
            onFocus={(focused) => focused.target.select()}
            onChange={(changed) => setValue(changed.target.value)}
          />
        </label>
        <div className="confirm-dialog-actions">
          <Button onClick={() => show(null)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {t("tournaments.ffa.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
