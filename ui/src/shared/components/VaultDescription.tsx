// The description block of a vault detail panel: the mod vault, the
// installed-mods panel and the map vault all draw the same one.
//
// The copy control used to be a full-width "Copy description" button under
// the text, in the mod vault only. Feedback 3 (issue 351) moved it up beside
// the heading as an icon, the way the replay card copies its id: it belongs
// to the description rather than to the row of actions below it, and the map
// vault, whose descriptions carry forum links just as often, gets it too.

import { useEffect, useState } from "react";

import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../externalLinks";
import { linkifyText } from "../linkify";
import "./vault-description.css";

export function VaultDescription({
  className,
  title,
  description,
  empty,
}: {
  className?: string;
  title: string;
  description: string;
  empty: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const label = t(copied ? "vault.descriptionCopied" : "vault.copyDescription");

  return (
    <section className={className ? `vault-detail-description ${className}` : "vault-detail-description"}>
      <div className="vault-description-head">
        <h3>{title}</h3>
        {description && (
          <button
            type="button"
            className="vault-description-copy"
            aria-label={label}
            title={label}
            onClick={() => {
              void navigator.clipboard?.writeText(description).then(
                () => setCopied(true),
                // A refused clipboard is not worth an error dialog: the text is
                // right there and selectable.
                () => setCopied(false),
              );
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
        )}
      </div>
      {description ? (
        <p className="vault-description-text">
          {linkifyText(description).map(({ text, href }, index) =>
            href === null ? (
              <span key={index}>{text}</span>
            ) : (
              <a
                key={index}
                href={href}
                className="vault-description-link"
                onClick={(event) => {
                  event.preventDefault();
                  void openHttpsUrl(href);
                }}
              >
                {text}
              </a>
            ),
          )}
        </p>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
