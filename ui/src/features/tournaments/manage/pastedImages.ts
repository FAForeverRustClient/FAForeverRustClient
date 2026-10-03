// Pictures pasted into an existing event's text, from paste to insertion.
//
// Each paste becomes its own request carrying the field and caret position it
// was pasted at, so a picture pasted into the description and another pasted
// into the sponsors each land where they were pasted. This used to be one
// "where the next picture goes" slot: the second paste overwrote it before the
// first upload answered, so the first picture landed in the sponsors and the
// second was lost.
//
// Every request carries an id the backend hands back with its answer
// (`DescImageUploaded` or `DescImageUploadFailed`), so an answer is credited to
// the paste it belongs to and to no other. They still go out one at a time,
// because the state keeps only the latest answer and two arriving between
// renders would hide the first. Ids are unique for the whole session, not per
// form, so an answer meant for a form that has since closed matches nothing.

export type PasteField = "description" | "lobbyOptions" | "rewards" | "sponsors";

export interface PastedUpload {
  readonly id: number;
  readonly field: PasteField;
  /** The caret position it was pasted at, kept current as earlier pictures land. */
  readonly at: number;
  readonly dataUrl: string;
  readonly status: "queued" | "sending" | "failed";
}

/** Where a stored picture goes, and the text that goes there. */
export interface ImageInsertion {
  readonly field: PasteField;
  readonly at: number;
  readonly markdown: string;
}

/** The Markdown a stored picture is written into the text as. */
export function imageMarkdown(url: string): string {
  return `\n![image](${url})\n`;
}

/**
 * The text with a picture inserted at a position.
 *
 * Clamped, because the organiser may have shortened the text while the
 * upload was running; the end is then the nearest place that still exists.
 */
export function insertAt(text: string, at: number, markdown: string): string {
  const position = Math.max(0, Math.min(at, text.length));
  return `${text.slice(0, position)}${markdown}${text.slice(position)}`;
}

/** Session-wide, see the note at the top. */
let nextUploadId = 1;

export class PastedImageUploads {
  private uploads: PastedUpload[] = [];

  /** Every request not yet inserted, in paste order. */
  get all(): readonly PastedUpload[] {
    return this.uploads;
  }

  /** How many are still queued or in flight. */
  get active(): number {
    return this.uploads.filter((upload) => upload.status !== "failed").length;
  }

  /** How many could not be stored. */
  get failed(): number {
    return this.uploads.filter((upload) => upload.status === "failed").length;
  }

  /** The one in flight, if any. */
  get sending(): PastedUpload | null {
    return this.uploads.find((upload) => upload.status === "sending") ?? null;
  }

  /** Queue a picture pasted into `field` at `at`. Returns its request id. */
  add(field: PasteField, at: number, dataUrl: string): number {
    const id = nextUploadId;
    nextUploadId += 1;
    this.uploads = [...this.uploads, { id, field, at, dataUrl, status: "queued" }];
    return id;
  }

  /**
   * The next request to send, now marked as in flight, or null when one is
   * already in flight or nothing is waiting.
   */
  startNext(): PastedUpload | null {
    if (this.sending !== null) return null;
    const next = this.uploads.find((upload) => upload.status === "queued");
    if (next === undefined) return null;
    const started: PastedUpload = { ...next, status: "sending" };
    this.uploads = this.uploads.map((upload) => (upload.id === next.id ? started : upload));
    return started;
  }

  /**
   * Request `id` was stored at `url`: where to insert it.
   *
   * Every other picture still waiting for the same field at or after that
   * position moves along by what was inserted, so a later answer still lands
   * where it was pasted rather than inside the picture before it.
   */
  resolve(id: number, url: string): ImageInsertion | null {
    const done = this.uploads.find((upload) => upload.id === id);
    if (done === undefined || done.status === "failed") return null;
    const markdown = imageMarkdown(url);
    this.uploads = this.uploads
      .filter((upload) => upload.id !== id)
      .map((upload) =>
        upload.field === done.field && upload.at >= done.at
          ? { ...upload, at: upload.at + markdown.length }
          : upload,
      );
    return { field: done.field, at: done.at, markdown };
  }

  /**
   * The backend's answer to request `requestId`: where to insert the picture,
   * or null when it failed, was already given up on, or is not ours.
   */
  answer(requestId: number, url: string | null): ImageInsertion | null {
    if (url === null) {
      this.fail(requestId);
      return null;
    }
    return this.resolve(requestId, url);
  }

  /** Request `id` could not be stored. It stays listed so the form can say so. */
  fail(id: number): void {
    this.uploads = this.uploads.map((upload) =>
      upload.id === id && upload.status !== "failed" ? { ...upload, status: "failed" } : upload,
    );
  }

  /** Forget the failures once the organiser has seen them. */
  dismissFailures(): void {
    this.uploads = this.uploads.filter((upload) => upload.status !== "failed");
  }
}
