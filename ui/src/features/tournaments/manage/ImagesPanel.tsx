// Pictures attached to the event: a banner, a prize photo, a bracket graphic.
//
// The website adds them by pasting into the description; here they are added
// from a file, which lands in the same set. One the description or the rewards
// place themselves is marked in use; the rest show as a gallery under the
// briefing, which is how the Overview already draws them. Removing one deletes
// its file on the service, so it is gone from the text that placed it too.
//
// The service's limits are checked before the upload rather than after it: ten
// images, 5 MB each, and only the formats it stores. A 20 MB photo read into a
// data URL and sent only to be refused is a long wait for a sentence.

import { useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { Tourney, TourneyAdmin } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { unplacedImages } from "../../../shared/markdown";

/** `MAX_DESC_IMAGES` on the service. */
const MAX_IMAGES = 10;
/** `MAX_IMG_BYTES` on the service. */
const MAX_BYTES = 5 * 1024 * 1024;
/** The formats `saveDescImage` keeps; anything else it refuses. */
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];

interface ImagesPanelProps {
  event: Tourney;
  assetBase: string;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
}

export function ImagesPanel({ event, assetBase, busy, onAdmin }: ImagesPanelProps) {
  const { t } = useTranslation();
  const picker = useRef<HTMLInputElement>(null);
  /** Why the last file was not sent, said beside the button. */
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const unplaced = new Set(unplacedImages(event.descImages, [event.description, event.rewards]));
  const full = event.descImages.length >= MAX_IMAGES;

  const upload = (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      setProblem("tournaments.images.wrongType");
      return;
    }
    if (file.size > MAX_BYTES) {
      setProblem("tournaments.images.tooLarge");
      return;
    }
    setProblem(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        onAdmin({ type: "addImage", payload: { dataUrl: reader.result } });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="tournament-images">
      <p className="muted">
        {t("tournaments.images.hint", { count: event.descImages.length, max: MAX_IMAGES })}
      </p>
      {event.descImages.length > 0 && (
        <ul className="tournament-image-grid">
          {event.descImages.map((file) => (
            <li key={file} className="tournament-image">
              <img src={`${assetBase}/desc-images/${encodeURIComponent(file)}`} alt="" loading="lazy" />
              {!unplaced.has(file) && <small className="muted">{t("tournaments.images.inUse")}</small>}
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t("tournaments.images.removeConfirm"))) {
                    onAdmin({ type: "removeImage", payload: { file } });
                  }
                }}
              >
                {t("tournaments.images.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={picker}
        type="file"
        accept={ACCEPTED.join(",")}
        hidden
        onChange={(changed) => {
          const file = changed.target.files?.[0];
          // Cleared at once, so choosing the same file again still fires.
          changed.target.value = "";
          if (file !== undefined) upload(file);
        }}
      />
      <Button type="button" disabled={busy || full} onClick={() => picker.current?.click()}>
        {t(full ? "tournaments.images.full" : "tournaments.images.add")}
      </Button>
      {problem !== null && <p className="tournament-form-hint">{t(problem)}</p>}
    </div>
  );
}
