import { useState } from "react";
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
import "./settings.css";

type SectionKey = "general" | "account" | "appearance" | "notifications" | "chat" | "discord" | "connectivity" | "diagnostics" | "updates" | "game";
type SettingsCategory = "all" | "general" | "chat" | "notifications" | "account" | "connectivity" | "game" | "maintenance";

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
  { id: "all", label: "All settings" },
  { id: "general", label: "General" },
  { id: "chat", label: "Chat" },
  { id: "notifications", label: "Notifications" },
  { id: "account", label: "Account & social" },
  { id: "connectivity", label: "Connectivity" },
  { id: "game", label: "Game & replays" },
  { id: "maintenance", label: "Updates & diagnostics" },
] as const;

const SECTION_KEYS: readonly SectionKey[] = CATEGORY_SECTIONS.all;

export function SettingsView() {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const query = search.trim().toLocaleLowerCase();
  const matches = (title: string, description: string, keywords: string) =>
    !query || `${title} ${description} ${keywords}`.toLocaleLowerCase().includes(query);

  const visible = {
    general: matches("General", "Choose where the client opens.", "start page startup destination news chat play replays maps mods leaderboard tournaments tutorials"),
    account: matches("Account & support", "Open official FAF account-management and help resources.", "account logout sign out session username password steam support help community rules browser website"),
    appearance: matches("Appearance", "Tune the workspace without changing its information architecture.", "theme color density compact comfortable reduce motion animation transition"),
    notifications: matches("Notifications", "Choose which events can interrupt you and how the client presents them.", "desktop sounds volume match found private messages mentions friends online offline playing custom games full launched reminder party invitations"),
    chat: matches("Chat", "Control conversation readability, filtering, and channel startup behavior.", "timestamps 24-hour time color names joins parts foe muted players history auto-join channels name colors"),
    discord: matches("Discord", "Control what the client publishes to your Discord status.", "rich presence disallow joins status lobby player count"),
    connectivity: matches("Connectivity", "Choose how the client connects you to other players.", "adapter java go network connection players ice"),
    diagnostics: matches("Diagnostics", "Inspect logs when a game, replay, or client service fails.", "game logs client logs tutorial replay live replay folder diagnostics"),
    updates: matches("Updates", "Control whether the client looks for newer builds of itself.", "check updates startup pre-releases beta release status newer build"),
    game: matches("Game & replays", "Configure executables and advanced launch behavior.", "game replay install path executable forged alliance launch arguments process"),
  };
  const sectionVisible = (section: SectionKey) =>
    visible[section] && CATEGORY_SECTIONS[activeCategory].includes(section);
  const visibleCount = SECTION_KEYS.filter(sectionVisible).length;
  const updateSearch = (value: string) => {
    setSearch(value);
    setActiveCategory(value.trim() ? "all" : "general");
  };

  return (
    <div className="settings-view">
      <div className="settings-heading">
        <div>
          <h2 className="view-title">Settings</h2>
          <p className="settings-intro muted">Client preferences are saved automatically and synchronized through the backend.</p>
        </div>
        <label className="settings-search-field">
          <Icon name="search" size={15} />
          <input
            value={search}
            onChange={(event) => updateSearch(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
          />
          {search && (
            <button type="button" aria-label="Clear settings search" title="Clear search" onClick={() => updateSearch("")}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
      </div>

      <SectionTabs
        active={activeCategory}
        ariaLabel="Settings categories"
        className="settings-category-tabs"
        items={CATEGORY_TABS}
        onChange={setActiveCategory}
      />

      {sectionVisible("general") && <SettingsSection id="settings-general" title="General" description="Choose where the client opens."><GeneralSettingsSection /></SettingsSection>}
      {sectionVisible("account") && <SettingsSection id="settings-account" title="Account & support" description="Open official FAF account-management and help resources."><AccountSupportSettingsSection /></SettingsSection>}
      {sectionVisible("appearance") && <SettingsSection id="settings-appearance" title="Appearance" description="Tune the workspace without changing its information architecture."><AppearanceSettingsSection /></SettingsSection>}
      {sectionVisible("notifications") && <SettingsSection id="settings-notifications" title="Notifications" description="Choose which events can interrupt you and how the client presents them."><NotificationsSettingsSection /></SettingsSection>}
      {sectionVisible("chat") && <SettingsSection id="settings-chat" title="Chat" description="Control conversation readability, filtering, and channel startup behavior."><ChatSettingsSection /></SettingsSection>}
      {sectionVisible("discord") && <SettingsSection id="settings-discord" title="Discord" description="Control what the client publishes to your Discord status."><DiscordSettingsSection /></SettingsSection>}
      {sectionVisible("connectivity") && <SettingsSection id="settings-connectivity" title="Connectivity" description="Choose how the client connects you to other players."><ConnectivitySettingsSection /></SettingsSection>}
      {sectionVisible("diagnostics") && <SettingsSection id="settings-diagnostics" title="Diagnostics" description="Inspect logs when a game, replay, or client service fails."><DiagnosticsSettingsSection /></SettingsSection>}
      {sectionVisible("updates") && <SettingsSection id="settings-updates" title="Updates" description="Control whether the client looks for newer builds of itself."><UpdatesSettingsSection /></SettingsSection>}
      {sectionVisible("game") && <SettingsSection id="settings-game" title="Game & replays" description="Configure executables and advanced launch behavior."><GameSettingsSection /></SettingsSection>}
      {query && visibleCount === 0 && <p className="settings-search-empty surface muted">No settings match “{search.trim()}”.</p>}
    </div>
  );
}
