import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatChannel } from "../../ipc/bindings";
import { resetLocaleForTests } from "../../i18n/store";
import { ChannelTabs } from "./ChannelTabs";

function channel(name: string, unread: number): ChatChannel {
  return { name, unread, unreadMentions: 0 } as ChatChannel;
}

function render(): string {
  return renderToStaticMarkup(
    <ChannelTabs
      channels={[channel("#aeolus", 0), channel("#newbie", 3)]}
      active="#aeolus"
      defaultChannel="#aeolus"
      onSelect={() => {}}
      onJoin={() => {}}
      onLeave={() => {}}
    />,
  );
}

describe("channel tab labels", () => {
  it("names the unread count and the close button through the catalogue", () => {
    resetLocaleForTests("en");
    const markup = render();
    expect(markup).toContain('aria-label="3 unread messages"');
    expect(markup).toContain('aria-label="Leave #newbie"');
  });

  it("does not leave English fragments in a translated strip", () => {
    resetLocaleForTests("de");
    try {
      const markup = render();
      expect(markup).toContain('aria-label="3 ungelesene Nachrichten"');
      expect(markup).toContain('aria-label="#newbie verlassen"');
      expect(markup).not.toContain("unread");
      expect(markup).not.toContain("Leave");
    } finally {
      resetLocaleForTests("en");
    }
  });
});
