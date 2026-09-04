import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { AccountSupportSettingsSection } from "./AccountSupportSettingsSection";
import { ChatSettingsSection } from "./ChatSettingsSection";
import { ConnectivitySettingsSection } from "./ConnectivitySettingsSection";
import { DebugWindowsSettingsSection } from "./DebugWindowsSettingsSection";
import { DiscordSettingsSection } from "./DiscordSettingsSection";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { FoldersSettingsSection } from "./FoldersSettingsSection";
import { GameCacheSettingsSection } from "./GameCacheSettingsSection";
import { GameSettingsSection } from "./GameSettingsSection";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { PathsSettingsSection } from "./PathsSettingsSection";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { SettingsSection } from "./SettingControls";
import { UpdatesSettingsSection } from "./UpdatesSettingsSection";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import "./settings.css";

type SectionKey = "general" | "account" | "appearance" | "notifications" | "chat" | "discord" | "connectivity" | "folders" | "diagnostics" | "debugWindows" | "updates" | "game" | "gameCache" | "paths";
type SettingsCategory = "all" | "general" | "chat" | "notifications" | "account" | "connectivity" | "game" | "paths" | "maintenance";

interface SectionDef {
  title: MessageKey;
  description: MessageKey;
  keywords: MessageKey;
  labels?: readonly MessageKey[];
  Component: ComponentType;
}

/**
 * One declaration per section, read by both the search filter and the render.
 *
 * Title and description used to be written out twice, once for `matches()` and
 * once for the rendered `SettingsSection`. Keying them here means a section is
 * described in exactly one place, and a translation cannot drift between the
 * copy a user reads and the copy the search looks at.
 */
