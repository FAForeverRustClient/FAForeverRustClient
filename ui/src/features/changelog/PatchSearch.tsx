import { memo, useMemo, useState, type FormEvent } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { StatusNotice } from "../../design-system/StatusNotice";
import type { ChangelogSearchMatch, ChangelogSearchState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { historicalKindKey, releaseLabel } from "./releasePresentation";

const EMPTY_SEARCH: ChangelogSearchState = { requestId: 0, query: "", status: { type: "idle" }, scanned: 0, total: 0, failed: 0, matches: [] };

const search = (query: string) => ipc.send({ kind: "Changelog", command: { type: "search", payload: { query } } });

const Excerpt = memo(function Excerpt({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return <>{text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) => index % 2
    ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>)}</>;
});

export function PatchSearch({ onChoose }: { onChoose: (match: ChangelogSearchMatch) => void }) {
  const { t } = useTranslation();
  const archive = useAppStore(store => store.state.changelog.search ?? EMPTY_SEARCH);
  const releases = useAppStore(store => store.state.changelog.releases);
  const releasesById = useMemo(() => new Map(releases.map(release => [release.id, release])), [releases]);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const loading = archive.status.type === "loading";
  const close = () => { setOpened(false); if (loading) search(""); };
  const submit = (event: FormEvent) => { event.preventDefault(); if (query.trim()) search(query); };

  return <>
    <Button className="changelog-archive-trigger" onClick={() => setOpened(true)}>
      <Icon name="search" size={16} />{t("changelog.archive.open")}
    </Button>
    {opened && <Modal className="changelog-archive" ariaLabel={t("changelog.archive.open")} onClose={close}>
      <h2>{t("changelog.archive.open")}</h2>
      <p className="changelog-archive-hint">{t("changelog.archive.hint")}</p>
      <form className="changelog-archive-form" onSubmit={submit}>
        <div className="search-field">
          <Icon name="search" size={16} />
          <input type="search" value={query} maxLength={128} aria-label={t("changelog.archive.open")}
            placeholder={t("changelog.archive.placeholder")} onChange={event => setQuery(event.target.value)} />
        </div>
        <Button type="submit" variant="primary" disabled={!query.trim()}>{t("changelog.archive.submit")}</Button>
        {loading && <Button onClick={() => search("")}>{t("changelog.archive.cancel")}</Button>}
      </form>
      <div className="changelog-archive-status" role="status">
        {loading ? (archive.total > 0
          ? t("changelog.archive.progress", { done: archive.scanned, total: archive.total })
          : t("changelog.archive.preparing"))
          : archive.query ? t("changelog.archive.count", { count: archive.matches.length }) : ""}
      </div>
      {archive.query && <p className="changelog-archive-hint">{t("changelog.archive.resultsFor", { query: archive.query })}</p>}
      {archive.status.type === "failed" && <StatusNotice tone="error" detail={archive.status.payload.reason}
        action={{ label: t("changelog.archive.submit"), onClick: () => search(archive.query) }}>{t("changelog.archive.failed")}</StatusNotice>}
      {archive.failed > 0 && <StatusNotice tone="info"
        action={{ label: t("changelog.archive.submit"), onClick: () => search(archive.query) }}>{t("changelog.archive.partial", { count: archive.failed })}</StatusNotice>}
      {archive.status.type === "ready" && !archive.matches.length && <p>{t("changelog.archive.empty")}</p>}
      <div className="changelog-archive-results">
        {archive.matches.map(match => {
          const release = releasesById.get(match.releaseId);
          const historical = release && historicalKindKey(release.kind);
          return <button key={match.releaseId} type="button" className="changelog-archive-result" onClick={() => { close(); onChoose(match); }}>
            <span className="changelog-archive-result-head"><strong>{releaseLabel(match.releaseId)}</strong>
              {historical && <span>{t(historical)}</span>}
              {release?.date && <time dateTime={release.date}>{release.date}</time>}
              <span>{t("changelog.archive.occurrences", { count: match.occurrences })}</span>
            </span>
            <span className="changelog-archive-excerpt"><Excerpt text={match.excerpt} query={archive.query} /></span>
          </button>;
        })}
      </div>
    </Modal>}
  </>;
}
