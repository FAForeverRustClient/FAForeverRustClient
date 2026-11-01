import { useState } from "react";
import { Modal } from "../../design-system/Modal";
import { useAppStore } from "../../store/store";
import { joinGame } from "../../shared/joinGame";
import { GamePreviewDialog } from "../lobby/browser/GamePreviewDialog";
import { PrivateGameDialog } from "../lobby/join/PrivateGameDialog";
import { t } from "../../i18n";

/** Reuse the normal preview and join checks, including protected lobbies. */
export default function NotificationGameDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const game = useAppStore((store) => store.state.lobby.games.find((game) => game.id === id));
  const vault = useAppStore((store) => store.state.maps.vault);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  if (!game) return <Modal onClose={onClose}><p>{t("chat.gameLink.unavailable")}</p></Modal>;
  if (needsPassword) return <PrivateGameDialog game={game} password={password} onPassword={setPassword}
    onCancel={() => setNeedsPassword(false)} onSubmit={() => { void joinGame(game.id, password); onClose(); }} />;
  return <GamePreviewDialog game={game} vault={vault} onClose={onClose} onJoin={() => {
    if (game.passwordProtected) setNeedsPassword(true);
    else { void joinGame(game.id); onClose(); }
  }} />;
}
