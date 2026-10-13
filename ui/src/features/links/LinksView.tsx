// The link directory tab.
//
// Was the Contribution tab, which listed seven GitHub repositories and the
// people who helped. Those are still here, at the bottom, under a heading of
// their own: what changed is that the tab is now about everywhere a player
// might want to go, because that is the thing worth a permanent place in the
// sidebar and a repository list is not.

import { useEffect, type MouseEvent } from "react";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import {
  displayHost,
  LINK_SECTIONS,
  liveStreamFor,
  sectionLinks,
  type DirectoryLink,
} from "./linkDirectory";
import "./links.css";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";

/** The three groups the repositories are drawn in, in this order. */
type RepositoryGroup = "client" | "faf" | "others";

const REPOSITORY_GROUPS: readonly { id: RepositoryGroup; title: MessageKey }[] = [
  { id: "client", title: "links.repos.client" },
  { id: "faf", title: "links.repos.faf" },
  { id: "others", title: "links.repos.others" },
];

// This client first, since it is what the reader is running; then FAF's own
// projects, opening with the organisation that holds them all; then the
// other clients.
const REPOSITORIES = [
  {
    group: "client",
    name: "contribution.repo.rust",
    description: "contribution.repo.rustHint",
    href: "https://github.com/FAForeverRustClient/FAForeverRustClient",
  },
  {
    group: "faf",
    name: "contribution.repo.github",
    description: "contribution.repo.githubHint",
    href: "https://github.com/FAForever",
  },
  {
    group: "faf",
    name: "contribution.repo.game",
    description: "contribution.repo.gameHint",
    href: "https://github.com/FAForever/fa",
  },
  {
    group: "faf",
    name: "contribution.repo.patches",
    description: "contribution.repo.patchesHint",
    href: "https://github.com/FAForever/FA-Binary-Patches",
  },
  {
    group: "faf",
    name: "contribution.repo.server",
    description: "contribution.repo.serverHint",
    href: "https://github.com/FAForever/server",
  },
  {
    group: "others",
    name: "contribution.repo.java",
    description: "contribution.repo.javaHint",
    href: "https://github.com/FAForever/downlords-faf-client",
  },
  {
    group: "others",
    name: "contribution.repo.python",
    description: "contribution.repo.pythonHint",
    href: "https://github.com/FAForever/client",
  },
] as const satisfies readonly {
  group: RepositoryGroup;
  name: MessageKey;
  description: MessageKey;
  href: string;
}[];

// The names are names and stay as they are written; what each person is being
// thanked *for* is a phrase, so it is a key.
const ACKNOWLEDGMENTS = [
  { name: "Seraphim-Noob", note: null },
  { name: "Nory", note: null },
  { name: "Nuggets", note: "links.thanks.note.feedback" },
  { name: "Vindex", note: "links.thanks.note.feedback" },
  { name: "Sheppy", note: "links.thanks.note.communityHub" },
  { name: "Katsu and the DPG Clan", note: "links.thanks.note.ruLocalization" },
] as const satisfies readonly { name: string; note: MessageKey | null }[];

/** Opens an address in the player's own browser, not in the client's webview. */
function openOutside(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault();
  void openHttpsUrl(href);
}

/** A card's head: its name and how many entries it holds. */
function CardHead({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <header className="links-card-head">
      <h3 id={id} className="links-card-title">
        {title}
        {count !== undefined && <span className="links-count">{count}</span>}
      </h3>
    </header>
  );
}

