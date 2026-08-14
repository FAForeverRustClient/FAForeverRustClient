import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { Game } from "../../ipc/bindings";

interface Props {
  game: Game;
  password: string;
  onPassword: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function PrivateGameDialog({ game, password, onPassword, onCancel, onSubmit }: Props) {
  return (
    <Modal onClose={onCancel}>
      <div className="password-dialog">
        <span className="metric-icon">
          <Icon name="lock" size={18} />
        </span>
        <h2>Private game</h2>
        <p>Enter the password for “{game.title}”. Passwords are case-sensitive.</p>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && password) onSubmit();
          }}
          placeholder="Game password"
        />
        <div className="play-dialog-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!password} onClick={onSubmit}>
            Join game
          </Button>
        </div>
      </div>
    </Modal>
  );
}
