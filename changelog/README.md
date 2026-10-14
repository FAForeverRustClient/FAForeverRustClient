# Changelog snippets

Every pull request adds a small file to `snippets/`, named after its category
and its pull request number:

```
changelog/snippets/features.507.md
changelog/snippets/fix.512.md
```

| Category | Listed under |
|---|---|
| `highlights` | Highlights (see below) |
| `features` | Features |
| `fix` | Bug fixes |
| `performance` | Performance |
| `other` | Other changes |

The file holds one short line per change, written for players and in English:
what they will see, not how it was built. A pull request with several changes
lists them, one line each; changes of different categories go in one file per
category, since the release groups lines by category.

```markdown
- Replays can be filtered by map.
- The replay list remembers its sort order.
```

Refactors, CI, tests and docs get a snippet too, under `other`, saying plainly
that nothing changes in use and naming the area:

```markdown
- No visible changes: the settings code is split into smaller files.
```

The snippet follows its pull request: when review fixes or a rebase change
what the pull request does, change the snippet with it. The pull request
number is only known once the pull request is open, so the snippet is usually
its second commit.

## Writing a line

- One sentence, ideally under 20 words. The details belong in the pull
  request.
- What the player notices, in their words: "window", not "page" or "web
  view".
- A fix says what no longer goes wrong: "no longer blurry", "no longer cuts
  a running game's connection".
- Concrete, not vague: "an icon for each folder", not "easier to read".
- Exactly what changed and no more: "avatars in player lists" when the
  avatars in chat messages were left as they were.
- A setting by its place in the client: (Settings, General, "Keep running
  during a game").

```markdown
- Flags and avatars in player lists are no longer blurry on scaled displays, such as 4K at 150%.
```

## At release

The Release workflow combines every snippet added since the previous release
tag, grouped by category, into the text of the GitHub release, and the
changelog bridge posts that text to Discord when the release is published. A
release with no new snippets is refused.

Nothing has to be deleted to start the next release empty: only snippets added
since the last tag count. Old ones can be cleared out whenever the folder gets
long.

To see what the next release would say:

```bash
node scripts/changelog.mjs combine "$(git describe --tags --abbrev=0 --match 'v*')"
```

CI runs `node scripts/changelog.mjs verify`, which fails on a misnamed or empty
snippet, so a typo in a file name cannot silently drop a line from the release.

This is the scheme FAForever/fa uses for its game patch notes
(`changelog/snippets` there), trimmed to the categories a client needs.

## Highlights

The pull request that bumps the version for a release carries one more
snippet, `highlights.<pr>.md`: 3 to 5 lines for the whole release, the changes
that matter most to players, written like any other snippet.

```markdown
- The client's own release notes, in the Changelog tab.
- A short "What's new" after every update.
```

They lead the release notes, ahead of Features, and they are what the client's
What's new window shows after the update, with a count of the rest below them.
The window finds them by their heading, so `Highlights` stays `Highlights`. A
release without them still goes out, but the window then shows the first few
lines of the notes, which are the oldest pull requests' features rather than
the ones that matter most.
