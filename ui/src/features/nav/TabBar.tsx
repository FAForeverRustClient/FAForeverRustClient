// Tab navigation. Renders the registry in TAB_ORDER; selecting a tab dispatches a
// Nav command and the active tab is read from state. No local routing state: the
// backend is the source of truth, so backend events can switch tabs too.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { GameFoldersMenu } from "../game-folders/GameFoldersMenu";
import { openTabForMode, TABS, tabsForMode } from "./tabs";
import type { Tab } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import "./nav.css";

/**
 * The tabs that sit under the spacer rather than in the run of places to play.
 *
 * The client's own furniture: where the links out live, and where the settings
 * live. The bottom group draws them one at a time, because the Game folders
 * button goes between them; this list is what keeps them out of the group
 * above.
 */
const BOTTOM_TABS: Tab[] = ["links", "settings"];

export function TabBar() {
  const mode = useAppStore((s) => s.state.auth.mode);
  // The tab on screen, which is not the selected one when the selected one is
  // not open to this session. Same projection the shell renders from.
  const active = useAppStore((s) => openTabForMode(mode, s.state.nav.activeTab));
  const tabs = tabsForMode(mode);
  // Looked up per render rather than read from the `TABS` registry, whose
  // `label` is a fixed English string. Resolving through the hook is what makes
  // the bar follow a language change instead of being fixed at import time.
  const { t } = useTranslation();

  const select = (tab: Tab) =>
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab } } });

  // What wants the player from another tab. The rail named places and nothing
  // else, so a mention, a private message or a running search was invisible
  // from anywhere but its own tab. Each read as a number, not a list, so the
  // rail redraws when a count changes rather than on every chat line.
  const mentions = useAppStore((s) =>
    s.state.chat.channels.reduce((sum, channel) => sum + channel.unreadMentions, 0));
  const unread = useAppStore((s) =>
    s.state.chat.channels.reduce((sum, channel) => sum + channel.unread, 0));
  const matchmaking = useAppStore((s) => s.state.lobby.matchmaking.type);

  const badgeFor = (id: Tab): { text: string; label: string; loud: boolean } | null => {
    if (id === "chat" && mentions > 0) {
      return { text: mentions > 99 ? "99+" : String(mentions), label: t("nav.badge.mentions", { count: mentions }), loud: true };
    }
    if (id === "chat" && unread > 0) return { text: "", label: t("nav.badge.unread"), loud: false };
    if (id === "play" && matchmaking === "matchFound") {
      return { text: "!", label: t("nav.badge.matchFound"), loud: true };
    }
    if (id === "play" && (matchmaking === "searching" || matchmaking === "launching")) {
      return { text: "", label: t("nav.badge.searching"), loud: false };
    }
    return null;
  };

  // Ending an offline session puts the login screen back. `logoutTest` is the
  // teardown for a session that never held a token, which is what an offline
  // one is; see `AccountSupportSettingsSection`, where the same control sits
  // under a name about leaving rather than about arriving.
  const signIn = () => ipc.send({ kind: "Auth", command: { type: "logoutTest" } });

  const renderTab = (id: Tab) => {
    const label = t(`nav.tab.${id}.label`);
    const badge = badgeFor(id);
    // The badge is part of the name, so a screen reader hears it too.
    const name = badge ? `${label}, ${badge.label}` : label;
    return (
      <button
        key={id}
        className={id === active ? "tab tab-active" : "tab"}
        onClick={() => select(id)}
        aria-current={id === active ? "page" : undefined}
        aria-label={name}
        title={name}
      >
        <Icon name={TABS[id].icon} size={17} />
        <span>{label}</span>
        {badge && (
          <span
            className={`tab-badge${badge.loud ? " is-loud" : ""}${badge.text ? "" : " is-dot"}`}
            aria-hidden="true"
          >
            {badge.text}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav className="tabbar" aria-label={t("nav.main")}>
      <div className="nav-group">
        {tabs.filter((id) => !BOTTOM_TABS.includes(id)).map(renderTab)}
      </div>
      <div className="nav-spacer" />
      <div className="nav-group">
        {/* The way back into an account, in the corner every other session
            keeps its account controls in, and above the settings rather than
            inside them: an offline session is one somebody is trying to leave
            more often than one they are configuring. */}
        {mode === "offline" && (
          <button
            className="tab tab-sign-in"
            onClick={signIn}
            aria-label={t("auth.signIn")}
            title={t("auth.signIn")}
          >
            <Icon name="users" size={17} />
            <span>{t("auth.signIn")}</span>
          </button>
        )}
        {tabs.filter((id) => id === "links").map(renderTab)}
        {/* Not a tab: it opens directories in the operating system's file
            manager rather than a view in the client, so it selects nothing and
            has no place in the registry. It sits here because this is where the
            issue put it, between the links out and the settings. Offline too:
            these folders are on this disk and are exactly what a session with
            no account can still use. */}
        <GameFoldersMenu />
        {tabs.filter((id) => id === "settings").map(renderTab)}
      </div>
    </nav>
  );
}
