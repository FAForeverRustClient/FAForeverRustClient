import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { Game } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  game: Game;
  password: string;
  onPassword: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function PrivateGameDialog({ game, password, onPassword, onCancel, onSubmit }: Props) {
  const { t } = useTranslation();
  return (
    <Modal onClose={onCancel}>
      <div className="password-dialog">
        <span className="metric-icon">
          <Icon name="lock" size={18} />
        </span>
        <h2>{t("lobby.private.title")}</h2>
        <p>{t("lobby.private.prompt", { title: game.title })}</p>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && password) onSubmit();
          }}
          placeholder={t("lobby.private.placeholder")}
        />
        <div className="play-dialog-actions">
          <Button onClick={onCancel}>{t("lobby.private.cancel")}</Button>
          <Button variant="primary" disabled={!password} onClick={onSubmit}>
            {t("lobby.private.join")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
