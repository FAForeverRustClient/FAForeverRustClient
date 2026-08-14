import { useEffect } from "react";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";

interface OwnAvatarPickerProps {
  currentUrl: string;
  onClose: () => void;
}

export function OwnAvatarPicker({ currentUrl, onClose }: OwnAvatarPickerProps) {
  const { t } = useTranslation();
  const lobby = useAppStore((store) => store.state.lobby);
  const selecting = lobby.avatarSelectionStatus === "loading";

  useEffect(() => {
    ipc.send({ kind: "Lobby", command: { type: "loadAvatars" } });
  }, []);

  const select = (url: string | null) => ipc.send({
    kind: "Lobby",
    command: { type: "selectAvatar", payload: { url } },
  });

  return (
    <section className="own-avatar-picker surface" aria-labelledby="own-avatar-picker-title">
      <header>
        <div>
          <span className="player-card-eyebrow">{t("playerCard.avatar.eyebrow")}</span>
          <h3 id="own-avatar-picker-title">{t("playerCard.avatar.title")}</h3>
        </div>
        <Button onClick={onClose}>{t("playerCard.avatar.done")}</Button>
      </header>
      <p className="muted">{t("playerCard.avatar.hint")}</p>

      {lobby.avatarListStatus === "loading" && (
        <div className="own-avatar-picker-status muted">{t("playerCard.avatar.loading")}</div>
      )}
      {lobby.avatarListStatus === "failed" && (
        <div className="own-avatar-picker-status is-error">
          <span>{lobby.avatarListError}</span>
          <Button onClick={() => ipc.send({ kind: "Lobby", command: { type: "loadAvatars" } })}>{t("playerCard.avatar.retry")}</Button>
        </div>
      )}
      {lobby.avatarListStatus === "ready" && (
        <div className="own-avatar-grid">
          <button
            type="button"
            className={currentUrl ? "own-avatar-choice" : "own-avatar-choice is-selected"}
            aria-pressed={!currentUrl}
            disabled={selecting}
            onClick={() => select(null)}
          >
            <span className="own-avatar-none" aria-hidden>◇</span>
            <span>{t("playerCard.avatar.none")}</span>
          </button>
          {lobby.availableAvatars.map((avatar) => (
            <button
              type="button"
              className={currentUrl === avatar.url ? "own-avatar-choice surface surface-interactive is-selected" : "own-avatar-choice surface surface-interactive"}
              aria-pressed={currentUrl === avatar.url}
              disabled={selecting}
              onClick={() => select(avatar.url)}
              key={avatar.url}
              title={avatar.tooltip}
            >
              <img
                src={avatar.url}
                alt=""
                width={40}
                height={20}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
              <span>{avatar.tooltip || t("playerCard.avatar.fallback")}</span>
            </button>
          ))}
        </div>
      )}
      {lobby.avatarSelectionStatus === "failed" && (
        <div className="own-avatar-picker-status is-error" role="alert">{lobby.avatarSelectionError}</div>
      )}
      {lobby.avatarSelectionStatus === "ready" && (
        <div className="own-avatar-picker-status is-success" role="status">{t("playerCard.avatar.updated")}</div>
      )}
    </section>
  );
}
