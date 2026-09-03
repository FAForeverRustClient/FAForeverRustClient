# Documentation

Two kinds of document live here, and the difference matters more than the
filenames suggest.

## Living documents

Kept current. If the code and one of these disagree, that is a bug in the
document.

| Document | What it is |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The architecture contract: the layering rules, why they exist, and what is not allowed to cross which boundary. The README points every contributor here, and CI enforces parts of it. |
| [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) | The map: what each crate and directory is for, where to add a new state slice, command, port or screen, and one click traced end to end. |
| [`design-philosophy.md`](design-philosophy.md) | Why the interface looks and behaves the way it does. |
| [`env.example.txt`](env.example.txt) | Template for a local dev launch. Copy it to `docs/env.txt`, which is gitignored, and put your own paths in that copy. |

## Notes

[`notes/`](notes/) holds point-in-time work: research, audits, and drafts. They
were true when written and are **not** maintained afterwards. Each one carries
its date at the top. Read them for the reasoning that produced a decision, not
as a description of the client as it stands today.

| Note | Written | What it is |
|---|---|---|
| [`notes/feature-comparison.md`](notes/feature-comparison.md) | 2026-08-14 | Feature by feature comparison of this client against the Python and Java clients, as they stood then. |
| [`notes/feature-wishlist.md`](notes/feature-wishlist.md) | 2026-08-14 | Requests collected from players. Several have since shipped. |
| [`notes/neroxis-mapgen-comparison.md`](notes/neroxis-mapgen-comparison.md) | 2026-08-18 | How the map generator integration compares with the reference clients'. |
| [`notes/tourney-audit.md`](notes/tourney-audit.md) | 2026-08-18 | Audit of the tournament tab against the faf-tournaments service. |
| [`notes/tourney-features.md`](notes/tourney-features.md) | 2026-08-19 | What the tournament tab does and what was deliberately left out. |
| [`notes/tourney-migration.md`](notes/tourney-migration.md) | 2026-08-18 | Migration plan for the tournament backend. |
| [`notes/play-tab-showcase-draft.html`](notes/play-tab-showcase-draft.html) | 2026-08-14 | An early visual draft of the play tab. Never implemented as drawn. |

## Repository guardrails

CI enforces a handful of repository rules that no linter would catch. They are
listed in [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md#8-repository-guardrails) with
the command that reproduces them locally, because a rule you can only discover
by pushing a red build is not a rule anybody can follow.
