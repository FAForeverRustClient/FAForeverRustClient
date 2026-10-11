// "Not public yet", said on every section of an unpublished event.
//
// The service creates every tournament unpublished, and the step people forget
// is the one that makes it visible: an event missing from everyone else's list
// looks like a broken list, not like an unpublished draft. So the organiser is
// told on whatever section they are looking at, as on the website, and can
// publish now, or at a set moment, from right there.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { Tourney } from "../../../ipc/bindings";
import type { OrganiserActions } from "../tourneyActions";
import { useTranslation } from "../../../i18n/useTranslation";
import { formatMoment } from "../tourneyPresentation";

interface PublishBannerProps {
  event: Tourney;
  /** Where the service lives, for the share link. Empty until it is known. */
  assetBase: string;
  busy: boolean;
  /** Publishing now, and the scheduled publish, which is an organiser change. */
  organiser: Pick<OrganiserActions, "publish" | "admin">;
}

/** `YYYY-MM-DDTHH:mm` in local time, as a `datetime-local` field reads it. */
function secondsOf(value: string): number | null {
  if (value === "") return null;
  const millis = new Date(value).getTime();
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000);
}

export function PublishBanner({ event, assetBase, busy, organiser }: PublishBannerProps) {
  const { t } = useTranslation();
  const [when, setWhen] = useState("");
  const [copied, setCopied] = useState(false);
  const link = assetBase === "" ? "" : `${assetBase.replace(/\/+$/, "")}/t/${event.id}`;
  const at = secondsOf(when);

  return (
    <section className="surface tournament-publish-banner" role="status">
      <strong>{t("tournaments.publish.notPublic")}</strong>
      <p className="muted">{t("tournaments.publish.hint")}</p>
      {link !== "" && (
        <div className="tournament-detail-actions">
          <input className="tournament-share-link" readOnly value={link} onFocus={(focused) => focused.target.select()} />
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => setCopied(true));
            }}
          >
            <Icon name="copy" size={14} /> {t(copied ? "tournaments.publish.copied" : "tournaments.publish.copy")}
          </Button>
        </div>
      )}
      {event.publishAt !== null && (
        <div className="tournament-detail-actions">
          <span>{t("tournaments.publish.scheduled", { when: formatMoment(event.publishAt, "") })}</span>
          <Button disabled={busy} onClick={() => organiser.admin({ type: "schedulePublish", payload: { at: null } })}>
            {t("tournaments.publish.cancelSchedule")}
          </Button>
        </div>
      )}
      <div className="tournament-detail-actions">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t("tournaments.publish.confirm"))) organiser.publish();
          }}
        >
          {t("tournaments.publish.now")}
        </Button>
        <label className="tournament-field">
          <span>{t("tournaments.publish.orSchedule")}</span>
          <input type="datetime-local" value={when} onChange={(changed) => setWhen(changed.target.value)} />
        </label>
        <Button
          disabled={busy || at === null}
          onClick={() => {
            if (at !== null) organiser.admin({ type: "schedulePublish", payload: { at } });
            setWhen("");
          }}
        >
          {t("tournaments.publish.schedule")}
        </Button>
      </div>
    </section>
  );
}
