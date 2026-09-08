// The link directory: every FAF site worth knowing about, in one list.
//
// Held here as data rather than fetched, and that is the decision worth
// explaining. Sheppy's community hub (`faf-hub.services.atlantishq.de`) is the
// same list on a web page, and integrating *it* was the first idea on the
// issue. It was dropped for the reason Nuggets gave there: this is a page of
// links, so pulling it over the network would mean the client fetching a
// document whose entire content is addresses it is then willing to open. A
// hardcoded list is a smaller attack surface, works offline, and is a one-line
// pull request when somebody launches something new.
//
// Every entry says who made it. That is the one thing the issue asked for
// explicitly: a player following a link out of the client should know whether
// they are going somewhere FAF runs or somewhere a player runs.

import type { MessageKey } from "../../i18n";

/** Who stands behind a destination. Drawn as a chip on every card. */
export type LinkOrigin = "official" | "community";

/**
 * The groups, in the order they are drawn.
 *
 * Purpose first, origin second: somebody looking for a rating history wants the
 * tools, and whether FAF or a player wrote the tool is the next question, not
 * the first. Splitting the page into "official" and "community" instead would
 * bury the four things people come here for under a provenance question.
 */
export type LinkSection = "play" | "tools" | "games" | "learn" | "watch";

export const LINK_SECTIONS: LinkSection[] = ["play", "tools", "games", "learn", "watch"];

export interface DirectoryLink {
  /** Stable id, used as the React key and in tests. */
  id: string;
  name: MessageKey;
  hint: MessageKey;
  href: string;
  origin: LinkOrigin;
  section: LinkSection;
}

/**
 * The directory.
 *
 * Sources: the community hub above, plus the DoodlePros sites it does not list
 * (FAFScribbl is missing from it, which the issue points out) and FAF's own
 * wiki. Ordered within a section by how often somebody is likely to want it.
 */
export const DIRECTORY: readonly DirectoryLink[] = [
  {
    id: "faforever",
    name: "links.entry.website",
    hint: "links.entry.websiteHint",
    href: "https://www.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    id: "forum",
    name: "links.entry.forum",
    hint: "links.entry.forumHint",
    href: "https://forum.faforever.com/",
    origin: "official",
    section: "play",
  },
  {
    id: "discord",
    name: "links.entry.discord",
    hint: "links.entry.discordHint",
    href: "https://discord.gg/fQxrjwru6E",
    origin: "official",
    section: "play",
  },
  {
    id: "steam",
    name: "links.entry.steam",
    hint: "links.entry.steamHint",
    href: "https://store.steampowered.com/app/9420/Supreme_Commander_Forged_Alliance/",
    origin: "official",
    section: "play",
  },
  {
    id: "gog",
    name: "links.entry.gog",
    hint: "links.entry.gogHint",
    href: "https://www.gog.com/en/game/supreme_commander_gold_edition",
    origin: "official",
    section: "play",
  },
  {
    id: "tracker",
    name: "links.entry.tracker",
    hint: "links.entry.trackerHint",
    href: "https://faftracker.xyz/",
    origin: "community",
    section: "tools",
  },
  {
    id: "companion",
    name: "links.entry.companion",
    hint: "links.entry.companionHint",
    href: "https://fa-companion.services.atlantishq.de/",
    origin: "community",
    section: "tools",
  },
  {
    id: "mapgen",
    name: "links.entry.mapgen",
    hint: "links.entry.mapgenHint",
    href: "https://mapgen.services.atlantishq.de/",
    origin: "community",
    section: "tools",
  },
  {
    id: "tierlists",
    name: "links.entry.tierlists",
    hint: "links.entry.tierlistsHint",
    href: "https://fa-companion.services.atlantishq.de/tierlist-overview",
    origin: "community",
    section: "tools",
  },
  {
    id: "tournaments",
    name: "links.entry.tournaments",
    hint: "links.entry.tournamentsHint",
    href: "https://tournaments.doodlepros.com/",
    origin: "community",
    section: "tools",
  },
  {
    id: "hub",
    name: "links.entry.hub",
    hint: "links.entry.hubHint",
    href: "https://faf-hub.services.atlantishq.de/",
    origin: "community",
    section: "tools",
  },
  {
    id: "guessr",
    name: "links.entry.guessr",
    hint: "links.entry.guessrHint",
    href: "https://fafguessr.doodlepros.com/",
    origin: "community",
    section: "games",
  },
  {
    id: "scribbl",
    name: "links.entry.scribbl",
    hint: "links.entry.scribblHint",
    href: "https://fafscribbl.doodlepros.com/",
    origin: "community",
    section: "games",
  },
  {
    id: "daily",
    name: "links.entry.daily",
    hint: "links.entry.dailyHint",
    href: "https://daily.doodlepros.com/",
    origin: "community",
    section: "games",
  },
  {
    id: "wiki",
    name: "links.entry.wiki",
    hint: "links.entry.wikiHint",
    href: "https://wiki.faforever.com/",
    origin: "official",
    section: "learn",
  },
  {
    id: "beginners",
    name: "links.entry.beginners",
    hint: "links.entry.beginnersHint",
    href: "https://wiki.faforever.com/Play/Learning-SupCom/Beginners-Guide-to-Forged-Alliance",
    origin: "official",
    section: "learn",
  },
  {
    id: "unitdb",
    name: "links.entry.unitDb",
    hint: "links.entry.unitDbHint",
    href: "https://faforever.github.io/etfreeman-db/",
    origin: "official",
    section: "learn",
  },
  {
    id: "twitch",
    name: "links.entry.twitch",
    hint: "links.entry.twitchHint",
    href: "https://www.twitch.tv/faflive",
    origin: "official",
    section: "watch",
  },
  {
    id: "youtube",
    name: "links.entry.youtube",
    hint: "links.entry.youtubeHint",
    href: "https://www.youtube.com/c/ForgedAllianceForever",
    origin: "official",
    section: "watch",
  },
  {
    id: "stellar",
    name: "links.entry.stellar",
    hint: "links.entry.stellarHint",
    href: "https://www.twitch.tv/stellartactician",
    origin: "community",
    section: "watch",
  },
  {
    id: "memecommander",
    name: "links.entry.memeCommander",
    hint: "links.entry.memeCommanderHint",
    href: "https://www.youtube.com/@TheMemeCommander",
    origin: "community",
    section: "watch",
  },
];

/** What the origin filter is set to. `null` is "show everything". */
export type OriginFilter = LinkOrigin | null;

/**
 * The entries of one section under the current filter, in directory order.
 *
 * A section with nothing left in it returns empty and the view draws no
 * heading: filtering to "official" should not leave four empty groups behind.
 */
export function sectionLinks(section: LinkSection, filter: OriginFilter): DirectoryLink[] {
  return DIRECTORY.filter(
    (link) => link.section === section && (filter === null || link.origin === filter),
  );
}

/** How many entries the filter would show, for the count on the filter chip. */
export function countByOrigin(origin: LinkOrigin): number {
  return DIRECTORY.filter((link) => link.origin === origin).length;
}
