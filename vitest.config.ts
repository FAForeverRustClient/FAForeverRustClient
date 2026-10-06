import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not a DOM, by default: most of these cover the store's pure
    // reducer layer, the frontend twin of `faf-domain`'s reducers, and the
    // presentation helpers beside the components, and they stay as fast as
    // they were.
    //
    // A test that mounts a component opts in per file, with
    // `// @vitest-environment happy-dom` as its first line, and imports
    // `ui/src/testing/mounted` for the harness: store seeding, the mocked IPC
    // boundary's record, cleanup between tests. Those are the
    // `*.dom.test.tsx` files, for what a static render cannot show: effects
    // cleaned up, focus moved and given back, Escape reaching the right layer.
    environment: "node",
    // `scripts/` is in here for one file: the events bot maps Discord's
    // scheduled events onto the calendar document's recurrence rules, and
    // getting that mapping wrong publishes a wrong date to every client
    // silently. The rest of `scripts/` is build glue that fails loudly.
    include: ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
