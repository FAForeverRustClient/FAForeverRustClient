import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { formatDateTime } from "../../shared/dates";
import "./reporting.css";

const close = () => ipc.send({ kind: "Reporting", command: { type: "close" } });

export function ReportPlayerModal() {
  const report = useAppStore((state) => state.state.reporting);
  const [description, setDescription] = useState("");
  const [gameId, setGameId] = useState("");
  const [incidentTime, setIncidentTime] = useState("");
  const [view, setView] = useState<"new" | "history">("new");

  useEffect(() => {
    if (!report.open) return;
    setDescription("");
    setGameId("");
    setIncidentTime("");
    setView("new");
  }, [report.login, report.open, report.playerId]);

  const parsedGameId = gameId.trim() ? Number(gameId) : null;
  const validation = useMemo(() => {
    const length = description.trim().length;
    if (length > 0 && length < 10) return "Please describe the incident in at least 10 characters.";
    if (length > 4_000) return "The description cannot exceed 4,000 characters.";
    if (gameId.trim() && (!Number.isInteger(parsedGameId) || (parsedGameId ?? 0) <= 0)) {
      return "Game ID must be a positive whole number.";
    }
    if (parsedGameId !== null && !incidentTime.trim()) {
      return "Add the approximate in-game time for a game-related report.";
    }
    return "";
  }, [description, gameId, incidentTime, parsedGameId]);

  if (!report.open || report.playerId === null) return null;
  const submitting = report.status.type === "submitting";
  const submitted = report.status.type === "submitted";
  const failure = report.status.type === "failed" ? report.status.payload.reason : "";
  const canSubmit = description.trim().length >= 10 && !validation && !submitting && !submitted;

  const submit = () => {
    if (!canSubmit || report.playerId === null) return;
    ipc.send({
      kind: "Reporting",
      command: {
        type: "submit",
        payload: {
          playerId: report.playerId,
          login: report.login,
          description: description.trim(),
          gameId: parsedGameId,
          incidentTime: incidentTime.trim(),
        },
      },
    });
  };

  return (
    <Modal onClose={() => { if (!submitting) void close(); }} className="report-player-modal">
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <header className="report-player-head">
          <span className="report-player-eyebrow">Moderation report</span>
          <h2>Report {report.login}</h2>
          <p className="muted">
            Reports go to the FAF moderation team. Include objective details and only submit one report per incident.
          </p>
        </header>

        <div className="report-tabs" role="tablist" aria-label="Reporting views">
          <button type="button" role="tab" aria-selected={view === "new"} className={view === "new" ? "active" : ""} onClick={() => setView("new")}>New report</button>
          <button type="button" role="tab" aria-selected={view === "history"} className={view === "history" ? "active" : ""} onClick={() => setView("history")}>Previous reports <span>{report.history.length}</span></button>
        </div>

        {view === "history" ? (
          <section className="report-history" role="tabpanel">
            {report.historyStatus.type === "loading" && <p className="muted" role="status">Loading your reports…</p>}
            {report.historyStatus.type === "failed" && (
              <div className="report-history-error" role="alert">
                <span>{report.historyStatus.payload.reason}</span>
                <Button type="button" onClick={() => ipc.send({ kind: "Reporting", command: { type: "loadHistory" } })}>Retry</Button>
              </div>
            )}
            {report.historyStatus.type === "ready" && report.history.length === 0 && <p className="muted">You have not submitted any reports.</p>}
            {report.history.map((item) => (
              <article className="report-history-card surface" key={item.id}>
                <header>
                  <div><strong>Report #{item.id}</strong><time dateTime={item.createTime}>{formatDateTime(item.createTime)}</time></div>
                  <span className="report-history-status">{item.status || "Submitted"}</span>
                </header>
                <dl>
                  <div><dt>Offender</dt><dd>{item.offenders.join(", ") || "Unknown"}</dd></div>
                  <div><dt>Game</dt><dd>{item.gameId ? `#${item.gameId}` : "Not game-related"}</dd></div>
                  <div><dt>Moderator</dt><dd>{item.moderator || "Unassigned"}</dd></div>
                </dl>
                <p>{item.description}</p>
                {item.moderatorNotice && <aside><strong>Moderator notice</strong><span>{item.moderatorNotice}</span></aside>}
              </article>
            ))}
          </section>
        ) : submitted ? (
          <div className="report-success" role="status">
            <strong>Report submitted</strong>
            <span>The moderation team will review it. You do not need to report the same incident again.</span>
          </div>
        ) : (
          <>
            <label className="report-field">
              <span>What happened? <em>Required</em></span>
              <textarea
                autoFocus
                value={description}
                maxLength={4_000}
                rows={7}
                disabled={submitting}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the behavior, context, and relevant evidence…"
              />
              <small>{description.length} / 4,000 characters</small>
            </label>
            <div className="report-game-fields">
              <label className="report-field">
                <span>Game ID <em>Optional</em></span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={gameId}
                  disabled={submitting}
                  onChange={(event) => setGameId(event.target.value)}
                  placeholder="e.g. 12345678"
                />
              </label>
              <label className="report-field">
                <span>Approximate in-game time {gameId.trim() ? <em>Required</em> : <em>Optional</em>}</span>
                <input
                  value={incidentTime}
                  disabled={submitting}
                  onChange={(event) => setIncidentTime(event.target.value)}
                  placeholder="e.g. 18:30"
                />
              </label>
            </div>
            {(validation || failure) && <p className="report-error" role="alert">{failure || validation}</p>}
          </>
        )}

        <footer className="report-actions">
          <Button type="button" onClick={() => void close()} disabled={submitting}>
            {submitted ? "Close" : "Cancel"}
          </Button>
          {view === "new" && !submitted && <Button type="submit" variant="primary" disabled={!canSubmit}>
            {submitting ? "Submitting…" : "Submit report"}
          </Button>}
        </footer>
      </form>
    </Modal>
  );
}
