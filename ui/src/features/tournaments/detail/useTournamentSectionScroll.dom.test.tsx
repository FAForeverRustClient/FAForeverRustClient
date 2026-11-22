// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useTournamentSectionScroll } from "./useTournamentSectionScroll";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness() {
  const pane = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLElement>(null);
  const [section, setSection] = useState("Long");
  const remember = useTournamentSectionScroll(pane, row, tabs);

  return (
    <div ref={pane} data-testid="pane" style={{ paddingBottom: 16 }}>
      <nav ref={tabs}>
        <button onClick={() => { remember(true); setSection("Short"); }}>Short</button>
      </nav>
      <div ref={row} data-testid="row">{section}</div>
    </div>
  );
}

it("holds a scrolled header in place without leaving a scrollable tail", () => {
  let scrollAt = 0;
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() => scrollAt);
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation((value) => { scrollAt = value; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.testid === "row" ? 340 - scrollAt : 100;
    return { top } as DOMRect;
  });
  const view = render(<Harness />);
  const pane = view.getByTestId("pane");
  const row = view.getByTestId("row");
  const floor = () => row.style.getPropertyValue("--tournament-scroll-floor");
  expect(floor()).toBe("");

  pane.scrollTop = 140;
  fireEvent.click(view.getByRole("button", { name: "Short" }));
  expect(floor()).toBe("484px");
  expect(pane.scrollTop).toBe(140);

  pane.scrollTop = 80;
  fireEvent.scroll(pane);
  expect(floor()).toBe("424px");

  pane.scrollTop = 0;
  fireEvent.scroll(pane);
  expect(floor()).toBe("");
});
