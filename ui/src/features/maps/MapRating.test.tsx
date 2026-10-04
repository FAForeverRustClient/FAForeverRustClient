import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MapRating } from "./MapVaultComponents";

describe("MapRating", () => {
  it("shows the average and the review count in brackets (#416)", () => {
    const html = renderToStaticMarkup(<MapRating map={{ ratingTenths: 43, reviews: 128 }} />);
    expect(html).toContain("map-rating");
    expect(html).toContain(">4.3<");
    expect(html).toContain("(128)");
  });

  it("renders nothing for a map without reviews or without a vault record", () => {
    expect(renderToStaticMarkup(<MapRating map={{ ratingTenths: 0, reviews: 0 }} />)).toBe("");
    expect(renderToStaticMarkup(<MapRating map={undefined} />)).toBe("");
  });
});
