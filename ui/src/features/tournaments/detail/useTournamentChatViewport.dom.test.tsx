// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTournamentChatViewport } from "./useTournamentChatViewport";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Harness({ enabled = true }: { enabled?: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  useTournamentChatViewport(pane, row, enabled);
  return <div ref={pane} data-testid="pane" style={{ paddingBottom: 16 }}><header>Header</header><div ref={row} data-testid="row">Chat</div></div>;
}

describe("the tournament chat viewport", () => {
  it("fits beneath the header and follows scrolling and resizing without moving the page", () => {
    let resize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    let top = 480;
    let height = 800;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "pane" ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { top: this.dataset.testid === "pane" ? 100 : top } as DOMRect;
    });
    const view = render(<Harness />);
    const pane = view.getByTestId("pane");
    const row = view.getByTestId("row");
    pane.scrollTop = 120;
    expect(row.style.getPropertyValue("--tournament-chat-height")).toBe("404px");
    top = 360;
    fireEvent.scroll(pane);
    expect(row.style.getPropertyValue("--tournament-chat-height")).toBe("524px");
    expect(pane.scrollTop).toBe(120);
    height = 600;
    act(() => resize());
    expect(row.style.getPropertyValue("--tournament-chat-height")).toBe("324px");
    top = 800;
    fireEvent(window, new Event("resize"));
    expect(row.style.getPropertyValue("--tournament-chat-height")).toBe("0px");
    view.rerender(<Harness enabled={false} />);
    expect(disconnect).toHaveBeenCalled();
    expect(row.style.getPropertyValue("--tournament-chat-height")).toBe("");
  });
});
