import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { StatusNotice } from "../../design-system/StatusNotice";
import type { ReportLogAttachment, ReportLogExcerpt } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { LoadStatusNotice } from "../../shared/components/LoadNotices";
import { formatDateTime } from "../../shared/format/dates";
import { plainError } from "../../shared/plainError";
import "./reporting.css";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const close = () => ipc.send({ kind: "Reporting", command: { type: "close" } });

const attachLog = (gameId: number | null) =>
  ipc.send({ kind: "Reporting", command: { type: "attachLog", payload: { gameId } } });

const detachLog = () => ipc.send({ kind: "Reporting", command: { type: "detachLog" } });

/**
 * The reporter's own words, as the client has always capped them
 * (`MAX_REPORT_TEXT_CHARS` in `faf-domain`'s `report_log.rs`). The API's
 * column holds far more; that room is what an attached game log goes in.
 */
const MAX_DESCRIPTION = 4_000;

/**
 * How long the game ID has to rest before a ticked log is read again for it.
 * Reading on every keystroke would read the file once per digit typed.
 */
const LOG_REREAD_DELAY_MS = 400;

/** The game ID an attachment was prepared or asked for; undefined when off. */
function attachmentGameId(attachment: ReportLogAttachment): number | null | undefined {
  switch (attachment.type) {
    case "off":
      return undefined;
    case "ready":
      return attachment.payload.excerpt.requestedGameId;
    default:
      return attachment.payload.gameId;
  }
}

