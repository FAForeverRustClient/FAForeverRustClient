// The link directory tab.
//
// Was the Contribution tab, which listed seven GitHub repositories and the
// people who helped. Those are still here, at the bottom, under a heading of
// their own: what changed is that the tab is now about everywhere a player
// might want to go, because that is the thing worth a permanent place in the
// sidebar and a repository list is not.

import { useState } from "react";
import { Icon } from "../../design-system/Icon";
import { openHttpsUrl } from "../../shared/externalLinks";
import {
  countByOrigin,
  DIRECTORY,
  LINK_SECTIONS,
  sectionLinks,
  type DirectoryLink,
  type LinkOrigin,
  type OriginFilter,
} from "./linkDirectory";
import "./links.css";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";

const REPOSITORIES = [
  {
    name: "contribution.repo.game",
    description: "contribution.repo.gameHint",
    href: "https://github.com/FAForever/fa",
  },
  {
    name: "contribution.repo.patches",
    description: "contribution.repo.patchesHint",
    href: "https://github.com/FAForever/FA-Binary-Patches",
  },
  {
    name: "contribution.repo.rust",
    description: "contribution.repo.rustHint",
    href: "https://github.com/FAForeverRustClient/FAForever-Rust-Client",
  },
  {
    name: "contribution.repo.java",
    description: "contribution.repo.javaHint",
    href: "https://github.com/FAForever/downlords-faf-client",
  },
  {
    name: "contribution.repo.python",
    description: "contribution.repo.pythonHint",
    href: "https://github.com/FAForever/client",
  },
  {
    name: "contribution.repo.server",
    description: "contribution.repo.serverHint",
    href: "https://github.com/FAForever/server",
  },
  {
    name: "contribution.repo.github",
    description: "contribution.repo.githubHint",
    href: "https://github.com/FAForever",
  },
] as const satisfies readonly { name: MessageKey; description: MessageKey; href: string }[];

const ACKNOWLEDGMENTS = [
  { name: "Seraphim-Noob", note: null },
  { name: "Nory", note: null },
  { name: "Nuggets", note: "feedback" },
  { name: "Vindex", note: "feedback" },
  { name: "Sheppy", note: "community hub" },
] as const;

/** One row of the directory. The chip is the whole point of the page. */
function LinkCard({
  link,
  originLabel,
  originTitle,
}: {
  link: DirectoryLink;
  originLabel: string;
  originTitle: string;
}) {
  const { t } = useTranslation();
  return (
    <a
      className={`links-link links-link-${link.origin} surface surface-interactive`}
      href={link.href}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        event.preventDefault();
        void openHttpsUrl(link.href);
      }}
    >
      <span className="links-link-copy">
        <strong>{t(link.name)}</strong>
        <small>{t(link.hint)}</small>
      </span>
      <span className={`links-origin links-origin-${link.origin}`} title={originTitle}>
        {originLabel}
      </span>
      <Icon name="external" size={16} />
    </a>
  );
}

export function LinksView() {
  const { t } = useTranslation();
  // Not in the nav slice: which chip is pressed is as ephemeral as a hover, and
  // nothing in the backend has an opinion about it.
  const [filter, setFilter] = useState<OriginFilter>(null);

  const originLabel = (origin: LinkOrigin) => t(`links.origin.${origin}`);
  const originTitle = (origin: LinkOrigin) =>
    origin === "official" ? t("links.origin.officialTitle") : t("links.origin.communityTitle");
  // The chip carries the origin it filters to, so the pressed state can be that
  // origin's colour rather than the one accent every pressed control shares.
  const chip = (value: OriginFilter, label: string) => (
    <button
      type="button"
      key={label}
      className={
        filter === value
          ? `links-filter-chip links-filter-${value ?? "all"} is-on`
          : `links-filter-chip links-filter-${value ?? "all"}`
      }
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      {label}
    </button>
  );

  return (
    <div className="links-view">
      <section className="links-intro">
        <div className="links-icon surface" aria-hidden="true">
          <Icon name="external" size={24} />
        </div>
        <div className="links-intro-copy">
          <h2 className="view-title">{t("links.title")}</h2>
          <p>{t("links.subtitle")}</p>
        </div>
      </section>

      <div className="links-filters" role="group" aria-label={t("links.filter.aria")}>
        {chip(null, t("links.filter.all", { count: DIRECTORY.length }))}
        {chip("official", t("links.filter.official", { count: countByOrigin("official") }))}
        {chip("community", t("links.filter.community", { count: countByOrigin("community") }))}
      </div>

      {LINK_SECTIONS.map((section) => {
        const links = sectionLinks(section, filter);
        if (links.length === 0) return null;
        return (
          <section className="links-section" key={section} aria-labelledby={`links-section-${section}`}>
            <h3 id={`links-section-${section}`} className="links-section-title">
              {t(`links.section.${section}`)}
            </h3>
            <div className="links-list">
              {links.map((link) => (
                <LinkCard
                  key={link.id}
                  link={link}
                  originLabel={originLabel(link.origin)}
                  originTitle={originTitle(link.origin)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Below the directory, and never filtered: the repositories are not
          places to visit, they are the answer to "how do I help". */}
      <section className="links-section" aria-labelledby="links-repositories">
        <h3 id="links-repositories" className="links-section-title">{t("contribution.repositories")}</h3>
        <p className="links-section-hint">{t("contribution.subtitle")}</p>
        <div className="links-list">
          {REPOSITORIES.map((repository) => (
            <a
              className="links-link surface surface-interactive"
              href={repository.href}
              key={repository.href}
              rel="noreferrer"
              target="_blank"
              onClick={(event) => {
                event.preventDefault();
                void openHttpsUrl(repository.href);
              }}
            >
              <span className="links-link-copy">
                <strong>{t(repository.name)}</strong>
                <small>{t(repository.description)}</small>
              </span>
              <Icon name="github" size={16} />
            </a>
          ))}
        </div>
      </section>

      <section className="links-section" aria-labelledby="links-thanks">
        <h3 id="links-thanks" className="links-section-title">{t("contribution.specialThanks")}</h3>
        <ul className="links-thanks-list">
          {ACKNOWLEDGMENTS.map((person) => (
            <li key={person.name} className="links-thanks-item">
              <span className="links-thanks-name">{person.name}</span>
              {person.note && <span className="links-thanks-note"> ({person.note})</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
