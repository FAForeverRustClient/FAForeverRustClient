import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: what these cover is the store's pure reducer layer,
    // the frontend twin of `faf-domain`'s reducers. Component rendering is a
    // separate concern and would pull in a DOM environment it does not need.
    environment: "node",
    // `scripts/` is in here for one file: the events bot maps Discord's
    // scheduled events onto the calendar document's recurrence rules, and
    // getting that mapping wrong publishes a wrong date to every client
    // silently. The rest of `scripts/` is build glue that fails loudly.
    include: ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
