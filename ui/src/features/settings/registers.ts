// The settings sidebar, declared once.
//
// One entry per register, in sidebar order. A register is a *kind* of setting,
// not a feature of the client: a path is filed under Paths whichever feature
// put it there, disk under Cache, anything that decides how something is drawn
// under Appearance, a log or a debug window under Diagnostics. A feature earns
// a register of its own only when it is a subsystem with settings that are not
// any other kind (chat, notifications, connectivity, the account, launching the
// game). That rule is the whole point of the rewrite: the previous tab was one
// scroll of fourteen sections because there was no rule, so every new setting
// landed in whichever section the person adding it happened to have open.
//
// Deliberately no `labels` array here. The old `SECTIONS` table carried one,
// hand-maintained beside the components that render, and the two had drifted:
// seven settings were rendered and not indexed, so typing their names hid the
// section holding them. The search reads what the rows actually rendered
// instead (see `settingsSearch`), which cannot drift because there is nothing
// to keep in step.

import type { ComponentType } from "react";

import { AccountSupportSettingsSection } from "./AccountSupportSettingsSection";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { ChatSettingsSection } from "./ChatSettingsSection";
import { ConnectivitySettingsSection } from "./ConnectivitySettingsSection";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { IceDebugWindowsSection, MapGeneratorWindowSection } from "./DebugWindowsSettingsSection";
import { DiscordSettingsSection } from "./DiscordSettingsSection";
import { FoldersSettingsSection } from "./FoldersSettingsSection";
import { GameCacheSettingsSection } from "./GameCacheSettingsSection";
import { GameSettingsSection } from "./GameSettingsSection";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { PathsSettingsSection } from "./PathsSettingsSection";
import { UpdatesSettingsSection } from "./UpdatesSettingsSection";
import type { MessageKey } from "../../i18n";

export type RegisterKey =
  | "client"
  | "appearance"
  | "chat"
  | "notifications"
  | "account"
  | "game"
  | "paths"
  | "cache"
  | "connectivity"
  | "diagnostics";

export interface RegisterDef {
  /** Two digits, as the sidebar and the index print it. */
  readonly no: string;
  readonly title: MessageKey;
  readonly description: MessageKey;
  /** Extra words the search should match, for terms the labels never use. */
  readonly keywords: MessageKey;
  /**
   * The panels that make up the register, in order. Several registers are two
   * existing panels stacked: one register does not imply one component, and
   * splitting them keeps each panel reading the slice of settings it already
   * reads.
   */
  readonly panels: readonly ComponentType[];
}

export const REGISTERS: Record<RegisterKey, RegisterDef> = {
  client: {
    no: "01",
    title: "settings.register.client.title",
    description: "settings.register.client.description",
    keywords: "settings.section.general.keywords",
    panels: [GeneralSettingsSection, UpdatesSettingsSection],
  },
  appearance: {
    no: "02",
    title: "settings.register.appearance.title",
    description: "settings.register.appearance.description",
    keywords: "settings.section.appearance.keywords",
    panels: [AppearanceSettingsSection],
  },
  chat: {
    no: "03",
    title: "settings.register.chat.title",
    description: "settings.register.chat.description",
    keywords: "settings.section.chat.keywords",
    panels: [ChatSettingsSection],
  },
  notifications: {
    no: "04",
    title: "settings.register.notifications.title",
    description: "settings.register.notifications.description",
    keywords: "settings.section.notifications.keywords",
    panels: [NotificationsSettingsSection],
  },
  account: {
    no: "05",
    title: "settings.register.account.title",
    description: "settings.register.account.description",
    keywords: "settings.section.account.keywords",
    panels: [AccountSupportSettingsSection, DiscordSettingsSection],
  },
  game: {
    no: "06",
    title: "settings.register.game.title",
    description: "settings.register.game.description",
    keywords: "settings.section.game.keywords",
    panels: [GameSettingsSection],
  },
  paths: {
    no: "07",
    title: "settings.register.paths.title",
    description: "settings.register.paths.description",
    keywords: "settings.section.paths.keywords",
    panels: [PathsSettingsSection, FoldersSettingsSection],
  },
  cache: {
    no: "08",
    title: "settings.register.cache.title",
    description: "settings.register.cache.description",
    keywords: "settings.section.gameCache.keywords",
    panels: [GameCacheSettingsSection],
  },
  connectivity: {
    no: "09",
    title: "settings.register.connectivity.title",
    description: "settings.register.connectivity.description",
    keywords: "settings.section.connectivity.keywords",
    panels: [ConnectivitySettingsSection, IceDebugWindowsSection],
  },
  diagnostics: {
    no: "10",
    title: "settings.register.diagnostics.title",
    description: "settings.register.diagnostics.description",
    keywords: "settings.section.diagnostics.keywords",
    panels: [DiagnosticsSettingsSection, MapGeneratorWindowSection],
  },
};

export const REGISTER_ORDER: readonly RegisterKey[] = [
  "client",
  "appearance",
  "chat",
  "notifications",
  "account",
  "game",
  "paths",
  "cache",
  "connectivity",
  "diagnostics",
];
