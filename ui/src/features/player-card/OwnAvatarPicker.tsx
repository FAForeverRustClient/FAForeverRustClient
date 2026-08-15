import { useEffect } from "react";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";

interface OwnAvatarPickerProps {
  currentUrl: string;
  onClose: () => void;
}

export function OwnAvatarPicker({ currentUrl, onClose }: OwnAvatarPickerProps) {
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
          <span className="player-card-eyebrow">Profile appearance</span>
          <h3 id="own-avatar-picker-title">Choose your active avatar</h3>
        </div>
        <Button onClick={onClose}>Done</Button>
      </header>
      <p className="muted">Only avatars assigned to your FAF account by the server can be selected.</p>

      {lobby.avatarListStatus === "loading" && (
        <div className="own-avatar-picker-status muted">Loading available avatars…</div>
      )}
      {lobby.avatarListStatus === "failed" && (
        <div className="own-avatar-picker-status is-error">
          <span>{lobby.avatarListError}</span>
          <Button onClick={() => ipc.send({ kind: "Lobby", command: { type: "loadAvatars" } })}>Retry</Button>
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
            <span>No avatar</span>
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
              <span>{avatar.tooltip || "Avatar"}</span>
            </button>
          ))}
        </div>
      )}
      {lobby.avatarSelectionStatus === "failed" && (
        <div className="own-avatar-picker-status is-error" role="alert">{lobby.avatarSelectionError}</div>
      )}
      {lobby.avatarSelectionStatus === "ready" && (
        <div className="own-avatar-picker-status is-success" role="status">Avatar selection updated.</div>
      )}
    </section>
  );
}
