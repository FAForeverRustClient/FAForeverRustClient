import { ipc } from "../../ipc/client";

export const openPlayerCard = (playerId: number | null, login: string) => ipc.send({
  kind: "PlayerCard",
  command: { type: "open", payload: { playerId, login } },
});

export const closePlayerCard = () => ipc.send({
  kind: "PlayerCard",
  command: { type: "close" },
});
