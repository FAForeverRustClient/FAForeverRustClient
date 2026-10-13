# Changelog snippets

Every pull request that changes something players will notice adds one small
file to `snippets/`, named after its category and its pull request number:

```
changelog/snippets/features.507.md
changelog/snippets/fix.512.md
```

| Category | Listed under |
|---|---|
| `features` | Features |
| `fix` | Bug fixes |
| `performance` | Performance |
| `other` | Other changes |

The file holds one short line, written for players and in English: what they
will see, not how it was built.

```markdown
- Replays can be filtered by map.
```

Nothing for refactors, CI, tests or docs. The pull request number is only
known once the pull request is open, so the snippet is usually its second
commit.

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
