import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/reducer-conformance.json";
import { mapDownloadUrl, mapThumbnailUrl } from "../shared/mapCatalogue";

describe("map catalogue URL conformance with Rust", () => {
  for (const testCase of fixture.helpers.mapCatalogueUrls) {
    it(testCase.name, () => {
      expect(mapThumbnailUrl(testCase.input)).toBe(testCase.expected.thumbnailUrl);
      expect(mapThumbnailUrl(testCase.input, true)).toBe(testCase.expected.thumbnailUrlLarge);
      expect(mapDownloadUrl(testCase.input)).toBe(testCase.expected.downloadUrl);
    });
  }
});
