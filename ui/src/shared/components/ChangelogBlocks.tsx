// The blocks of a parsed changelog (see faf-domain's `protocol::changelog`),
// drawn in the client's own chrome.
//
// Shared because three surfaces read the same parsed notes: the Changelog
// tab's game patches, its client releases, and the What's new popup after an
// update, which shows the first few changes of one release. They render a run
// of text the same way everywhere, so a link or an issue number behaves the
// same in the popup as on the page it leads to.

import type { ChangelogBlock, ChangelogListItem, ChangelogSpan } from "../../ipc/bindings";
import { native } from "../../ipc/native";
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
                #{span.payload.number}
              </button>
            );
          default:
            return <span key={index}>{span.payload}</span>;
        }
      })}
    </>
  );
}

export function ChangelogListItems({ items }: { items: ChangelogListItem[] }) {
  return (
    <ul className="changelog-list">
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

export function ChangelogBlockView({ block, anchorId }: { block: ChangelogBlock; anchorId: string }) {
  switch (block.type) {
    case "heading": {
      // The page title is the one `h1`; the note's sections start at `h2`.
      const level = Math.min(Math.max(block.payload.level, 2), 4);
      const Tag = `h${level}` as "h2" | "h3" | "h4";
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
                key={unit.unitId}
                className="changelog-unit-icon"
                src={unit.iconUrl}
                alt=""
                title={unit.unitId}
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
      return <ChangelogListItems items={block.payload.items} />;
    default:
      return (
        <p className="changelog-paragraph">
          <ChangelogSpans spans={block.payload.spans} />
        </p>
      );
  }
}