const SECTIONS = {
  general: {
    title: "settings.section.general.title",
    description: "settings.section.general.description",
    keywords: "settings.section.general.keywords",
    labels: [
      "settings.general.startPage.label",
      "settings.general.startPage.hint",
      "settings.general.autoLogin.label",
      "settings.general.autoLogin.hint",
      "settings.general.language.label",
      "settings.general.language.hint",
    ],
    Component: GeneralSettingsSection,
  },
  account: {
    title: "settings.section.account.title",
    description: "settings.section.account.description",
    keywords: "settings.section.account.keywords",
    labels: [
      "settings.account.session",
      "settings.account.sessionHint",
      "settings.account.logOut",
      "settings.account.fafAccount",
      "settings.account.fafAccountHint",
      "settings.account.changeUsername",
      "settings.account.resetPassword",
      "settings.account.linkSteam",
      "settings.account.helpCommunityRules",
      "settings.account.helpCommunityRulesHint",
      "settings.account.support",
      "settings.account.technicalHelp",
      "settings.account.rules",
    ],
    Component: AccountSupportSettingsSection,
  },
  appearance: {
    title: "settings.section.appearance.title",
    description: "settings.section.appearance.description",
    keywords: "settings.section.appearance.keywords",
    labels: [
      "settings.appearance.theme",
      "settings.appearance.themeHint",
      "settings.appearance.interfaceDensity",
      "settings.appearance.interfaceDensityHint",
      "settings.appearance.compact",
      "settings.appearance.comfortable",
      "settings.appearance.interfaceScale",
      "settings.appearance.interfaceScaleHint",
      "settings.appearance.tileColumns",
      "settings.appearance.tileColumnsHint",
      "settings.appearance.tileColumnsAuto",
      "settings.appearance.reduceMotion",
      "settings.appearance.reduceMotionHint",
    ],
    Component: AppearanceSettingsSection,
  },
  notifications: {
    title: "settings.section.notifications.title",
    description: "settings.section.notifications.description",
    keywords: "settings.section.notifications.keywords",
    labels: [
      "settings.notifications.enabled",
      "settings.notifications.enabledHint",
      "settings.notifications.desktop",
      "settings.notifications.desktopHint",
      "settings.notifications.sound",
      "settings.notifications.soundHint",
      "settings.notifications.volume",
      "settings.notifications.volumeHint",
      "settings.notifications.volumeAria",
      "settings.notifications.whenFocused",
      "settings.notifications.whenFocusedHint",
      "settings.notifications.matchFound",
      "settings.notifications.matchFoundHint",
      "settings.notifications.privateMessages",
      "settings.notifications.privateMessagesHint",
      "settings.notifications.mentions",
      "settings.notifications.mentionsHint",
      "settings.notifications.friendOnline",
      "settings.notifications.friendOnlineHint",
      "settings.notifications.friendOffline",
      "settings.notifications.friendOfflineHint",
      "settings.notifications.friendPlaying",
      "settings.notifications.friendPlayingHint",
      "settings.notifications.newGames",
      "settings.notifications.newGamesHint",
      "settings.notifications.friendsGamesOnly",
      "settings.notifications.friendsGamesOnlyHint",
      "settings.notifications.gameFull",
      "settings.notifications.gameFullHint",
      "settings.notifications.gameLaunched",
      "settings.notifications.gameLaunchedHint",
      "settings.notifications.reviewReminder",
      "settings.notifications.reviewReminderHint",
      "settings.notifications.partyInvites",
      "settings.notifications.partyInvitesHint",
    ],
    Component: NotificationsSettingsSection,
  },
  chat: {
    title: "settings.section.chat.title",
    description: "settings.section.chat.description",
    keywords: "settings.section.chat.keywords",
    labels: [
      "settings.chat.messageTimestamps",
      "settings.chat.messageTimestampsHint",
      "settings.chat.24HourTime",
      "settings.chat.24HourTimeHint",
      "settings.chat.colorEveryName",
      "settings.chat.colorEveryNameHint",
      "settings.chat.showJoinsParts",
      "settings.chat.showJoinsPartsHint",
      "settings.chat.hideFoeMessages",
      "settings.chat.hideFoeMessagesHint",
      "settings.chat.joinMyLanguage",
      "settings.chat.joinMyLanguageHint",
      "settings.chat.autoJoinNewbie",
      "settings.chat.autoJoinNewbieHint",
      "settings.chat.visibleHistory",
      "settings.chat.visibleHistoryHint",
      "settings.chat.mutedLabel",
      "settings.chat.mutedHint",
      "settings.chat.autoJoinLabel",
      "settings.chat.autoJoinHint",
    ],
    Component: ChatSettingsSection,
  },
  discord: {
    title: "settings.section.discord.title",
    description: "settings.section.discord.description",
    keywords: "settings.section.discord.keywords",
    labels: [
      "settings.discord.richPresence",
      "settings.discord.richPresenceHint",
      "settings.discord.disallowJoinsVia",
      "settings.discord.disallowJoinsViaHint",
    ],
    Component: DiscordSettingsSection,
  },
  connectivity: {
    title: "settings.section.connectivity.title",
    description: "settings.section.connectivity.description",
    keywords: "settings.section.connectivity.keywords",
    labels: [
      "settings.connectivity.connectivityAdapter",
      "settings.connectivity.connectivityAdapterHint",
      "settings.connectivity.java",
      "settings.connectivity.go",
    ],
    Component: ConnectivitySettingsSection,
  },
  folders: {
    title: "settings.section.folders.title",
    description: "settings.section.folders.description",
    keywords: "settings.section.folders.keywords",
    labels: [
      "settings.folders.label",
      "settings.folders.hint",
      "settings.folders.maps",
      "settings.folders.mods",
      "settings.folders.replays",
      "settings.folders.vault",
      "settings.folders.gamePrefs",
    ],
    Component: FoldersSettingsSection,
  },
  diagnostics: {
    title: "settings.section.diagnostics.title",
    description: "settings.section.diagnostics.description",
    keywords: "settings.section.diagnostics.keywords",
    labels: [
      "settings.diagnostics.gameLogs",
      "settings.diagnostics.gameLogsHint",
      "settings.diagnostics.viewLatest",
      "settings.diagnostics.openFolder",
      "settings.diagnostics.clientLogs",
      "settings.diagnostics.clientLogsHint",
    ],
    Component: DiagnosticsSettingsSection,
  },
  debugWindows: {
    title: "settings.section.debugWindows.title",
    description: "settings.section.debugWindows.description",
    keywords: "settings.section.debugWindows.keywords",
    labels: [
      "settings.debug.iceAdapterDebugWindow",
      "settings.debug.iceAdapterDebugWindowHint",
      "settings.debug.iceAdapterInfoWindow",
      "settings.debug.iceAdapterInfoWindowHint",
      "settings.debug.iceAdapterConsoleWindow",
      "settings.debug.iceAdapterConsoleWindowHint",
      "settings.debug.mapGeneratorWindow",
      "settings.debug.mapGeneratorWindowHint",
    ],
    Component: DebugWindowsSettingsSection,
  },
  updates: {
    title: "settings.section.updates.title",
    description: "settings.section.updates.description",
    keywords: "settings.section.updates.keywords",
    labels: [
      "settings.updates.checkUpdatesAt",
      "settings.updates.checkUpdatesAtHint",
      "settings.updates.includePreReleases",
      "settings.updates.includePreReleasesHint",
      "settings.updates.updateStatus",
      "settings.updates.updateStatusHint",
      "settings.updates.checkNow",
    ],
    Component: UpdatesSettingsSection,
  },
  game: {
    title: "settings.section.game.title",
    description: "settings.section.game.description",
    keywords: "settings.section.game.keywords",
    labels: [
      "settings.game.autoGenerateMaps",
      "settings.game.autoGenerateMapsHint",
      "settings.game.argumentsLabel",
      "settings.game.argumentsHint",
    ],
    Component: GameSettingsSection,
  },
  paths: {
    title: "settings.section.paths.title",
    description: "settings.section.paths.description",
    keywords: "settings.section.paths.keywords",
    labels: [
      "settings.paths.gameInstall",
      "settings.paths.gameInstallHint",
      "settings.paths.replayInstall",
      "settings.paths.replayInstallHint",
      "settings.paths.vault",
      "settings.paths.vaultHint",
      "settings.paths.maps",
      "settings.paths.mapsHint",
      "settings.paths.mods",
      "settings.paths.modsHint",
      "settings.paths.replays",
      "settings.paths.replaysHint",
      "settings.paths.mapGenerator",
      "settings.paths.mapGeneratorHint",
      "settings.paths.gamePrefs",
      "settings.paths.gamePrefsHint",
      "settings.paths.java",
      "settings.paths.javaHint",
    ],
    Component: PathsSettingsSection,
  },
  gameCache: {
    title: "settings.section.gameCache.title",
    description: "settings.section.gameCache.description",
    keywords: "settings.section.gameCache.keywords",
    labels: [
      "settings.game.cacheLifetime",
      "settings.game.cacheLifetimeHint",
      "settings.game.cacheRollingBranches",
      "settings.game.cacheRollingBranchesHint",
      "settings.game.cacheRollingBranchesDocTitle",
      "settings.game.experimentalBadge",
      "settings.game.cacheStorage",
      "settings.game.cacheStorageHint",
      "settings.game.cachedVersions",
      "settings.game.clearCache",
      "settings.game.refreshCache",
    ],
    Component: GameCacheSettingsSection,
  },
} as const satisfies Record<SectionKey, SectionDef>;

