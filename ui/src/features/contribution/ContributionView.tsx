import { Icon } from "../../design-system/Icon";
import { openHttpsUrl } from "../../shared/externalLinks";
import "./contribution.css";
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
] as const;

export function ContributionView() {
  const { t } = useTranslation();
  return (
    <div className="contribution-view">
      <section className="contribution-intro">
        <div className="contribution-icon surface" aria-hidden="true">
          <Icon name="github" size={24} />
        </div>
        <div className="contribution-intro-copy">
          <h2 className="view-title">{t("contribution.title")}</h2>
          <p>{t("contribution.subtitle")}</p>
        </div>
      </section>

      <section className="contribution-section" aria-labelledby="contribution-thanks">
        <h3 id="contribution-thanks" className="contribution-section-title">{t("contribution.specialThanks")}</h3>
        <ul className="contribution-thanks-list">
          {ACKNOWLEDGMENTS.map((person) => (
            <li key={person.name} className="contribution-thanks-item">
              <span className="contribution-thanks-name">{person.name}</span>
              {person.note && <span className="contribution-thanks-note"> ({person.note})</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="contribution-section" aria-labelledby="contribution-repositories">
        <h3 id="contribution-repositories" className="contribution-section-title">{t("contribution.repositories")}</h3>
        <div className="contribution-links">
          {REPOSITORIES.map((repository) => (
            <a
              className="contribution-link surface surface-interactive"
              href={repository.href}
              key={repository.href}
              rel="noreferrer"
              target="_blank"
              onClick={(event) => {
                event.preventDefault();
                void openHttpsUrl(repository.href);
              }}
            >
              <span className="contribution-link-copy">
                <strong>{t(repository.name)}</strong>
                <small>{t(repository.description)}</small>
              </span>
              <Icon name="external" size={16} />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
