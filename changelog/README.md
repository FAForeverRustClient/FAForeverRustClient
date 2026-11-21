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

A pull request that only adds or fixes snippets for other pull requests gets
none of its own: the release notes describe changes, and it makes none.

The snippet follows its pull request: when review fixes or a rebase change
what the pull request does, change the snippet with it. The pull request
number is only known once the pull request is open, so the snippet is usually
its second commit.

## At release

The Release workflow combines every snippet added since the previous release
tag, grouped by category, into the text of the GitHub release, and the
changelog bridge posts that text to Discord when the release is published. A
release with no new snippets is refused.

Ticking **Required update** when starting the workflow puts one line first in
the notes: "**Required update.** Older versions of the client ask to install
it right away." Clients behind that release then raise the update gate at once
instead of after the usual three days. Keep it for security fixes and changes
the server will not accept older clients for, and do not type the line by hand:
the client looks for it word for word.

Nothing has to be deleted to start the next release empty: only snippets added
since the last tag count. Old ones can be cleared out whenever the folder gets
long.

To see what the next release would say:

```bash
node scripts/changelog.mjs combine "$(git describe --tags --abbrev=0 --match 'v*')"
```

CI runs `node scripts/changelog.mjs verify`, which rejects misnamed or empty snippets and requires any highlights snippet to contain 3 to 7 top-level bullets, each on one line.

Before opening a draft or building installers, the Release workflow runs `node scripts/changelog.mjs release <previous tag>`. This requires exactly one new `highlights.<pr>.md` snippet in that release's changes. Missing highlights, duplicate summaries and summaries from older releases cannot satisfy the check. Use this command locally to check the release before dispatching the workflow; `combine` remains available for previews without highlights.

This is the scheme FAForever/fa uses for its game patch notes
(`changelog/snippets` there), trimmed to the categories a client needs.

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

## Highlights

The pull request that bumps the version for a release carries one more snippet, `highlights.<pr>.md`: 3 to 7 bullet points for the whole release, the changes that matter most to players, written like any other snippet.

```markdown
- The client's own release notes, in the Changelog tab.
- A short "What's new" after every update.
- Replay searches remember your chosen filters.
```

They lead the release notes, ahead of Features, and they lead the client's What's new window after the update, which lists every change of the release below them, section by section. The window finds them by their heading, so `Highlights` stays `Highlights`. The Release workflow refuses to proceed without them.

To correct highlights after publishing, edit the existing release description: keep any Required update notice first and put `### Highlights` before `### Features`. Keep the published tag and installers unchanged. Do not add a past release's highlights to the next release's snippets.
