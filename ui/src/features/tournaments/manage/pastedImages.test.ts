// Pictures pasted into several fields before the first upload has answered.
// Each must land where it was pasted, and a failed one must be said, not
// silently credited with the next picture's path.

import { describe, expect, it } from "vitest";
import { imageMarkdown, insertAt, PastedImageUploads, type ImageInsertion } from "./pastedImages";

/** The fields of a draft, with each insertion applied the way the form does. */
function applyAll(texts: Record<string, string>, insertions: (ImageInsertion | null)[]) {
  const next = { ...texts };
  for (const insertion of insertions) {
    if (insertion === null) continue;
    next[insertion.field] = insertAt(next[insertion.field], insertion.at, insertion.markdown);
  }
  return next;
}

/** Send the next request and answer it with `url`, as the backend would. */
function sendAndAnswer(uploads: PastedImageUploads, url: string | null) {
  const sent = uploads.startNext();
  if (sent === null) throw new Error("nothing to send");
  return uploads.answer(sent.id, url);
}

describe("PastedImageUploads", () => {
  it("sends one at a time, in paste order", () => {
    const uploads = new PastedImageUploads();
    uploads.add("description", 0, "data:a");
    uploads.add("sponsors", 0, "data:b");

    const first = uploads.startNext();
    expect(first?.dataUrl).toBe("data:a");
    // Still in flight, so nothing else goes out.
    expect(uploads.startNext()).toBeNull();
    uploads.answer(first!.id, "/a.png");
    expect(uploads.startNext()?.dataUrl).toBe("data:b");
  });

  it("puts a description paste and a sponsors paste each in its own field", () => {
    const texts = { description: "Intro. Rules.", sponsors: "Thanks to" };
    const uploads = new PastedImageUploads();
    uploads.add("description", 6, "data:a");
    uploads.add("sponsors", 9, "data:b");

    const first = sendAndAnswer(uploads, "/a.png");
    const second = sendAndAnswer(uploads, "/b.png");

    expect(applyAll(texts, [first, second])).toEqual({
      description: `Intro.${imageMarkdown("/a.png")} Rules.`,
      sponsors: `Thanks to${imageMarkdown("/b.png")}`,
    });
    expect(uploads.active).toBe(0);
  });

  it("moves a later paste in the same field along by what landed before it", () => {
    const texts = { description: "one two" };
    const uploads = new PastedImageUploads();
    // Pasted after "one" and then at the very end.
    uploads.add("description", 3, "data:a");
    uploads.add("description", 7, "data:b");

    const first = sendAndAnswer(uploads, "/a.png");
    const second = sendAndAnswer(uploads, "/b.png");

    expect(applyAll(texts, [first, second]).description).toBe(
      `one${imageMarkdown("/a.png")} two${imageMarkdown("/b.png")}`,
    );
  });

  it("leaves an earlier position alone when a later one lands first", () => {
    const uploads = new PastedImageUploads();
    const late = uploads.add("description", 10, "data:a");
    const early = uploads.add("description", 2, "data:b");

    const first = uploads.resolve(late, "/a.png");
    const second = uploads.resolve(early, "/b.png");

    expect(first?.at).toBe(10);
    expect(second?.at).toBe(2);
  });

  it("keeps two pastes at the same caret in the order they were pasted", () => {
    const texts = { rewards: "ab" };
    const uploads = new PastedImageUploads();
    uploads.add("rewards", 1, "data:a");
    uploads.add("rewards", 1, "data:b");

    const first = sendAndAnswer(uploads, "/a.png");
    const second = sendAndAnswer(uploads, "/b.png");

    expect(applyAll(texts, [first, second]).rewards).toBe(
      `a${imageMarkdown("/a.png")}${imageMarkdown("/b.png")}b`,
    );
  });

  it("marks an upload the backend says failed, and moves on", () => {
    const uploads = new PastedImageUploads();
    uploads.add("description", 0, "data:a");
    uploads.add("sponsors", 0, "data:b");

    expect(sendAndAnswer(uploads, null)).toBeNull();
    expect(uploads.failed).toBe(1);
    expect(uploads.active).toBe(1);
    expect(sendAndAnswer(uploads, "/b.png")?.field).toBe("sponsors");

    uploads.dismissFailures();
    expect(uploads.all).toEqual([]);
  });

  // The case the id exists for: the form gave up on the first upload, sent
  // the second, and then the first one's answer arrived after all.
  it("never credits a late answer for a given-up upload to the next one", () => {
    const uploads = new PastedImageUploads();
    uploads.add("description", 0, "data:a");
    uploads.add("sponsors", 0, "data:b");

    const first = uploads.startNext()!;
    uploads.fail(first.id);
    const second = uploads.startNext()!;

    expect(uploads.answer(first.id, "/a.png")).toBeNull();
    expect(uploads.sending?.id).toBe(second.id);
    expect(uploads.answer(second.id, "/b.png")?.field).toBe("sponsors");
  });

  it("ignores an answer that is not for one of its requests", () => {
    const uploads = new PastedImageUploads();
    uploads.add("description", 0, "data:a");
    const stray = uploads.startNext()!.id + 1_000;
    expect(uploads.answer(stray, "/stray.png")).toBeNull();
    expect(uploads.active).toBe(1);
  });

  it("numbers requests across forms, so a closed form's answer matches nothing new", () => {
    const closed = new PastedImageUploads();
    const old = closed.add("description", 0, "data:a");
    const fresh = new PastedImageUploads();
    expect(fresh.add("description", 0, "data:b")).not.toBe(old);
  });
});

describe("insertAt", () => {
  it("clamps a position the text has since shrunk past", () => {
    expect(insertAt("ab", 10, "X")).toBe("abX");
    expect(insertAt("ab", -1, "X")).toBe("Xab");
  });
});
