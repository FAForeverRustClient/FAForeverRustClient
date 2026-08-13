import { describe, expect, it } from "vitest";
import { coopFailureAction } from "./coopFailure";

describe("co-op load recovery", () => {
  it("renews expired authentication through the ordinary sign-out flow", () => {
    expect(coopFailureAction("unauthorized")).toBe("signOut");
  });

  it("offers retry only for failures that may clear", () => {
    expect(coopFailureAction("offline")).toBe("retry");
    expect(coopFailureAction("unexpected")).toBe("retry");
    expect(coopFailureAction("notFound")).toBeNull();
    expect(coopFailureAction("rejected")).toBeNull();
  });
});

