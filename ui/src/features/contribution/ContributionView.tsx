import { Icon } from "../../design-system/Icon";
import { openHttpsUrl } from "../../shared/externalLinks";
import "./contribution.css";

const REPOSITORIES = [
  {
    name: "FAF game",
    description: "The open-source Forged Alliance game project",
    href: "https://github.com/FAForever/fa",
  },
  {
    name: "FA engine patches",
    description: "Binary patches for the game engine",
    href: "https://github.com/FAForever/FA-Binary-Patches",
  },
  {
    name: "Rust client",
    description: "The next-generation FAF desktop client",
    href: "https://github.com/FAForeverRustClient/FAForever-Rust-Client",
  },
  {
    name: "Java client",
    description: "The official desktop client",
    href: "https://github.com/FAForever/downlords-faf-client",
  },
  {
    name: "Python client",
    description: "The legacy client and its history",
    href: "https://github.com/FAForever/client",
  },
  {
    name: "FAF server",
    description: "The server-side game services",
    href: "https://github.com/FAForever/server",
  },
  {
    name: "FAForever on GitHub",
    description: "Explore all FAF open-source projects",
    href: "https://github.com/FAForever",
  },
] as const;

export function ContributionView() {
  return (
    <div className="contribution-view">
      <section className="contribution-intro">
        <div className="contribution-icon surface" aria-hidden="true">
          <Icon name="github" size={24} />
        </div>
        <div className="contribution-intro-copy">
          <h2 className="view-title">Contribute</h2>
          <p>FAF is open source. Contributions, fixes, and ideas are welcome.</p>
        </div>
      </section>

      <section className="contribution-section" aria-labelledby="contribution-repositories">
        <h3 id="contribution-repositories" className="contribution-section-title">GitHub repositories</h3>
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
                <strong>{repository.name}</strong>
                <small>{repository.description}</small>
              </span>
              <Icon name="external" size={16} />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
