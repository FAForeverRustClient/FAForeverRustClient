// @vitest-environment happy-dom
//
// A picture that failed hides itself, and a new picture in the same element
// starts out visible again. The handlers this replaced hid the element for
// good, so a flag or league badge that failed once stayed hidden after its
// source changed to one that loads.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecoverableImage } from "./RecoverableImage";

const image = (container: HTMLElement) => container.querySelector("img")!;

describe("RecoverableImage", () => {
  it("keeps its box when hidden, and shows a new source again", () => {
    const { container, rerender } = render(<RecoverableImage src="/flags/xx.png" alt="" width={16} height={16} />);
    fireEvent.error(image(container));
    expect(image(container).style.visibility).toBe("hidden");
    expect(image(container).hidden).toBe(false);

    rerender(<RecoverableImage src="/flags/de.png" alt="" width={16} height={16} />);
    expect(image(container).style.visibility).toBe("");
    fireEvent.load(image(container));
    expect(image(container).style.visibility).toBe("");

    // And the new source failing hides it again.
    fireEvent.error(image(container));
    expect(image(container).style.visibility).toBe("hidden");
  });

  it("can leave the layout instead, and comes back the same way", () => {
    const { container, rerender } = render(<RecoverableImage src="/league/old.png" alt="" whenBroken="remove" />);
    fireEvent.error(image(container));
    expect(image(container).hidden).toBe(true);

    rerender(<RecoverableImage src="/league/new.png" alt="" whenBroken="remove" />);
    expect(image(container).hidden).toBe(false);
  });

  it("keeps a style of its own and still runs a caller's error handler", () => {
    let called = 0;
    const { container } = render(
      <RecoverableImage src="/a.png" alt="" style={{ opacity: 0.5 }} onError={() => { called += 1; }} />,
    );
    fireEvent.error(image(container));
    expect(called).toBe(1);
    expect(image(container).style.opacity).toBe("0.5");
    expect(image(container).style.visibility).toBe("hidden");
  });
});