const CATEGORY_SECTIONS: Record<SettingsCategory, readonly SectionKey[]> = {
  all: ["general", "appearance", "chat", "notifications", "account", "discord", "connectivity", "game", "gameCache", "paths", "folders", "diagnostics", "debugWindows", "updates"],
  general: ["general", "appearance"],
  chat: ["chat"],
  notifications: ["notifications"],
  account: ["account", "discord"],
  connectivity: ["connectivity"],
  game: ["game", "gameCache"],
  paths: ["paths"],
  maintenance: ["folders", "gameCache", "updates", "diagnostics", "debugWindows"],
};

const CATEGORY_TABS = [
  { id: "all", label: "settings.category.all" },
  { id: "general", label: "settings.category.general" },
  { id: "chat", label: "settings.category.chat" },
  { id: "notifications", label: "settings.category.notifications" },
  { id: "account", label: "settings.category.account" },
  { id: "connectivity", label: "settings.category.connectivity" },
  { id: "game", label: "settings.category.game" },
  { id: "paths", label: "settings.category.paths" },
  { id: "maintenance", label: "settings.category.maintenance" },
] as const satisfies readonly { id: SettingsCategory; label: MessageKey }[];

const SECTION_KEYS: readonly SectionKey[] = CATEGORY_SECTIONS.all;

