import { ipc } from "../ipc/client";

export const openContacts = () => ipc.send({ kind: "Social", command: { type: "setContactsOpen", payload: { open: true } } });
export const closeContacts = () => ipc.send({ kind: "Social", command: { type: "setContactsOpen", payload: { open: false } } });
