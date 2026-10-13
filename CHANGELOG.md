# Changelog

What changed in each release of the client, newest first.

The Release workflow (`.github/workflows/release.yml`) refuses to run without a
section for the version in `src-tauri/tauri.conf.json`. That section becomes
the body of the GitHub release, and the changelog bridge posts it to Discord
when the release is published. So write it in the same pull request that bumps
the version, in English, as Markdown Discord can render: headings, bold, lists
and links work there, tables do not.

A section starts with `## <version>` (`## 0.9.0`, `## v0.9.0` and
`## [0.9.0] - 2026-10-20` all work) and runs to the next `## `. Use `###` for
anything inside it.

## Unreleased

- Security fixes in the guide reader and the guide review queue, which now also shows the link each submission points to.
- A guide with unusual formatting no longer freezes the client while it opens.
- A custom background picture loads faster when the client starts.
- The External links tab is laid out as four cards with an icon for every site, and fits on one screen.
