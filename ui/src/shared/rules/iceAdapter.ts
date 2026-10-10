// Which ICE adapter a game starts on.
//
// Twin of `IceAdapter::for_game` in the domain's `state/settings.rs`, pinned by
// the `iceAdapterChoices` cases in the conformance fixture. The backend makes
// the real choice when it starts the adapter (`SelectableIce::selected`, from
// the launch order's title); this reads the same title and the same setting so
// the join dialog can say which one that will be, rather than guess.

import type { IceAdapter } from "../../ipc/bindings";
import { splitGoAdapterTitle } from "../goAdapterTitle";

/** An adapter a game actually runs on: `dynamic` already resolved. */
export type ResolvedIceAdapter = Exclude<IceAdapter, "dynamic">;

/**
 * Twin of `IceAdapter::for_game`: `dynamic` follows the host's title mark, Go
 * when the title carries it and Java otherwise; a fixed choice stays as it is.
 */
export function adapterForGame(adapter: IceAdapter, title: string): ResolvedIceAdapter {
  if (adapter !== "dynamic") return adapter;
  return splitGoAdapterTitle(title).goAdapter ? "go" : "java";
}
