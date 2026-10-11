// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "../../ipc/bindings";
import { ChannelTabs } from "./ChannelTabs";

afterEach(cleanup);
function Harness({ leave }: { leave: (name: string) => void }) {
  const [active, setActive] = useState("#main");
  const [names, setNames] = useState(["#main", "#second", "#third"]);
  const channels = names.map((name) => ({ name, unread: 0, unreadMentions: 0 } as ChatChannel));
  return <ChannelTabs channels={channels} active={active} defaultChannel="#main"
    onSelect={setActive} onJoin={() => { }} onLeave={(name) => {
      leave(name);
      setNames((previous) => previous.filter((item) => item !== name));
    }} />;
}

describe("Channel tabs keyboard", () => {
  it("has one channel tab stop, wraps arrows, and supports Home/End", () => {
    render(<Harness leave={() => { }} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("keeps pinned rooms and transfers focus when Delete closes a conversation", () => {
    const leave = vi.fn();
    render(<Harness leave={leave} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "Delete" });
    expect(leave).not.toHaveBeenCalled();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    fireEvent.keyDown(tabs[1], { key: "Delete" });
    expect(leave).toHaveBeenCalledWith("#second");
    expect(document.activeElement).toBe(tabs[2]);
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0]);
  });
});
