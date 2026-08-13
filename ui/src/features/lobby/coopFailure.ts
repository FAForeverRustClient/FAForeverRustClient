import type { RequestFailureKind } from "../../ipc/bindings";

export type CoopFailureAction = "signOut" | "retry" | null;

/** Keep recovery policy independent of presentation and exhaustively tested. */
export function coopFailureAction(kind: RequestFailureKind): CoopFailureAction {
  switch (kind) {
    case "unauthorized":
      return "signOut";
    case "offline":
    case "unexpected":
      return "retry";
    case "notFound":
    case "rejected":
      return null;
  }
}

