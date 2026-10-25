import { expect, it } from "vitest";
import { useAppStore } from "../store";
import { reduceMapGenerator } from "./mapGenerator";

it("keeps a new ordinary generation batch within the entry limit", () => {
  const batch = (from: number, count: number) => Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`map_${from + i}`, "data:image/png;base64,AAAA"]),
  );
  const initial = useAppStore.getState().state.mapGenerator;
  const older = reduceMapGenerator(initial, { type: "previewsLoaded", payload: { previews: batch(0, 60) } });
  const incoming = batch(100, 50);
  const next = reduceMapGenerator(older, { type: "previewsLoaded", payload: { previews: incoming } });
  expect(next.previews).toEqual(incoming);
});

it("evicts the older batch by bytes even when its key sorts after the new batch", () => {
  const image = "A".repeat(8 * 1024 * 1024 + 1);
  let state = useAppStore.getState().state.mapGenerator;
  for (const name of ["zzz_old", "aaa_new"]) state = reduceMapGenerator(state, {
    type: "previewsLoaded", payload: { previews: { [name]: image } },
  });
  expect(Object.keys(state.previews ?? {})).toEqual(["aaa_new"]);
});
