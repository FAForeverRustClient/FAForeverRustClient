// Opening the reviews panel from a map or mod detail pane.
//
// A one-line helper rather than an inline dispatch at each call site: the
// panel is opened from two features that otherwise share nothing, and the
// command shape (kind + id + display name) is easy to get subtly wrong.

import type { ReviewKind } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";

export const openReviews = (kind: ReviewKind, id: number, name: string) =>
  ipc.send({ kind: "Reviews", command: { type: "open", payload: { target: { kind, id, name } } } });
