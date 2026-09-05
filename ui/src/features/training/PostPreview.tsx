// The composed post, shown before it goes anywhere.
//
// The client writes the post; the player sends it. That split is deliberate
// (see `faf_domain::state::training`), and this is where it becomes visible:
// nothing is published by pressing a button in this client, and the player
// reads what their name will be attached to first.
//
// Two destinations, and they differ in how much the link can carry. A guide
// submission goes to GitHub, whose new-issue form takes the whole thing on the
// query string, so the link is the fast path. A replay review goes to the
// training Discord, which cannot be handed a prefilled message at all, so there
// the link only opens the server and **copy is the action**: the value was
// never the paste, it is not having to find the channel and remember what the
// pinned template asks for.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { ForumPost, SubmitStatus } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { Markdown } from "./markdown";

interface Props {
  post: ForumPost;
  /**
   * Where this one is going. Decides the wording and which action leads:
   * a link that carries the post (GitHub) or a link that only opens the place
   * it has to be pasted (Discord).
   */
  destination: "github" | "discord";
  /** Where a direct send stands, for the paths that have one. */
  submit?: SubmitStatus;
  /** Send it from the client, or `null` when only the browser path exists. */
  onSubmit?: (() => void) | null;
}

export function PostPreview({ post, destination, submit, onSubmit }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const sending = submit?.type === "sending";
  const sent = submit?.type === "sent" ? submit.payload.url : null;
  const failed = submit?.type === "failed" ? submit.payload.reason : null;
  const toDiscord = destination === "discord";

  const copy = () => {
    void navigator.clipboard
      ?.writeText(`${post.title}\n\n${post.body}`)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <section className="training-post">
      <header>
        <h4>{t("training.post.title")}</h4>
        <p className="muted">
          {t(toDiscord ? "training.post.leadDiscord" : "training.post.lead")}
        </p>
      </header>

      <div className="training-post-body">
        <strong className="training-post-subject">{post.title}</strong>
        <Markdown source={post.body} />
      </div>

      <div className="training-post-actions">
        {/* Discord cannot take a prefilled message, so the text in the
            clipboard *is* the delivery. It leads, and the invite follows it. */}
        {toDiscord && (
          <Button variant="primary" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={15} />{" "}
            {t(copied ? "training.post.copied" : "training.post.copyForDiscord")}
          </Button>
        )}
        {/* When the client holds a session it can open the submission itself,
            which is one step instead of three. Everyone else gets the same
            submission prefilled in their browser. */}
        {onSubmit && !sent && (
          <Button variant="primary" disabled={sending} onClick={onSubmit}>
            <Icon name="upload" size={15} />{" "}
            {t(sending ? "training.post.sending" : "training.post.send")}
          </Button>
        )}
        {sent && (
          <Button variant="primary" onClick={() => void openHttpsUrl(sent)}>
            <Icon name="check" size={15} /> {t("training.post.sent")}
          </Button>
        )}
        {post.url && !sent ? (
          <Button
            variant={toDiscord || onSubmit ? undefined : "primary"}
            // On the Discord path this copies on the way out. Nothing can
            // prefill the message, so the nearest honest thing is to land the
            // player in the channel with the request already on their
            // clipboard: one paste, and nothing to remember.
            onClick={() => {
              if (toDiscord) copy();
              void openHttpsUrl(post.url);
            }}
          >
            <Icon name="external" size={15} />{" "}
            {t(toDiscord ? "training.post.openDiscord" : "training.post.open")}
          </Button>
        ) : sent ? null : (
          // Nothing configured to open, which for Discord means no invite and
          // for GitHub no repository. The text is still the whole point.
          <span className="muted training-post-note">{t("training.post.noDestination")}</span>
        )}
        {!toDiscord && (
          <Button onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={15} />{" "}
            {t(copied ? "training.post.copied" : "training.post.copy")}
          </Button>
        )}
      </div>

      {failed && <p className="muted training-form-problem">{failed}</p>}
    </section>
  );
}