export function ReportPlayerModal() {
  const { t } = useTranslation();
  const report = useAppStore((state) => state.state.reporting);
  const [description, setDescription] = useState("");
  const [gameId, setGameId] = useState("");
  const [incidentTime, setIncidentTime] = useState("");
  const [view, setView] = useState<"new" | "history">("new");
  const [excerptShown, setExcerptShown] = useState(false);
  const attachId = useId();

  useEffect(() => {
    if (!report.open) return;
    setDescription("");
    setGameId("");
    setIncidentTime("");
    setView("new");
    setExcerptShown(false);
  }, [report.login, report.open, report.playerId]);

  const parsedGameId = gameId.trim() ? Number(gameId) : null;
  // The game ID a log would be read for: null for none, undefined while what
  // is typed is not an ID at all (the form says so below).
  const logGameId =
    parsedGameId === null
      ? null
      : Number.isInteger(parsedGameId) && parsedGameId > 0
        ? parsedGameId
        : undefined;
  const attachment = report.logAttachment;
  const attached = attachment.type !== "off";
  const preparedFor = attachmentGameId(attachment);
  const excerpt = attachment.type === "ready" ? attachment.payload.excerpt : null;

  // A ticked log follows the game ID: the report should carry the log of the
  // game it names, and the preview has to show the one that would be sent.
  useEffect(() => {
    if (!attached || logGameId === undefined || preparedFor === logGameId) return;
    const timer = window.setTimeout(() => attachLog(logGameId), LOG_REREAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [attached, logGameId, preparedFor]);

  const validation = useMemo(() => {
    const length = description.trim().length;
    if (length > 0 && length < 10) return t("reporting.error.tooShort");
    if (length > MAX_DESCRIPTION) return t("reporting.error.tooLong");
    if (gameId.trim() && (!Number.isInteger(parsedGameId) || (parsedGameId ?? 0) <= 0)) {
      return t("reporting.error.gameId");
    }
    if (parsedGameId !== null && !incidentTime.trim()) {
      return t("reporting.error.gameTime");
    }
    return "";
  }, [description, gameId, incidentTime, parsedGameId, t]);

  if (!report.open || report.playerId === null) return null;
  const submitting = report.status.type === "submitting";
  const submitted = report.status.type === "submitted";
  const failure = report.status.type === "failed" ? report.status.payload.reason : "";
  // A ticked log goes only once the user has the excerpt for this very game
  // in front of them; the backend refuses anything else as well.
  const logReady = !attached || (excerpt !== null && excerpt.requestedGameId === logGameId);
  const canSubmit =
    description.trim().length >= 10 && !validation && !submitting && !submitted && logReady;

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
          attachLog: attached,
        },
      },
    });
  };

  return (
    <Modal
      onClose={() => { if (!submitting) void close(); }}
      className="report-player-modal"
      ariaLabel={t("reporting.reportPlayer", { name: report.login })}
    >
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <header className="report-player-head">
          <span className="report-player-eyebrow">{t("reporting.title")}</span>
          <h2>{t("reporting.reportPlayer", { name: report.login })}</h2>
          <p className="muted">
            {t("reporting.intro")}
          </p>
        </header>

        <div className="report-tabs" role="tablist" aria-label={t("reporting.reportingViews")}>
          <button type="button" role="tab" aria-selected={view === "new"} className={view === "new" ? "active" : ""} onClick={() => setView("new")}>{t("reporting.tab.new")}</button>
          <button type="button" role="tab" aria-selected={view === "history"} className={view === "history" ? "active" : ""} onClick={() => setView("history")}>{t("reporting.tab.history")} <span>{report.history.length}</span></button>
        </div>

        {view === "history" ? (
          <section className="report-history" role="tabpanel">
            {report.historyStatus.type === "loading" && <p className="muted" role="status">{t("reporting.historyLoading")}</p>}
            {/* Said plainly, with the system's wording on hover for a bug
                report, and Retry beside it as every load failure has. */}
            <LoadStatusNotice
              status={report.historyStatus}
              failed={t("reporting.historyFailed")}
              onRetry={() => ipc.send({ kind: "Reporting", command: { type: "loadHistory" } })}
            />
            {report.historyStatus.type === "ready" && report.history.length === 0 && <p className="muted">{t("reporting.historyEmpty")}</p>}
            {report.history.map((item) => (
              <article className="report-history-card surface" key={item.id}>
                <header>
                  <div><strong>{t("reporting.historyItem", { id: item.id })}</strong><time dateTime={item.createTime}>{formatDateTime(item.createTime)}</time></div>
                  <span className="report-history-status">{item.status || t("reporting.statusFallback")}</span>
                </header>
                <dl>
                  <div><dt>{t("reporting.offender")}</dt><dd>{item.offenders.join(", ") || t("common.unknown")}</dd></div>
                  <div><dt>{t("reporting.game")}</dt><dd>{item.gameId ? `#${item.gameId}` : t("reporting.notGameRelated")}</dd></div>
                  <div><dt>{t("reporting.moderator")}</dt><dd>{item.moderator || t("reporting.unassigned")}</dd></div>
                </dl>
                <p>{item.description}</p>
                {item.attachedLog && <AttachedLog log={item.attachedLog} />}
                {item.moderatorNotice && <aside><strong>{t("reporting.moderatorNotice")}</strong><span>{item.moderatorNotice}</span></aside>}
              </article>
            ))}
          </section>
        ) : submitted ? (
          <div className="report-success" role="status">
            <strong>{t("reporting.submitted")}</strong>
            <span>{t("reporting.submittedHint")}</span>
          </div>
        ) : (
          <>
            <label className="report-field">
              <span>{t("reporting.whatHappened")} <em>{t("reporting.required")}</em></span>
              <textarea
                autoFocus
                value={description}
                maxLength={MAX_DESCRIPTION}
                rows={7}
                disabled={submitting}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("reporting.describeBehaviorContext")}
              />
              <small>{t("reporting.characterCount", { count: description.length, max: formatNumber(MAX_DESCRIPTION) })}</small>
            </label>
            <div className="report-game-fields">
              <label className="report-field">
                <span>{t("reporting.gameId")} <em>{t("reporting.optional")}</em></span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={gameId}
                  disabled={submitting}
                  onChange={(event) => setGameId(event.target.value)}
                  placeholder={t("reporting.eG12345678")}
                />
              </label>
              <label className="report-field">
                <span>{t("reporting.gameTime")} {gameId.trim() ? <em>{t("reporting.required")}</em> : <em>{t("reporting.optional")}</em>}</span>
                <input
                  value={incidentTime}
                  disabled={submitting}
                  onChange={(event) => setIncidentTime(event.target.value)}
                  placeholder={t("reporting.eG18")}
                />
              </label>
            </div>
            {/* Opt-in, and shown before it is sent: FAF reports take no
                files, so the log goes in as text, and the user reads the
                exact text first. */}
            <section className="report-attach" aria-labelledby={`${attachId}-label`}>
              <label className="report-attach-toggle">
                <input
                  type="checkbox"
                  checked={attached}
                  disabled={submitting}
                  aria-describedby={`${attachId}-hint`}
                  onChange={(event) => {
                    setExcerptShown(false);
                    if (event.target.checked) attachLog(logGameId ?? null);
                    else detachLog();
                  }}
                />
                <span id={`${attachId}-label`}>{t("reporting.attachLog")}</span>
              </label>
              <p className="report-attach-hint" id={`${attachId}-hint`}>{t("reporting.attachLogHint")}</p>
              {attachment.type === "preparing" && (
                <StatusNotice tone="busy">{t("reporting.attachLogPreparing")}</StatusNotice>
              )}
              {attachment.type === "unavailable" && (
                <StatusNotice tone="info">{t("reporting.attachLogNone")}</StatusNotice>
              )}
              {attachment.type === "failed" && (
                <StatusNotice
                  tone="error"
                  action={{ label: t("common.retry"), onClick: () => attachLog(logGameId ?? null) }}
                  detail={attachment.payload.reason}
                >
                  {t("reporting.attachLogFailed")}: {plainError(attachment.payload.reason)}
                </StatusNotice>
              )}
              {excerpt && (
                <ExcerptPreview
                  excerpt={excerpt}
                  shown={excerptShown}
                  onToggle={() => setExcerptShown((shown) => !shown)}
                  previewId={`${attachId}-excerpt`}
                />
              )}
            </section>
            {/* The server's refusal plainly, its own wording on hover; the
                form's own checks are already sentences. */}
            {(validation || failure) && (
              <p className="report-error" role="alert" title={failure || undefined}>
                {failure ? `${t("reporting.submitFailed")}: ${plainError(failure)}` : validation}
              </p>
            )}
          </>
        )}

        <footer className="report-actions">
          <Button type="button" onClick={() => void close()} disabled={submitting}>
            {t(submitted ? "common.close" : "common.cancel")}
          </Button>
          {view === "new" && !submitted && <Button type="submit" variant="primary" disabled={!canSubmit}>
            {t(submitting ? "reporting.submitting" : "reporting.submit")}
          </Button>}
        </footer>
      </form>
    </Modal>
  );
}

