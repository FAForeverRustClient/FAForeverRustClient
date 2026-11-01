// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Contact, PlayerProfile } from "../../ipc/bindings";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { ContactsDialog } from "./ContactsDialog";
import { ChatView } from "../chat/ChatView";
import { ProfileMenu } from "../shell/ProfileMenu";
import { openContacts } from "../../shared/contactsActions";

vi.mock("../../ipc/client");
failOnConsoleError();
const profile = (id: number, login: string): PlayerProfile => ({
  id, login, ratings: [], globalRating: 1000, country: "", clan: "", avatarUrl: "", avatarTooltip: "",
});
const entries: Contact[] = [
  { playerId: 1, login: "Alpha", relation: "friend" },
  { playerId: 2, login: "Beta", relation: "friend" },
  { playerId: 3, login: "Zed", relation: "friend" },
  { playerId: 4, login: "Enemy", relation: "foe" },
];
function seed(contacts = entries) {
  seedStore(state => ({ ...state,
    lobby: { ...state.lobby, status: "connected" },
    social: { ...state.social, friends: ["Alpha", "Beta", "Zed"], foes: ["Enemy"],
      players: [profile(3, "Zed")], contacts: { open: true, refreshing: false, entries: contacts } },
  }));
}

describe("Contacts", () => {
  it("shows available avatars with their tooltip and an initial when no image is known", () => {
    seed();
    applyEvent({ kind: "Social", event: { type: "playersSeen", payload: { players: [{
      ...profile(3, "Zed"), avatarUrl: "https://example.invalid/avatar.png", avatarTooltip: "Tournament avatar",
    }] } } });
    render(<ContactsDialog />);
    const row = screen.getByRole("button", { name: "Zed" }).closest("li")!;
    expect(row.querySelector(".contacts-avatar img")?.getAttribute("src")).toBe("https://example.invalid/avatar.png");
    expect(row.querySelector(".profile-avatar")?.getAttribute("title")).toBe("Tournament avatar");
    const fallback = screen.getByRole("button", { name: "Alpha" }).closest("li")!;
    expect(fallback.querySelector(".contacts-avatar .profile-avatar")?.textContent).toBe("A");
    expect(fallback.querySelector("img")).toBeNull();
  });

  it("includes offline friends and foes, orders online first and filters without IPC", () => {
    seed();
    render(<ContactsDialog />);
    expect(screen.getByRole("tab", { name: "Friends 3" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Foes 1" })).toBeTruthy();
    const names = () => Array.from(screen.getByRole("tabpanel").querySelectorAll(".contacts-name"), node => node.textContent);
    expect(names()).toEqual(["Zed", "Alpha", "Beta"]);
    expect(screen.getAllByText("Offline")).toHaveLength(2);
    clearSentCommands();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search contacts" }), { target: { value: "bEtA" } });
    expect(names()).toEqual(["Beta"]);
    expect(sentCommands()).toEqual([]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Foes 1" }));
    expect(names()).toEqual(["Enemy"]);
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it("removes an offline friend by stable id and updates counts from backend events", () => {
    seed();
    render(<ContactsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha from friends" }));
    expect(sentCommands()).toContainEqual({ kind: "Social", command: { type: "setRelation", payload: {
      playerId: 1, login: "Alpha", relation: "friend", member: false,
    } } });
    applyEvent({ kind: "Social", event: { type: "contactSet", payload: { contact: entries[0], member: false } } });
    expect(screen.getByRole("tab", { name: "Friends 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  });

  it("reuses account actions for an offline contact without another lookup", () => {
    seed();
    render(<ContactsDialog />);
    clearSentCommands();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    expect(sentCommands()).toEqual([]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Add foe/ }));
    expect(sentCommands()).toContainEqual({ kind: "Social", command: { type: "setRelation", payload: {
      playerId: 1, login: "Alpha", relation: "foe", member: true,
    } } });
    applyEvent({ kind: "Social", event: { type: "contactSet", payload: {
      contact: { ...entries[0], relation: "foe" }, member: true,
    } } });
    expect(screen.getByRole("tab", { name: "Friends 2" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Foes 2" })).toBeTruthy();
  });

  it("keeps unnamed accounts visible, retryable and removable by id", () => {
    const missing: Contact = { playerId: 99, login: null, relation: "friend" };
    seed([...entries, missing]);
    render(<ContactsDialog />);
    expect(screen.getByRole("tab", { name: "Friends 4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account #99" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry names" }));
    expect(sentCommands()).toContainEqual({ kind: "Social", command: { type: "resolveContacts" } });
    applyEvent({ kind: "Social", event: { type: "contactsRefreshing", payload: { refreshing: true } } });
    expect(screen.getByRole("button", { name: "Loading names…" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Account #99 from friends" }));
    expect(sentCommands()).toContainEqual({ kind: "Social", command: { type: "setRelation", payload: {
      playerId: 99, login: "", relation: "friend", member: false,
    } } });
    applyEvent({ kind: "Social", event: { type: "contactSet", payload: { contact: missing, member: false } } });
    expect(screen.queryByRole("button", { name: "Account #99" })).toBeNull();
  });

  it("removes the resolved name when an unnamed removal arrives after its lookup", () => {
    seed();
    render(<ContactsDialog />);
    applyEvent({ kind: "Social", event: { type: "contactSet", payload: {
      contact: { playerId: 99, login: "Resolved", relation: "friend" }, member: true,
    } } });
    expect(screen.getByRole("button", { name: "Resolved" })).toBeTruthy();
    applyEvent({ kind: "Social", event: { type: "contactSet", payload: {
      contact: { playerId: 99, login: null, relation: "friend" }, member: false,
    } } });
    expect(screen.queryByRole("button", { name: "Resolved" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Friends 3" })).toBeTruthy();
  });

  it("uses the offline account id for a profile opened through Actions", () => {
    seed();
    render(<ContactsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    clearSentCommands();
    fireEvent.click(screen.getByRole("menuitem", { name: "View profile" }));
    expect(sentCommands().slice(0, 2)).toEqual([
      { kind: "Social", command: { type: "setContactsOpen", payload: { open: false } } },
      { kind: "PlayerCard", command: { type: "open", payload: { playerId: 1, login: "Alpha" } } },
    ]);
  });

  it("closes Contacts before opening a profile and keeps unknown presence honest", () => {
    seed();
    render(<ContactsDialog />);
    clearSentCommands();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(sentCommands().slice(0, 2)).toEqual([
      { kind: "Social", command: { type: "setContactsOpen", payload: { open: false } } },
      { kind: "PlayerCard", command: { type: "open", payload: { playerId: 1, login: "Alpha" } } },
    ]);
    applyEvent({ kind: "Social", event: { type: "playersRemoved", payload: { logins: ["Zed"] } } });
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.getAllByText("Status unavailable")).toHaveLength(3);
  });

  it("opens from Chat and the profile menu through the same command", () => {
    render(<ChatView />);
    clearSentCommands();
    fireEvent.click(screen.getByRole("button", { name: "Contacts" }));
    expect(sentCommands()).toEqual([{ kind: "Social", command: { type: "setContactsOpen", payload: { open: true } } }]);
    const onClose = vi.fn();
    render(<ProfileMenu target={{ x: 0, y: 0 }} name="Self" onCopyName={() => {}}
      onContacts={openContacts} onPlayOffline={() => {}} onLogOut={() => {}} onClose={onClose} />);
    clearSentCommands();
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Contacts" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(sentCommands()).toEqual([{ kind: "Social", command: { type: "setContactsOpen", payload: { open: true } } }]);
  });
});
