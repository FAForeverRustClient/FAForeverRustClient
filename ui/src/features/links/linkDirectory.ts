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
// The hub itself is not one of the entries. Every destination it lists is in
// here, so linking to it would be linking to a longer way round to this page.
// The two it lists that are missing are deliberate: FAF's unit database is a
// tab of this client already, and the wiki's beginner guide is a page of the
// wiki, which is the second entry below.
//
// Every entry says whether FAF runs it or somebody else does, and that is all
// it says. The hints used to end in "by Vindex", "by Sheppy", "by Nuggets":
// naming the person who runs a site reads as an endorsement of that person,
// and it is not what the reader of this page needs. What they need before
// clicking is whether they are leaving FAF, so the chip says exactly that and
// nothing more. The people are thanked at the bottom of the page instead.

import type { LiveStream } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";

/**
 * Who runs a destination. Drawn as a chip on every card.
 *
 * `community` is deliberately not "a name we know": see the note above. The
 * variant keeps its name because it is what the section it feeds is about, but
 * the chip it draws reads "External".
 */
export type LinkOrigin = "official" | "community";

/**
 * The groups, in the order they are drawn.
 *
 * Purpose first, origin second: somebody looking for a rating history wants the
 * tools, and whether FAF or a player wrote the tool is the next question, not
 * the first. Splitting the page into "official" and "community" instead would
 * bury the things people come here for under a provenance question.
 */
export type LinkSection = "play" | "tools" | "games" | "watch";

export const LINK_SECTIONS: LinkSection[] = ["play", "tools", "games", "watch"];

export interface DirectoryLink {
  /** Stable id, used as the React key and in tests. */
  id: string;
  name: MessageKey;
  hint: MessageKey;
  href: string;
  origin: LinkOrigin;
  section: LinkSection;
  /**
   * The streaming platform's login for this destination, when it has one.
   *
   * Only here so a card can be marked live. Absent on everything the client
   * cannot be told the broadcast state of, which is every YouTube channel and
   * every entry that is not a stream: see `infra::streams` for why Twitch is the
   * only one, and note that a channel is only ever reported live if the
   * deployment's `FAF_TWITCH_CHANNELS` includes it.
   */
  channel?: string;
}

/**
 * The directory.
 *
 * Sources: the community hub above, plus the DoodlePros sites it does not list
 * (FAFScribbl is missing from it, which the issue points out) and FAF's own
 * wiki. Ordered within a section by how often somebody is likely to want it,
 * which for the first four is the order a new player meets them in.
 */
export const DIRECTORY: readonly DirectoryLink[] = [
  {
    id: "faforever",
    name: "links.entry.website",
    // Deliberately not "news, leaderboards and the vaults", which is what this
    // said first and is wrong on all three counts: the site's news is out of
    // date, and its map and mod pages are not where anybody browses either.
    // What it is good for is being the first address a player who has never run
    // FAF is given.
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
    id: "wiki",
    name: "links.entry.wiki",
    hint: "links.entry.wikiHint",
    href: "https://wiki.faforever.com/",
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
    id: "twitch",
    name: "links.entry.twitch",
    hint: "links.entry.twitchHint",
    href: "https://www.twitch.tv/faflive",
    origin: "official",
    section: "watch",
    channel: "faflive",
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
    channel: "stellartactician",
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
 * heading: filtering to "official" should not leave empty groups behind.
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

/**
 * The live broadcast on a card's channel, if there is one.
 *
 * Twin of `StreamsState::live_channel`: matched on the login rather than the
 * URL, because the URL is how a human wrote it and the login is what the
 * platform answers with.
 */
export function liveStreamFor(
  link: DirectoryLink,
  live: readonly LiveStream[],
): LiveStream | null {
  const channel = link.channel?.trim().toLocaleLowerCase();
  if (!channel) return null;
  return live.find((stream) => stream.channel.trim().toLocaleLowerCase() === channel) ?? null;
}
