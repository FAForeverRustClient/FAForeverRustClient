// Tutorials: FAF's guided single-player lessons.
//
// Mirrors the Java client's `TutorialController`/`tutorial_detail.fxml`:
// categories down the left, and a detail pane where the briefing reads as prose
// beside a fixed-size map thumbnail with the launch button under it. The image
// is deliberately *not* a banner: the API serves small map previews, and
// stretching one across the pane produced a wall of blur.

import { useEffect, useMemo } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { Tutorial } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import "./tutorials.css";

const load = () => ipc.send({ kind: "Tutorials", command: { type: "load" } });
const select = (tutorialId: number) =>
  ipc.send({ kind: "Tutorials", command: { type: "select", payload: { tutorialId } } });
const launch = (tutorialId: number) =>
  ipc.send({ kind: "Tutorials", command: { type: "launch", payload: { tutorialId } } });

export function TutorialsView() {
  const state = useAppStore((store) => store.state.tutorials);

  useEffect(() => {
    if (useAppStore.getState().state.tutorials.status.type === "idle") void load();
  }, []);

  const selected = state.tutorials.find((t) => t.id === state.selectedId) ?? null;
  const note = loadStatusNote(state.status, "Loading tutorials…", "Could not load tutorials");

  // Group by category, keeping each author's teaching order (`ordinal`).
  const groups = useMemo(() => {
    const byCategory = state.categories.map((category) => ({
      category,
      tutorials: state.tutorials
        .filter((tutorial) => tutorial.categoryId === category.id)
        .sort((a, b) => a.ordinal - b.ordinal || a.title.localeCompare(b.title)),
    }));

    // A lesson the API left uncategorised still has to be reachable.
    const ungrouped = state.tutorials
      .filter((tutorial) => tutorial.categoryId === null)
      .sort((a, b) => a.ordinal - b.ordinal || a.title.localeCompare(b.title));

    return [
      ...byCategory.filter((group) => group.tutorials.length > 0),
      ...(ungrouped.length > 0 ? [{ category: null, tutorials: ungrouped }] : []),
    ];
  }, [state.categories, state.tutorials]);

  const total = groups.reduce((sum, group) => sum + group.tutorials.length, 0);
  const selectedCategory = selected
    ? state.categories.find((category) => category.id === selected.categoryId)?.name ?? "Other lessons"
    : "";

  return (
    <div className="tutorials-view">
      <header className="tutorials-header">
        <div>
          <span className="tutorials-eyebrow">Learn the game</span>
          <h2>Tutorials</h2>
        </div>
        {total > 0 && (
          <span className="muted tutorials-count">
            {total} {total === 1 ? "lesson" : "lessons"}
          </span>
        )}
      </header>

      {note && (
        // Retry lives here rather than as a permanent toolbar button: the list
        // is a near-static catalogue loaded once, so a refresh control only has
        // a job when the load actually failed.
        <p className="surface tutorials-state muted">
          <span>{note}</span>
          {state.status.type === "failed" && (
            <Button onClick={() => void load()}>
              <Icon name="refresh" size={15} /> Try again
            </Button>
          )}
        </p>
      )}

      {state.status.type === "ready" && total === 0 && (
        <p className="surface tutorials-state muted">
          <span>No tutorials are published right now.</span>
        </p>
      )}

      {total > 0 && (
        <div className="tutorials-body">
          <nav className="surface-panel tutorials-list" aria-label="Tutorials">
            {groups.map((group) => (
              <div className="tutorials-group" key={group.category?.id ?? "other"}>
                <h3 className="tutorials-group-name">
                  <span>{group.category?.name ?? "Other lessons"}</span>
                  <span>{group.tutorials.length}</span>
                </h3>
                {group.tutorials.map((tutorial) => (
                  <button
                    type="button"
                    key={tutorial.id}
                    className={
                      tutorial.id === state.selectedId
                        ? "tutorial-row is-active"
                        : "tutorial-row"
                    }
                    aria-current={tutorial.id === state.selectedId}
                    onClick={() => void select(tutorial.id)}
                  >
                    {tutorial.imageUrl ? (
                      <img className="tutorial-row-thumb" src={tutorial.imageUrl} alt="" loading="lazy" />
                    ) : (
                      <TutorialRowMark tutorial={tutorial} />
                    )}
                    <span className="tutorial-row-copy">
                      <strong>{tutorial.title || "Untitled"}</strong>
                      <small>{tutorialKind(tutorial)}</small>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {selected ? (
            <TutorialDetail tutorial={selected} categoryName={selectedCategory} />
          ) : (
            <p className="surface tutorials-state muted"><span>Select a tutorial.</span></p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Twin of `Tutorial::is_playable` in the domain. The server's `launchable`
 * flag is not enough on its own: without a map there is nothing to download,
 * and without a scenario name the game opens to its main menu: which looks
 * exactly like the client having done nothing.
 */
function isPlayable(tutorial: Tutorial): boolean {
  return tutorial.launchable && tutorial.mapFolderName !== "" && tutorial.technicalName !== "";
}

/** Twin of `Tutorial::is_link`: an entry pointing at a video or a wiki page. */
function isLink(tutorial: Tutorial): boolean {
  return !isPlayable(tutorial) && tutorial.linkUrl !== "";
}

function tutorialKind(tutorial: Tutorial): string {
  if (isPlayable(tutorial)) return "Playable lesson";
  if (isLink(tutorial)) return "External guide";
  return "Coming soon";
}

/**
 * What kind of entry a row is, as an icon rather than the old "unavailable"
 * label: which was attached to most of the list and described what the client
 * could not do rather than what the entry is.
 */
function TutorialRowMark({ tutorial }: { tutorial: Tutorial }) {
  if (isPlayable(tutorial)) {
    return (
      <span className="tutorial-row-mark is-playable" title="Playable lesson">
        <Icon name="play" size={13} />
      </span>
    );
  }
  if (isLink(tutorial)) {
    return (
      <span className="tutorial-row-mark" title="Opens in your browser">
        <Icon name="external" size={13} />
      </span>
    );
  }
  return <span className="tutorial-row-mark is-empty" title="Not available yet" aria-hidden />;
}

function TutorialDetail({ tutorial, categoryName }: { tutorial: Tutorial; categoryName: string }) {
  const launchState = useAppStore((store) => store.state.tutorials.launch);
  const playable = isPlayable(tutorial);
  const link = isLink(tutorial);

  // Only narrate progress for *this* lesson: the status is global, and
  // another lesson's "Updating tutorials…" under this title would be wrong.
  const preparing =
    launchState.type === "preparing" && launchState.payload.tutorialId === tutorial.id
      ? launchState.payload.detail
      : null;
  const launched =
    launchState.type === "launched" && launchState.payload.tutorialId === tutorial.id;

  return (
    <section className="surface-panel tutorial-detail">
      <div className="tutorial-detail-body">
        <div className="tutorial-detail-copy">
          <div className="tutorial-detail-kicker">
            <span>{categoryName}</span>
            <span aria-hidden>·</span>
            <span>{tutorialKind(tutorial)}</span>
          </div>
          <h3>{tutorial.title || "Untitled"}</h3>
          {tutorial.description
            ? <p className="tutorial-brief">{tutorial.description}</p>
            : <p className="muted tutorial-brief">No briefing was published for this lesson.</p>}

          {playable && (
            <dl className="tutorial-meta">
              <div><dt>Map</dt><dd>{tutorial.mapFolderName}</dd></div>
              <div><dt>Mode</dt><dd>Offline tutorial</dd></div>
            </dl>
          )}

          {/* Patching the tutorials mod and fetching the map is slow the first
              time; a silent client looks broken. */}
          {preparing !== null && <p className="muted tutorial-progress">{preparing}</p>}
          {launched && <p className="tutorial-progress is-ok">Forged Alliance is starting…</p>}
          {launchState.type === "failed" && (
            <p className="tutorial-progress is-error">{launchState.payload.reason}</p>
          )}

          {!playable && !link && (
            <p className="muted tutorial-brief">
              This lesson is listed but not yet playable: its map has not been published.
            </p>
          )}

          <div className="tutorial-actions">
            {link ? (
              <Button
                variant="primary"
                title={tutorial.linkUrl}
                onClick={() => ipc.run(openHttpsUrl(tutorial.linkUrl))}
              >
                <Icon name="external" size={16} /> Open guide
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!playable || preparing !== null}
                title={playable ? `Play ${tutorial.title}` : "This tutorial has no playable map yet"}
                onClick={() => void launch(tutorial.id)}
              >
                {preparing !== null ? "Preparing…" : <><Icon name="play" size={16} /> Start lesson</>}
              </Button>
            )}
            {playable && (
              <span className="muted tutorial-launch-note">
                Required game files and the map are prepared automatically.
              </span>
            )}
          </div>
        </div>

        <aside className="tutorial-detail-side">
          {tutorial.imageUrl ? (
            <img className="tutorial-art" src={tutorial.imageUrl} alt="" loading="lazy" />
          ) : (
            <div className="tutorial-art tutorial-art-empty" aria-hidden>
              <Icon name={link ? "external" : "maps"} size={28} />
            </div>
          )}

        </aside>
      </div>
    </section>
  );
}
