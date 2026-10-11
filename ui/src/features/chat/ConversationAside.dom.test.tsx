// @vitest-environment happy-dom
//
// The side panel of a private conversation, for somebody who is not in a game:
// it says whether they are online, and it says "offline" only when the client
// really knows. The lobby's list of who is online is only a list of who is
// online once it has arrived; before that, or without a lobby connection at
// all, the panel says nothing about it rather than calling everybody offline.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel, LobbyStatus, PlayerProfile, SocialState } from "../../ipc/bindings";
import { resetLocaleForTests } from "../../i18n/store";
import "../../testing/mounted";
import { ConversationAside } from "./ConversationAside";

vi.mock("../../ipc/client");

function profile(login: string): PlayerProfile {
  return {
    id: login.length,
    login,
    globalRating: 1_200,
    ratings: [],
    country: "de",
    clan: "",
    avatarUrl: "",
    avatarTooltip: "",
  };
}

function channel(name: string, users: string[]): ChatChannel {
  return {
    name,
    topic: "",
    messages: [],
    users: users.map((user) => ({ name: user, elevation: "" })),
    unread: 0,
    unreadMentions: 0,
    typing: [],
    reactions: [],
  };
}

interface Setup {
  players?: string[];
  lobbyStatus?: LobbyStatus;
  channels?: ChatChannel[];
}

function renderAside({ players = [], lobbyStatus = "connected", channels = [] }: Setup) {
  const social: SocialState = {
    friends: [],
    foes: [],
    loginLookups: [],
    players: players.map(profile),
  };
  render(
    <ConversationAside
      peer="Wifi_"
      self="Me"
      social={social}
      lobbyStatus={lobbyStatus}
      channels={channels}
      openGames={[]}
      liveGames={[]}
      mapVault={[]}
      now={0}
      onOpenConversation={() => {}}
      onPlayerContextMenu={() => {}}
      tier="medium"
    />,
  );
}

const notInGame = "Wifi_ is not in a game right now.";

beforeEach(() => {
  resetLocaleForTests("en");
});

describe("private conversation aside, presence", () => {
  it("says the peer is online when the lobby lists them, whatever the case of the name", () => {
    renderAside({ players: ["Me", "Someone", "wifi_"] });

    expect(screen.getByText("Wifi_ is online.")).toBeTruthy();
    expect(screen.getByText(notInGame)).toBeTruthy();
    expect(screen.queryByText("Wifi_ is offline.")).toBeNull();
  });

  it("says the peer is online when they share a channel with us, even without a lobby account", () => {
    renderAside({ players: ["Me", "Someone"], channels: [channel("#aeolus", ["Me", "Wifi_"])] });

    expect(screen.getByText("Wifi_ is online.")).toBeTruthy();
    expect(screen.queryByText("Wifi_ is offline.")).toBeNull();
  });

  it("says the peer is offline when the lobby's full list has arrived without them", () => {
    renderAside({ players: ["Me", "Someone"], channels: [channel("#aeolus", ["Me", "Someone"])] });

    expect(screen.getByText("Wifi_ is offline.")).toBeTruthy();
    // Somebody offline is not in a game; saying so as well is noise.
    expect(screen.queryByText(notInGame)).toBeNull();
    expect(screen.queryByText("Wifi_ is online.")).toBeNull();
  });

  it("says nothing about presence without a lobby connection", () => {
    // Even with a directory still held from the connection that just went:
    // nobody is telling us about departures any more.
    renderAside({ players: ["Me", "Someone"], lobbyStatus: "disconnected" });

    expect(screen.getByText(notInGame)).toBeTruthy();
    expect(screen.queryByText("Wifi_ is offline.")).toBeNull();
    expect(screen.queryByText("Wifi_ is online.")).toBeNull();
  });

  it("says nothing about presence while the lobby has only introduced us", () => {
    // `welcome` carries our own profile, and the list of everybody else is
    // the next message: in between, a missing name means nothing yet.
    renderAside({ players: ["Me"] });

    expect(screen.getByText(notInGame)).toBeTruthy();
    expect(screen.queryByText("Wifi_ is offline.")).toBeNull();
    expect(screen.queryByText("Wifi_ is online.")).toBeNull();
  });
});
