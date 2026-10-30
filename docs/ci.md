# Continuous integration

CI keeps the existing check names so branch protection does not need to change.
Every pull request runs the dependency advisory/licence checks, commit author
checks and the frontend job's inexpensive policy checks. The frontend job also
keeps its production dependency audit on every run.

Expensive checks are selected by `scripts/ci-changes.mjs`:

| Changed files | Expensive checks |
| --- | --- |
| Only `README.md`, Markdown under `docs/` or `changelog/` | None |
| Only `ui/` plus the documentation above | Frontend typecheck, lint, tests and build |
| Generated `ui/src/ipc/bindings.ts` | Frontend plus bindings regeneration |
| Reducer conformance JSON fixtures | Frontend plus Rust fixture regeneration |
| Anything else, including Rust, scripts, workflows and dependency manifests | All |

This deliberately avoids maintaining a complete build dependency map. Unknown
paths run everything. In particular, Markdown fixtures inside Rust crates are
code inputs, not documentation. Pushes to `main` and `develop` always run all
checks, regardless of the changed paths.

The selector reads the complete local Git diff between the pull request's base
and the checked-out merge commit, with rename detection disabled. This covers
all commits in the pull request, both sides of a rename, deletions and changes
beyond GitHub's API file-list limits. Full checkout history makes both commits
available. Missing history, invalid event data or a failed selector job cause
the expensive checks to run instead of silently skipping them. Cancellation
still stops superseded runs.

Run the selector's focused regression checks without installing dependencies:

```sh
node --test scripts/ci-changes.node-test.mjs
```

Rust caches stay separate for the workspace test, bindings and reducer jobs.
They retain the existing dependency cache configuration. Compare successful
GitHub job/step timings on equivalent code changes before expanding the cache:
larger archives can cost more to restore and save, and caching project outputs
does not by itself prove that Cargo can reuse them on a fresh checkout.