/**
 * Which log the excerpt is from, what it holds, and the excerpt itself on
 * request: the exact text the report will carry, not a summary of it.
 */
function ExcerptPreview({
  excerpt,
  shown,
  onToggle,
  previewId,
}: {
  excerpt: ReportLogExcerpt;
  shown: boolean;
  onToggle: () => void;
  previewId: string;
}) {
  const { t } = useTranslation();
  const ofReportedGame =
    excerpt.logGameId !== null && excerpt.logGameId === excerpt.requestedGameId;
  const source = ofReportedGame
    ? t("reporting.attachLogSource.game", { id: excerpt.logGameId ?? "" })
    : excerpt.logGameId !== null
      ? t("reporting.attachLogSource.latest", { id: excerpt.logGameId })
      : t("reporting.attachLogSource.latestUnknown");
  // Said in words when the log is not of the game the report names: the
  // most recent game is a guess the user should be able to refuse.
  const otherGame = excerpt.requestedGameId !== null && !ofReportedGame;
  return (
    <div className="report-attach-preview">
      <div className="report-attach-summary">
        <div>
          <strong>{source}</strong>
          <span>
            {t("reporting.attachLogStats", {
              // Characters as the backend counts them, so the number matches
              // the limit it keeps to.
              chars: formatNumber(Array.from(excerpt.block).length),
              kept: formatNumber(excerpt.keptLines),
              total: formatNumber(excerpt.totalLines),
              redacted: formatNumber(excerpt.redactions),
            })}
          </span>
        </div>
        <Button aria-expanded={shown} aria-controls={previewId} onClick={onToggle}>
          {t(shown ? "reporting.attachLogHide" : "reporting.attachLogShow")}
        </Button>
      </div>
      {otherGame && (
        <p className="report-attach-warning">
          {t("reporting.attachLogOtherGame", { id: excerpt.requestedGameId ?? "" })}
        </p>
      )}
      {shown && (
        <pre
          id={previewId}
          className="report-attach-excerpt"
          tabIndex={0}
          aria-label={t("reporting.attachLogPreview")}
        >
          {excerpt.block}
        </pre>
      )}
    </div>
  );
}

/**
 * A game log excerpt this client attached to an earlier report, folded away
 * so a card in the history stays a card.
 */
function AttachedLog({ log }: { log: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="report-history-log">
      <Button aria-expanded={shown} aria-controls={id} onClick={() => setShown(!shown)}>
        {t(shown ? "reporting.historyLogHide" : "reporting.historyLogShow")}
      </Button>
      {shown && (
        <pre id={id} className="report-attach-excerpt" tabIndex={0}>
          {log}
        </pre>
      )}
    </div>
  );
}