export function SettingsView() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("all");
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScroll = useRef(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const query = search.trim().toLocaleLowerCase();

  const sectionMatchesSearch = (section: SectionKey) => {
    if (!query) return true;
    const definition = SECTIONS[section];
    const labels = definition.labels ? definition.labels.map((key) => t(key)).join(" ") : "";
    const haystack = `${t(definition.title)} ${t(definition.description)} ${t(definition.keywords)} ${labels}`;
    const normalizedHaystack = haystack.toLocaleLowerCase();
    const normalizedQuery = query.toLocaleLowerCase();
    if (normalizedHaystack.includes(normalizedQuery)) return true;
    const simplifiedHaystack = normalizedHaystack.replace(/[-_]/g, " ");
    const simplifiedQuery = normalizedQuery.replace(/[-_]/g, " ");
    return simplifiedHaystack.includes(simplifiedQuery);
  };

  const visibleSections = SECTION_KEYS.filter(sectionMatchesSearch);

  const updateSearch = (value: string) => {
    setSearch(value);
    setActiveCategory("all");
  };

  const scrollToCategory = (category: SettingsCategory) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    isProgrammaticScroll.current = true;
    setActiveCategory(category);

    if (category === "all") {
      container.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      const firstSectionKey = CATEGORY_SECTIONS[category][0];
      const el = document.getElementById(`settings-${firstSectionKey}`);
      if (el) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const targetScrollTop = container.scrollTop + (elRect.top - containerRect.top) - 4;
        container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: "smooth" });
      }
    }

    if (scrollTimeoutRef.current) {
      window.clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScroll.current = false;
    }, 600);
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      const scrolled = container.scrollTop > 2;
      setIsScrolled((prev) => (prev !== scrolled ? scrolled : prev));

      if (isProgrammaticScroll.current) return;
      if (search.trim()) return;

      if (container.scrollTop < 30) {
        setActiveCategory("all");
        return;
      }

      const isBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
      if (isBottom) {
        setActiveCategory("maintenance");
        return;
      }

      const containerRect = container.getBoundingClientRect();
      let current: SettingsCategory = "all";
      for (const tab of CATEGORY_TABS) {
        if (tab.id === "all") continue;
        const firstSectionKey = CATEGORY_SECTIONS[tab.id][0];
        const el = document.getElementById(`settings-${firstSectionKey}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= containerRect.top + 32) {
            current = tab.id;
          }
        }
      }

      setActiveCategory(current);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (scrollTimeoutRef.current) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [search]);

  return (
    <div className="settings-view">
      <div className="settings-header-container">
        <div className="settings-heading">
          <div>
            <h2 className="view-title">{t("settings.title")}</h2>
            <p className="settings-intro muted">{t("settings.intro")}</p>
          </div>
          <label className="settings-search-field">
            <Icon name="search" size={15} />
            <input
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              placeholder={t("settings.search.placeholder")}
              aria-label={t("settings.search.placeholder")}
            />
            {search && (
              <button
                type="button"
                aria-label={t("settings.search.clearAria")}
                title={t("settings.search.clearTitle")}
                onClick={() => updateSearch("")}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
        </div>

        <SectionTabs
          active={activeCategory}
          ariaLabel={t("settings.categories.aria")}
          className="settings-category-tabs"
          items={CATEGORY_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }))}
          onChange={scrollToCategory}
        />
        <div className={`settings-header-scrim${isScrolled ? " is-visible" : ""}`} />
      </div>

      <div className="settings-content" ref={scrollContainerRef}>
        {visibleSections.map((section) => {
          const definition = SECTIONS[section];
          const Section = definition.Component;
          return (
            <SettingsSection
              key={section}
              id={`settings-${section}`}
              title={t(definition.title)}
              description={t(definition.description)}
            >
              <Section />
            </SettingsSection>
          );
        })}

        {query && visibleSections.length === 0 && (
          <p className="settings-search-empty surface muted">
            {t("settings.search.empty", { query: search.trim() })}
          </p>
        )}
      </div>
    </div>
  );
}
