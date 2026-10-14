// The starting dialog names a replay from the lists the client holds, and
// still names it by its id when none of them has it.

import { describe, expect, it } from "vitest";
import type { Game, LocalReplay, VaultReplay } from "../../ipc/bindings";
import { replayLaunchContext, type ReplayLaunchSources } from "./replayLaunchContext";

const NONE: ReplayLaunchSources = { vault: [], recentMatchmaker: [], liveGames: [], local: [] };

const vaultReplay = (uid: number, title: string, map: string) =>
  ({ uid, title, map, mapThumbnailUrl: `https://content/${map}.png` }) as VaultReplay;

describe("replayLaunchContext", () => {
  it("names a vault replay from the search results, then from the matchmaker list", () => {
    const fromSearch = replayLaunchContext(
      { type: "vault", payload: { uid: 7 } },
      { ...NONE, vault: [vaultReplay(7, "Ladder night", "scmp_009")] },
    );
    expect(fromSearch).toMatchObject({ uid: 7, title: "Ladder night", map: "scmp_009", live: false });
    expect(fromSearch.mapUrl).toBe("https://content/scmp_009.png");

    const fromMatchmaker = replayLaunchContext(
      { type: "vault", payload: { uid: 8 } },
      { ...NONE, recentMatchmaker: [vaultReplay(8, "1v1", "scmp_015")] },
    );
    expect(fromMatchmaker).toMatchObject({ uid: 8, title: "1v1", map: "scmp_015" });
  });

  it("keeps the id of a vault replay no list here knows", () => {
    expect(replayLaunchContext({ type: "vault", payload: { uid: 9 } }, NONE)).toEqual({
      uid: 9,
      title: null,
      map: null,
      mapUrl: null,
      fileName: null,
      live: false,
    });
  });

  it("takes a live game's map from the stream and its title from the live list", () => {
    const context = replayLaunchContext(
      { type: "live", payload: { target: { uid: 42, modName: "faf", map: "scmp_009" } } },
      { ...NONE, liveGames: [{ id: 42, title: "Friday Setons", map: "scmp_009" } as Game] },
    );
    expect(context).toMatchObject({ uid: 42, title: "Friday Setons", map: "scmp_009", live: true });
  });

  it("matches a local file however its path is written, and falls back to its name", () => {
    const local = [{
      path: "C:\\Replays\\7.fafreplay",
      fileName: "7.fafreplay",
      uid: 7,
      map: "scmp_009",
      title: "Ladder night",
    } as LocalReplay];
    expect(
      replayLaunchContext({ type: "file", payload: { path: "C:/Replays/7.fafreplay" } }, { ...NONE, local }),
    ).toMatchObject({ uid: 7, title: "Ladder night", map: "scmp_009" });

    expect(
      replayLaunchContext({ type: "file", payload: { path: "D:\\elsewhere\\old.scfareplay" } }, NONE),
    ).toMatchObject({ uid: null, title: null, fileName: "old.scfareplay" });
  });
});
