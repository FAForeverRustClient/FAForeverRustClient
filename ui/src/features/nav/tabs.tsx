// Tab registry: the single place tabs are defined. Each Tab maps to a label and
// a view component; TabBar renders the labels (in TAB_ORDER) and AppShell renders
// the active view. Adding a tab = a `Tab` variant in faf-domain + one entry here.
//
// Labels are message *keys*, not text: this registry is a module-level constant,
// so a literal here would be captured once at import time and would not change
// when the user switches language. Callers resolve them with `t()` at render.

import { lazy, type ComponentType } from "react";
import type { AuthMode, Tab } from "../../ipc/bindings";
import type { IconName } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
const ChangelogView = lazy(() =>
  import("../changelog/ChangelogView").then((module) => ({ default: module.ChangelogView })),
);
const ChatView = lazy(() =>
  import("../chat/ChatView").then((module) => ({ default: module.ChatView })),
);
const LeaderboardView = lazy(() =>
  import("../leaderboard/LeaderboardView").then((module) => ({ default: module.LeaderboardView })),
);
const LinksView = lazy(() =>
  import("../links/LinksView").then((module) => ({ default: module.LinksView })),
);
const LobbyView = lazy(() =>
  import("../lobby/LobbyView").then((module) => ({ default: module.LobbyView })),
);
const MapsView = lazy(() =>
  import("../maps/MapsView").then((module) => ({ default: module.MapsView })),
);
const ModsView = lazy(() =>
  import("../mods/ModsView").then((module) => ({ default: module.ModsView })),
);
const NewsView = lazy(() =>
  import("../news/NewsView").then((module) => ({ default: module.NewsView })),
);
const ReplaysView = lazy(() =>
  import("../replays/ReplaysView").then((module) => ({ default: module.ReplaysView })),
);
const SettingsView = lazy(() =>
  import("../settings/SettingsView").then((module) => ({ default: module.SettingsView })),
);
const TournamentsView = lazy(() =>
  import("../tournaments/TournamentsView").then((module) => ({ default: module.TournamentsView })),
);
const TrainingView = lazy(() =>
  import("../training/TrainingView").then((module) => ({ default: module.TrainingView })),
);
const UnitsView = lazy(() =>
  import("../units/UnitsView").then((module) => ({ default: module.UnitsView })),
);

interface TabDef {
  label: MessageKey;
  description: MessageKey;
  icon: IconName;
  Component: ComponentType;
}

/** Left-to-right order in the tab bar. */
export const TAB_ORDER: Tab[] = [
  "news",
  "chat",
  "play",
  "replays",
  "maps",
  "mods",
  "leaderboard",
  "tournaments",
  "training",
  "changelog",
  "units",
  "links",
  "settings",
];

/**
 * The tabs an offline session opens with.
 *
 * Everything else in this registry asks the server something the moment it
 * mounts: a vault crawl, a lobby socket, a leaderboard page, an embedded web
 * view. These two do not. The replay archive is a folder on this disk and the
 * settings are a file next to it, which is the whole of what the client can
 * honestly offer with nobody signed in. See `AuthMode::Offline`.
 */
export const OFFLINE_TABS: Tab[] = ["replays", "settings"];

/** Which tabs this session may open: everything, unless it has no account. */
export function tabsForMode(mode: AuthMode): Tab[] {
  return mode === "offline" ? TAB_ORDER.filter((tab) => OFFLINE_TABS.includes(tab)) : TAB_ORDER;
}

/**
 * The tab actually on screen.
 *
 * The selected tab is application state and outlives a session, so an offline
 * session that follows a signed-in one starts on a tab it cannot open. This
 * projects that away without writing to the state: the account's tab is still
 * the selected one when it signs back in.
 */
export function openTabForMode(mode: AuthMode, activeTab: Tab): Tab {
  const openable = tabsForMode(mode);
  return openable.includes(activeTab) ? activeTab : openable[0];
}

export const TABS: Record<Tab, TabDef> = {
  news: { label: "nav.tab.news.label", description: "nav.tab.news.description", icon: "news", Component: NewsView },
  chat: { label: "nav.tab.chat.label", description: "nav.tab.chat.description", icon: "chat", Component: ChatView },
  play: { label: "nav.tab.play.label", description: "nav.tab.play.description", icon: "play", Component: LobbyView },
  links: { label: "nav.tab.links.label", description: "nav.tab.links.description", icon: "external", Component: LinksView },
  replays: { label: "nav.tab.replays.label", description: "nav.tab.replays.description", icon: "replays", Component: ReplaysView },
  maps: { label: "nav.tab.maps.label", description: "nav.tab.maps.description", icon: "maps", Component: MapsView },
  mods: { label: "nav.tab.mods.label", description: "nav.tab.mods.description", icon: "mods", Component: ModsView },
  leaderboard: { label: "nav.tab.leaderboard.label", description: "nav.tab.leaderboard.description", icon: "leaderboard", Component: LeaderboardView },
  tournaments: { label: "nav.tab.tournaments.label", description: "nav.tab.tournaments.description", icon: "trophy", Component: TournamentsView },
  training: { label: "nav.tab.training.label", description: "nav.tab.training.description", icon: "book", Component: TrainingView },
  units: { label: "nav.tab.units.label", description: "nav.tab.units.description", icon: "units", Component: UnitsView },
  changelog: { label: "nav.tab.changelog.label", description: "nav.tab.changelog.description", icon: "changelog", Component: ChangelogView },
  settings: { label: "nav.tab.settings.label", description: "nav.tab.settings.description", icon: "settings", Component: SettingsView },
};