/** One row of the directory. */
function LinkRow({
  link,
  live,
}: {
  link: DirectoryLink;
  /** The broadcast on this channel right now, when there is one. */
  live?: { title: string; viewers: number | null } | null;
}) {
  const { t } = useTranslation();
  // The host is in the tooltip rather than on the row: a third line under
  // seventeen rows was most of what made the page look busy. Whether a row
  // leaves FAF is still on it, as the Official tag.
  const host = displayHost(link.href);
  return (
    <a
      className={live ? "links-row is-live" : "links-row"}
      href={link.href}
      rel="noreferrer"
      target="_blank"
      title={`${host} (${t(link.origin === "official" ? "links.origin.officialTitle" : "links.origin.communityTitle")})`}
      onClick={(event) => openOutside(event, link.href)}
    >
      <Icon name={link.icon} size={18} />
      <span className="links-row-copy">
        <span className="links-row-name">
          <strong>{t(link.name)}</strong>
          {link.origin === "official" && (
            <span className="links-tag links-tag-official">{t("links.origin.official")}</span>
          )}
        </span>
        <span className="links-row-hint">
          {/* The only place in the client that marks a channel live, and on
              purpose: a badge on the row somebody is already reading is
              promotion, and a strip across the top of the window is an
              interruption. The announcement is a notification. At the start
              of the line it introduces, so the name line stays the shape of
              every other row's. */}
          {live && <span className="links-tag links-tag-live">{t("links.live")}</span>}
          {live
            ? live.viewers === null
              ? live.title || t("links.liveNow")
              : t("links.liveWithViewers", { count: live.viewers, title: live.title || t("links.liveNow") })
            : t(link.hint)}
        </span>
      </span>
    </a>
  );
}

export function LinksView() {
  const { t } = useTranslation();
  const liveStreams = useAppStore((state) => state.state.streams.live);

  // Asked on open rather than waited for: the ticker runs every five minutes,
  // and a badge that appears four minutes after somebody opens the page to look
  // for a stream is a badge nobody saw. A build that cannot answer returns
  // immediately without a request.
  useEffect(() => {
    ipc.send({ kind: "Streams", command: { type: "check" } });
  }, []);

  return (
    <div className="links-view">
      <h2 className="view-title links-title">{t("links.title")}</h2>

      {/* A directory in columns rather than a grid of tiles: a section of
          five in a row of four left one tile on a line of its own, and every
          ragged row made the page look unsorted. Each column is a card of its
          own, and the cards of a row share one height, so a short column
          reads as a short list rather than as a gap. */}
      <div className="links-grid">
        {LINK_SECTIONS.map((section) => {
          const links = sectionLinks(section);
          return (
            <section className="links-card surface" key={section} aria-labelledby={`links-section-${section}`}>
              <CardHead id={`links-section-${section}`} title={t(`links.section.${section}`)} count={links.length} />
              <div className="links-card-body">
                {links.map((link) => (
                  <LinkRow key={link.id} link={link} live={liveStreamFor(link, liveStreams)} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* Below the directory: the repositories are not
          places to visit, they are the answer to "how do I help". One card,
          grouped inside by what they are, this client first; the people who
          helped beside it. */}
      <div className="links-grid links-grid-help">
        <section className="links-card links-repos surface" aria-labelledby="links-repositories">
          <CardHead id="links-repositories" title={t("contribution.repositories")} />
          <div className="links-card-body links-repo-groups">
            {REPOSITORY_GROUPS.map((group) => (
              <div className="links-repo-group" key={group.id}>
                <h4 id={`links-repos-${group.id}`} className="links-group-title">{t(group.title)}</h4>
                <ul className="links-list" aria-labelledby={`links-repos-${group.id}`}>
                  {REPOSITORIES.filter((repository) => repository.group === group.id).map((repository) => (
                    <li key={repository.href}>
                      <a
                        className="links-row"
                        href={repository.href}
                        rel="noreferrer"
                        target="_blank"
                        onClick={(event) => openOutside(event, repository.href)}
                      >
                        <Icon name="github" size={16} />
                        <span className="links-row-copy">
                          <strong>{t(repository.name)}</strong>
                          <span className="links-row-hint">{t(repository.description)}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="links-card surface" aria-labelledby="links-thanks">
          <CardHead id="links-thanks" title={t("contribution.specialThanks")} />
          <ul className="links-card-body links-list">
            {ACKNOWLEDGMENTS.map((person) => (
              <li key={person.name} className="links-row">
                <Icon name="user" size={16} />
                <span className="links-row-copy">
                  <strong>{person.name}</strong>
                  {person.note && <span className="links-row-hint">{t(person.note)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
