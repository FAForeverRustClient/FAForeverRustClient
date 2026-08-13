import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: what these cover is the store's pure reducer layer,
    // the frontend twin of `faf-domain`'s reducers. Component rendering is a
    // separate concern and would pull in a DOM environment it does not need.
    environment: "node",
    include: ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"],
  },
});
