import { describe, expect, it } from "vitest";
import { backgroundMimeType } from "./appBackground";

describe("a stored background's type (#439)", () => {
  it("follows the extension the stored name kept", () => {
    expect(backgroundMimeType("1700-sunset.JPG")).toBe("image/jpeg");
    expect(backgroundMimeType("1700-sunset.webp")).toBe("image/webp");
    expect(backgroundMimeType("1700-sunset.png")).toBe("image/png");
  });
});
