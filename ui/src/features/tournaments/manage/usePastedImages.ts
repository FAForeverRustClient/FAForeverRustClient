import { useCallback, useEffect, useRef, useState } from "react";
import type { DescImageAnswer } from "../../../ipc/bindings";
import { PastedImageUploads, type ImageInsertion, type PasteField } from "./pastedImages";

/**
 * How long an upload may stay unanswered before it is counted as failed.
 *
 * Every request is answered now, success or failure, so this is only the
 * backstop for an answer that never arrives at all (a dropped connection).
 * An answer that does arrive after it names its request, which is then
 * already marked failed, so it cannot land on the next picture.
 */
export const PASTED_IMAGE_TIMEOUT_MS = 60_000;

/**
 * Upload pictures pasted into an existing event's text, one request per
 * paste, and hand each stored path back with the place it was pasted.
 */
export function usePastedImages(
  answer: DescImageAnswer | null,
  onUploadImage: ((dataUrl: string, requestId: number) => void) | undefined,
  onInsert: (insertion: ImageInsertion) => void,
) {
  const [uploads] = useState(() => new PastedImageUploads());
  // Re-render on every change, since the queue itself is mutable.
  const [, setVersion] = useState(0);
  // A holder rather than a ref, so the unmount cleanup can read the timer
  // that is current then, not the one that was current when it mounted.
  const [inFlight] = useState(() => ({ timer: null as ReturnType<typeof setTimeout> | null }));
  // The latest callbacks, for the timer and the answer effect to call.
  const latest = useRef({ onUploadImage, onInsert });
  useEffect(() => {
    latest.current = { onUploadImage, onInsert };
  });

  const stopTimer = useCallback(() => {
    if (inFlight.timer !== null) clearTimeout(inFlight.timer);
    inFlight.timer = null;
  }, [inFlight]);

  const pump = useCallback(() => {
    const upload = latest.current.onUploadImage;
    const next = upload === undefined ? null : uploads.startNext();
    if (upload !== undefined && next !== null) {
      upload(next.dataUrl, next.id);
      stopTimer();
      inFlight.timer = setTimeout(() => {
        inFlight.timer = null;
        uploads.fail(next.id);
        pump();
      }, PASTED_IMAGE_TIMEOUT_MS);
    }
    setVersion((version) => version + 1);
  }, [uploads, inFlight, stopTimer]);

  // Each answer is a new object naming its request, so identity is enough to
  // tell a new answer from the one already handled.
  const lastAnswer = useRef(answer);
  useEffect(() => {
    if (answer === null || answer === lastAnswer.current) return;
    lastAnswer.current = answer;
    const sending = uploads.sending;
    // Not the one in flight: a request this form already gave up on, or one
    // from a form that has since closed.
    if (sending === null || sending.id !== answer.requestId) return;
    stopTimer();
    const insertion = uploads.answer(answer.requestId, answer.url);
    if (insertion !== null) latest.current.onInsert(insertion);
    pump();
  }, [answer, uploads, stopTimer, pump]);

  useEffect(() => stopTimer, [stopTimer]);

  return {
    /** Queue a picture pasted into `field` at `at`; false when uploads are off. */
    paste: (field: PasteField, at: number, dataUrl: string): boolean => {
      if (latest.current.onUploadImage === undefined) return false;
      uploads.add(field, at, dataUrl);
      pump();
      return true;
    },
    active: uploads.active,
    failed: uploads.failed,
    dismissFailures: () => {
      uploads.dismissFailures();
      setVersion((version) => version + 1);
    },
  };
}
