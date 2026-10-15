# Historical client release notes

The published releases from v0.5.5 through v0.8.0 had only the installer
download sentence in their GitHub descriptions. These notes reconstruct the
changes between each pair of published tags, without creating entries for
versions that were never published.

`history.json` records a source commit for every change. The Markdown files
link each change to the pull request that introduced it and link the complete
tag comparison. Reverted changes were checked against the final release
history, including the withdrawn average-rating filter and local matchmaker
size filters. Build and documentation changes are omitted unless they affect
players. The first Linux installers are listed in v0.6.5, rather than v0.6.2,
which added source support but published Windows installers only.

Each Markdown file is the description for its GitHub release, pasted over the
installer sentence. The client reads release notes from GitHub, so the notes
reach every client version from there; the client holds no copy of its own.

With the release tags available locally, verify every source commit and the
generated files:

```sh
node scripts/historical-release-notes.mjs
```

After correcting the source manifest, regenerate with:

```sh
node scripts/historical-release-notes.mjs --write
```

The historical files are separate from new release snippets. They must not
be combined into the changelog for the next client release.
