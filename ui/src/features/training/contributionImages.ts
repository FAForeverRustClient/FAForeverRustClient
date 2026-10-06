// Pictures attached to the guide being written.
//
// Held here rather than in the draft the backend keeps, on purpose. The draft
// is handed to the state after every pause in typing, and megabytes of
// pictures on each of those hand-overs would be the whole cost of the form.
// So the pictures stay on this side as the files the author picked, are shown
// from addresses this client makes for them, and cross to the backend once,
// with the submission (see `GuidesCommand::Submit`).
//
// Module state rather than component state for the same reason the draft is
// kept in the backend at all: opening the library or another tab unmounts the
// form, and a picture that vanished with it would leave its `![](...)` behind
// in the text pointing at nothing.
//
// The editor refers to a picture as `images/<name>`, relative to the guide.
// Sending rewrites that to the folder it is committed to; nothing here needs
// to know the guide's id.

import { useSyncExternalStore } from "react";
import type { DraftImage } from "../../ipc/bindings";

/**
 * Twins of `MAX_IMAGE_BYTES`, `MAX_IMAGES` and `MAX_IMAGES_TOTAL_BYTES` in
 * `faf_domain::state::guides`. The backend decides; these only let the form
 * answer the moment a file is picked rather than when it is sent.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 20;
export const MAX_IMAGES_TOTAL_BYTES = 25 * 1024 * 1024;

/** The folder the editor writes, twin of `DRAFT_IMAGE_DIR`. */
const DIR = "images";

/** What the file input offers, and the extension each one is named with. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const ACCEPTED_TYPES = Object.keys(EXTENSIONS).join(",");

export interface Attachment {
  /** The file's name in the guide: lowercase, digits and hyphens. */
  name: string;
  file: Blob;
  /** An address this client made for the file, for showing it before it is sent. */
  url: string;
  size: number;
}

export type AttachProblem = "type" | "size" | "count" | "total";

let held: readonly Attachment[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly Attachment[]) {
  held = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The pictures attached now, kept current. */
export function useAttachments(): readonly Attachment[] {
  return useSyncExternalStore(subscribe, () => held);
}

export function attachments(): readonly Attachment[] {
  return held;
}

/**
 * A name the repository and a URL both survive, unique among `taken`.
 *
 * The backend refuses anything else rather than renaming it, so the name the
 * guide's text refers to and the file's name stay one thing: lowercase ASCII
 * letters, digits and hyphens, then the extension the file's type calls for.
 */
export function imageName(fileName: string, extension: string, taken: ReadonlySet<string>): string {
  const stem =
    fileName
      .replace(/\.[^.]*$/, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "picture";
  let name = `${stem}.${extension}`;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${stem}-${suffix}.${extension}`;
  return name;
}

/** Attach a picture, or say why it cannot be. */
export function attach(file: File): { attachment: Attachment } | { problem: AttachProblem } {
  const extension = EXTENSIONS[file.type];
  if (!extension) return { problem: "type" };
  if (file.size > MAX_IMAGE_BYTES) return { problem: "size" };
  if (held.length >= MAX_IMAGES) return { problem: "count" };
  const total = held.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total + file.size > MAX_IMAGES_TOTAL_BYTES) return { problem: "total" };

  const name = imageName(file.name, extension, new Set(held.map((attachment) => attachment.name)));
  const attachment = { name, file, url: URL.createObjectURL(file), size: file.size };
  publish([...held, attachment]);
  return { attachment };
}

export function detach(name: string) {
  const gone = held.find((attachment) => attachment.name === name);
  if (!gone) return;
  URL.revokeObjectURL(gone.url);
  publish(held.filter((attachment) => attachment !== gone));
}

export function clearAttachments() {
  for (const attachment of held) URL.revokeObjectURL(attachment.url);
  publish([]);
}

/** The path the editor writes for a picture. */
export function imagePath(name: string): string {
  return `${DIR}/${name}`;
}

/** The Markdown that shows a picture where it is inserted. */
export function imageMarkdown(name: string): string {
  return `![](${imagePath(name)})`;
}

/** Each attached picture's editor path, to the address it is shown from. */
export function localImages(list: readonly Attachment[]): ReadonlyMap<string, string> {
  return new Map(list.map((attachment) => [imagePath(attachment.name), attachment.url]));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text with every reference to the picture `name` taken out: a removed
 * picture would otherwise leave its Markdown behind, shown as a broken line.
 */
export function withoutImage(body: string, name: string): string {
  const path = escapeRegExp(imagePath(name));
  return body
    .replace(new RegExp(`!\\[[^\\]]*\\]\\(${path}\\)[ \\t]*\\n?`, "g"), "")
    .replace(new RegExp(`<img\\s[^>]*src=["']${path}["'][^>]*>[ \\t]*\\n?`, "gi"), "");
}

/** Whether the text still shows the picture `name`. Twin of `refers_to_image`. */
export function refersToImage(body: string, name: string): boolean {
  const path = imagePath(name);
  return (
    body.includes(`](${path})`) || body.includes(`src="${path}"`) || body.includes(`src='${path}'`)
  );
}

function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // A data URL, because that is what was asked for: the base64 is
      // everything after its comma.
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("the picture could not be read"));
    reader.readAsDataURL(file);
  });
}

/**
 * The pictures to send with a submission: the ones its text still shows.
 * The backend drops the rest too; leaving them out here saves the trip.
 */
export async function draftImages(body: string): Promise<DraftImage[]> {
  const shown = held.filter((attachment) => refersToImage(body, attachment.name));
  return Promise.all(
    shown.map(async (attachment) => ({
      name: attachment.name,
      data: await base64Of(attachment.file),
    })),
  );
}
