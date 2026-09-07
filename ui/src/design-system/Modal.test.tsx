import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal, isBackdropDismissal } from "./Modal";

describe("Modal", () => {
  it("dismisses only when the whole gesture stayed on the backdrop", () => {
    expect(isBackdropDismissal(true, true)).toBe(true);

    // The reported bug: the press starts inside the panel - marking the lobby
    // name - and the button comes up over the backdrop. The click lands on the
    // backdrop because that is the common ancestor of the two targets, and the
    // host dialog closed with everything the player had entered.
    expect(isBackdropDismissal(false, true)).toBe(false);

    // The mirror image: a press on the backdrop released over the panel.
    expect(isBackdropDismissal(true, false)).toBe(false);
    expect(isBackdropDismissal(false, false)).toBe(false);
  });

  it("renders the panel inside the backdrop with a dialog role", () => {
    const markup = renderToStaticMarkup(
      <Modal onClose={() => {}} ariaLabel="Host game">
        <p>Body</p>
      </Modal>,
    );

    expect(markup).toContain('class="modal-backdrop"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Host game"');
  });

  it("offers a way out by default", () => {
    const markup = renderToStaticMarkup(
      <Modal onClose={() => {}}>
        <p>Body</p>
      </Modal>,
    );
    expect(markup).toContain('class="modal-close"');
  });

  it("removes the close button entirely when it is not dismissible", () => {
    // Rather than leaving it there to do nothing, which is how a dialog
    // comes to look broken. Escape and the backdrop go the same way; both
    // are event handlers, and this renderer runs none.
    const markup = renderToStaticMarkup(
      <Modal onClose={() => {}} dismissible={false}>
        <p>Body</p>
      </Modal>,
    );
    expect(markup).not.toContain('class="modal-close"');
    expect(markup).toContain('role="dialog"');
  });
});
