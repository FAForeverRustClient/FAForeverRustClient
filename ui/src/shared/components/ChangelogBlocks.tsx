// The blocks of a parsed changelog (see faf-domain's `protocol::changelog`),
// drawn in the client's own chrome.
//
// Shared because three surfaces read the same parsed notes: the Changelog
// tab's game patches, its client releases, and the What's new popup after an
// update, which shows the first few changes of one release. They render a run
// of text the same way everywhere, so a link or an issue number behaves the
// same in the popup as on the page it leads to.

import { useEffect, useState } from "react";
import type { ChangelogBlock, ChangelogListItem, ChangelogSpan } from "../../ipc/bindings";
import { native } from "../../ipc/native";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import "./changelog-blocks.css";

export function ChangelogSpans({ spans }: { spans: ChangelogSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.type) {
          case "strong":
            return <strong key={index}>{span.payload}</strong>;
          case "code":
            return <code key={index} className="changelog-code">{span.payload}</code>;
          case "link":
            return (
              <button
                key={index}
                type="button"
                className="changelog-link"
                title={span.payload.url}
                onClick={() => void native.openUrl(span.payload.url)}
              >
                {span.payload.text}
              </button>
            );
          case "issue":
            return (
              <button
                key={index}
                type="button"
                className="changelog-issue"
                title={span.payload.url}
                onClick={() => void native.openUrl(span.payload.url)}
              >
                {span.payload.label ?? `#${span.payload.number}`}
              </button>
            );
          default:
            return <span key={index}>{span.payload}</span>;
        }
      })}
    </>
  );
}

export function ChangelogListItems({ items, anchorId }: { items: ChangelogListItem[]; anchorId?: string }) {
  return (
    <ul id={anchorId} className="changelog-list">
      {items.map((item, index) => (
        <li key={index}>
          {item.change ? (
            // A value change reads as a diff, the way the site styles it: the
            // strike and the arrow say which is which before the colour does.
            <span className="changelog-change">
              <span className="changelog-change-label">{item.change.label}</span>
              <span className="changelog-old">{item.change.old}</span>
              <Icon name="arrowRight" size={12} />
              <span className="changelog-new">{item.change.new}</span>
            </span>
          ) : (
            <ChangelogSpans spans={item.spans} />
          )}
          {item.children.length > 0 && <ChangelogListItems items={item.children} />}
        </li>
      ))}
    </ul>
  );
}

function ChangelogCodeBlock({ text, anchorId }: { text: string; anchorId: string }) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const label = t(copyState === "copied" ? "changelog.codeCopied"
    : copyState === "failed" ? "changelog.codeCopyFailed" : "changelog.copyCode");
  // The button has a column of its own beside the text. Drawn over the box,
  // it covered the end of the first line, and of any line scrolled under it.
  return (
    <div id={anchorId} className="changelog-code-container">
      <pre className="changelog-code-block" tabIndex={0} role="region" aria-label={t("changelog.codeBlock")}>
        <code>{text}</code>
      </pre>
      <Button
        className={`changelog-code-copy${copyState === "copied" ? " is-copied" : ""}`}
        aria-label={label}
        title={label}
        onClick={() => void copy()}
      >
        <Icon name={copyState === "copied" ? "check" : "copy"} size={16} />
      </Button>
      <span className="changelog-code-status" role="status">{copyState === "idle" ? "" : label}</span>
    </div>
  );
}

function HistoricalBalance({ block, anchorId }: {
  block: Extract<ChangelogBlock, { type: "historicalBalance" }>; anchorId: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="changelog-historical" aria-labelledby={anchorId}>
      <h2 id={anchorId} className="changelog-heading changelog-heading-2">{t("changelog.historicalBalance")}</h2>
      <p className="changelog-paragraph">
        <button type="button" className="changelog-link" onClick={() => void native.openUrl(block.payload.sourceUrl)}>
          {t("changelog.historicalBalanceSource")}
        </button>
      </p>
      {block.payload.unavailable ? <>
        <p className="changelog-paragraph" role="status">{t("changelog.historicalBalanceUnavailable")}</p>
        <Button onClick={() => void ipc.send({ kind: "Changelog", command: { type: "select", payload: { id: block.payload.patchId } } })}>
          {t("changelog.retry")}
        </Button>
      </> : block.payload.blocks.map((child, index) => (
        <ChangelogBlockView key={index} block={child} anchorId={`${anchorId}-${index}`} headingOffset={1} />
      ))}
    </section>
  );
}

export function ChangelogBlockView({ block, anchorId, headingOffset = 0 }: {
  block: ChangelogBlock; anchorId: string; headingOffset?: number;
}) {
  switch (block.type) {
    case "heading": {
      // The page title is the one `h1`; the note's sections start at `h2`.
      const level = Math.min(Math.max(block.payload.level + headingOffset, 2), 6);
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag id={anchorId} className={`changelog-heading changelog-heading-${level}`}>
          {block.payload.text}
        </Tag>
      );
    }
    case "unit":
      return (
        <div id={anchorId} className="changelog-unit">
          <span className="changelog-unit-icons">
            {block.payload.units.map((unit) => (
              <img
                key={unit.unitId ?? unit.iconUrl}
                className="changelog-unit-icon"
                src={unit.iconUrl}
                alt=""
                title={unit.unitId ?? undefined}
                loading="lazy"
                draggable={false}
                /* Older notes name units the site never drew an icon for, and a
                   missing sprite should leave a gap rather than a broken image. */
                onError={(event) => event.currentTarget.classList.add("is-missing")}
              />
            ))}
          </span>
          <span className="changelog-unit-name">{block.payload.name}</span>
        </div>
      );
    case "list":
      return <ChangelogListItems items={block.payload.items} anchorId={anchorId} />;
    case "historicalBalance":
      return <HistoricalBalance block={block} anchorId={anchorId} />;
    case "codeBlock":
      return <ChangelogCodeBlock key={block.payload.text} text={block.payload.text} anchorId={anchorId} />;
    default:
      return (
        <p id={anchorId} className="changelog-paragraph">
          <ChangelogSpans spans={block.payload.spans} />
        </p>
      );
  }
}
