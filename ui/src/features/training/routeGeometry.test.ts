import { expect, it } from "vitest";
import { routeGeometry } from "./routeGeometry";

it("preserves travel approaches, reclaim legs and gaps between reclaim runs", () => {
  const result = routeGeometry([false, true, true, false, true, true].map((reclaim, x) => ({ x, z: x, reclaim })));
  expect(result.reclaim).toBe("M1,1L2,2M4,4L5,5");
  expect(result.travel).toBe("M0,0L1,1M2,2L3,3L4,4");
  expect(result.routePoints).toBe("0,0 1,1 2,2 3,3 4,4 5,5");
});
