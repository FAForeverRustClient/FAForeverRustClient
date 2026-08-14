import { useState } from "react";
import type { ComponentType } from "react";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { AccountSupportSettingsSection } from "./AccountSupportSettingsSection";
import { ChatSettingsSection } from "./ChatSettingsSection";
import { ConnectivitySettingsSection } from "./ConnectivitySettingsSection";
import { DiscordSettingsSection } from "./DiscordSettingsSection";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { GameSettingsSection } from "./GameSettingsSection";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { SettingsSection } from "./SettingControls";
import { UpdatesSettingsSection } from "./UpdatesSettingsSection";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import "./settings.css";

type SectionKey = "general" | "account" | "appearance" | "notifications" | "chat" | "discord" | "connectivity" | "diagnostics" | "updates" | "game";
type SettingsCategory = "all" | "general" | "chat" | "notifications" | "account" | "connectivity" | "game" | "maintenance";

interface SectionDef {
  title: MessageKey;
  description: MessageKey;
  /**
   * Search terms that are not in the visible copy, so "volume" finds the
   * notification sound slider. Translated like everything else: someone
   * searching "Lautstaerke" in a German client has to find it too.
   */
  keywords: MessageKey;
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
    Component: GeneralSettingsSection,
  },
  account: {
    title: "settings.section.account.title",
    description: "settings.section.account.description",
    keywords: "settings.section.account.keywords",
    Component: AccountSupportSettingsSection,
  },
  appearance: {
    title: "settings.section.appearance.title",
    description: "settings.section.appearance.description",
    keywords: "settings.section.appearance.keywords",
    Component: AppearanceSettingsSection,
  },
  notifications: {
    title: "settings.section.notifications.title",
    description: "settings.section.notifications.description",
    keywords: "settings.section.notifications.keywords",
    Component: NotificationsSettingsSection,
  },
  chat: {
    title: "settings.section.chat.title",
    description: "settings.section.chat.description",
    keywords: "settings.section.chat.keywords",
    Component: ChatSettingsSection,
  },
  discord: {
    title: "settings.section.discord.title",
    description: "settings.section.discord.description",
    keywords: "settings.section.discord.keywords",
    Component: DiscordSettingsSection,
  },
  connectivity: {
    title: "settings.section.connectivity.title",
    description: "settings.section.connectivity.description",
    keywords: "settings.section.connectivity.keywords",
    Component: ConnectivitySettingsSection,
  },
  diagnostics: {
    title: "settings.section.diagnostics.title",
    description: "settings.section.diagnostics.description",
    keywords: "settings.section.diagnostics.keywords",
    Component: DiagnosticsSettingsSection,
  },
  updates: {
    title: "settings.section.updates.title",
    description: "settings.section.updates.description",
    keywords: "settings.section.updates.keywords",
    Component: UpdatesSettingsSection,
  },
  game: {
    title: "settings.section.game.title",
    description: "settings.section.game.description",
    keywords: "settings.section.game.keywords",
    Component: GameSettingsSection,
  },
} as const satisfies Record<SectionKey, SectionDef>;

const CATEGORY_SECTIONS: Record<SettingsCategory, readonly SectionKey[]> = {
  all: ["general", "account", "appearance", "notifications", "chat", "discord", "connectivity", "diagnostics", "updates", "game"],
  general: ["general", "appearance"],
  chat: ["chat"],
  notifications: ["notifications"],
  account: ["account", "discord"],
  connectivity: ["connectivity"],
  game: ["game"],
  maintenance: ["updates", "diagnostics"],
};

const CATEGORY_TABS = [
  { id: "all", label: "settings.category.all" },
  { id: "general", label: "settings.category.general" },
  { id: "chat", label: "settings.category.chat" },
  { id: "notifications", label: "settings.category.notifications" },
  { id: "account", label: "settings.category.account" },
  { id: "connectivity", label: "settings.category.connectivity" },
  { id: "game", label: "settings.category.game" },
  { id: "maintenance", label: "settings.category.maintenance" },
] as const satisfies readonly { id: SettingsCategory; label: MessageKey }[];

const SECTION_KEYS: readonly SectionKey[] = CATEGORY_SECTIONS.all;

export function SettingsView() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const query = search.trim().toLocaleLowerCase();

  const sectionVisible = (section: SectionKey) => {
    if (!CATEGORY_SECTIONS[activeCategory].includes(section)) return false;
    if (!query) return true;
    const definition = SECTIONS[section];
    const haystack = `${t(definition.title)} ${t(definition.description)} ${t(definition.keywords)}`;
    return haystack.toLocaleLowerCase().includes(query);
  };

  const visibleSections = SECTION_KEYS.filter(sectionVisible);
  const updateSearch = (value: string) => {
    setSearch(value);
    setActiveCategory(value.trim() ? "all" : "general");
  };

  return (
    <div className="settings-view">
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
        onChange={setActiveCategory}
      />

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
  );
}
