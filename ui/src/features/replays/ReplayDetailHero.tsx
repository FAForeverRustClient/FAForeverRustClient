// The replay detail panel's map-facing parts: the hero across the top, and
// the enlarged map preview it opens.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import type { VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { MapPreviewFrame } from "../../shared/components/MapPreviewZoom";
import { onlineReplayLink } from "../../shared/replayLinks";
import { ReplayMapThumb } from "./ReplayCard";
import type { ReplayMapPreparation } from "./useReplayMapPreparation";

interface HeroProps {
  replay: VaultReplay;
  busy: boolean;
  onWatch: () => void;
  map: Pick<ReplayMapPreparation, "effectiveMap" | "seed" | "thumbGenerateAction" | "isGeneratingThisMap" | "downloadMap">;
  mapLabel: string;
  cardTitle: string;
  copiedMapName: boolean;
  onCopyMapName: () => void;
  onEnlarge: () => void;
}

export function ReplayDetailHero({
  replay,
  busy,
  onWatch,
  map,
  mapLabel,
  cardTitle,
  copiedMapName,
  onCopyMapName,
  onEnlarge,
}: HeroProps) {
  const { t } = useTranslation();
  const { effectiveMap, seed, thumbGenerateAction, isGeneratingThisMap, downloadMap } = map;
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  const copyLink = () =>
    ipc.run(
      navigator.clipboard
        .writeText(onlineReplayLink(replay.uid))
        .then(() => setCopied(true)),
    );
  const copyReplayId = () =>
    ipc.run(
      navigator.clipboard
        .writeText(String(replay.uid))
        .then(() => setCopiedId(true)),
    );

  return (
    <header className="replay-detail-hero">
      <div className="replay-detail-hero-backdrop" aria-hidden>
        <ReplayMapThumb
          url={replay.mapThumbnailUrl}
          mapName={effectiveMap}
          className="replay-detail-hero-image"
          emptyClassName="replay-detail-hero-image-empty"
          iconSize={16}
          large
        />
      </div>
      {/* A picture to recognise the map by, and a way to look at it
          properly: clicking opens the same zoom frame the Play and Maps tabs
          use. It is not a zoom widget in place, because a wheel handler over
          it swallowed the scroll of the dialog behind. */}
      <div className="replay-detail-thumb-frame">
        <button
          type="button"
          className="replay-detail-thumb-open"
          onClick={onEnlarge}
          title={t("maps.preview.enlarge", { name: mapLabel })}
          aria-label={t("maps.preview.enlarge", { name: mapLabel })}
        >
          <ReplayMapThumb
            url={replay.mapThumbnailUrl}
            mapName={effectiveMap}
            className="replay-detail-thumb"
            emptyClassName="replay-detail-thumb-empty"
            iconSize={40}
            large
          />
          <span className="replay-detail-thumb-zoom" aria-hidden>
            <Icon name="search" size={14} />
          </span>
        </button>
        {/* Beside the preview button rather than inside it, since a button
            cannot hold another. */}
        {thumbGenerateAction && (
          <button
            type="button"
            className="replay-detail-thumb-generate"
            disabled={thumbGenerateAction.disabled}
            onClick={thumbGenerateAction.run}
            title={thumbGenerateAction.label}
            aria-label={thumbGenerateAction.label}
          >
            <Icon
              name={thumbGenerateAction.icon as IconName}
              size={14}
              className={isGeneratingThisMap ? "spin" : undefined}
            />
          </button>
        )}
      </div>

      <div className="replay-detail-headtext">
        {/* The number people quote at each other, and the two things done
            with it: copy the number, copy the link. */}
        <div className="replay-detail-eyebrow">
          {replay.uid > 0 ? (
            <>
              <span className="replay-detail-id">#{replay.uid}</span>
              <button
                type="button"
                className="replay-card-icon-btn"
                aria-label={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
                title={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
                onClick={copyReplayId}
              >
                <Icon name={copiedId ? "check" : "copy"} size={13} />
              </button>
              <button
                type="button"
                className="replay-card-icon-btn"
                aria-label={t(copied ? "replays.detail.copiedShort" : "replays.detail.copyLink")}
                title={t(copied ? "replays.detail.copiedShort" : "replays.detail.copyLink")}
                onClick={copyLink}
              >
                <Icon name={copied ? "check" : "external"} size={13} />
              </button>
            </>
          ) : (
            <span>{t("replays.local.noReplayId")}</span>
          )}
        </div>
        <h2 title={cardTitle}>{cardTitle}</h2>
        <div className="replay-detail-map">
          <Icon name="maps" size={15} />
          <span className="replay-detail-map-name">{mapLabel}</span>
          {/* A generated map's whole name, copied rather than shown. It is
              `neroxis_map_generator_<version>_<seed>_<options>` and all three
              parts are needed to rebuild it: the same seed under a different
              version is a different map, and the generator dialog's
              Reproduce field rejects a bare seed. Printed out it was three
              lines of Base32 nobody reads; the tooltip and the enlarged
              preview both show it in full. */}
          {seed && (
            <button
              type="button"
              className="replay-card-icon-btn"
              aria-label={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
              title={copiedMapName
                ? t("lobby.browser.mapNameCopied")
                : `${t("lobby.browser.copyMapName")}\n${effectiveMap}`}
              onClick={onCopyMapName}
            >
              <Icon name={copiedMapName ? "check" : "copy"} size={13} />
            </button>
          )}
          {downloadMap && (
            <Button className="replay-detail-map-action" onClick={downloadMap}>
              <Icon name="download" size={13} />
              <span>{t("lobby.details.downloadMap")}</span>
            </Button>
          )}
        </div>
        {!replay.replayAvailable && (
          <div className="replay-detail-badges">
            <span className="replay-availability pending">{t("replays.detail.processing")}</span>
          </div>
        )}
      </div>

      {/* The way in, large, on the right of the hero. */}
      <Button
        className="replay-watch-button replay-detail-hero-watch"
        variant="primary"
        disabled={busy || !replay.replayAvailable}
        onClick={onWatch}
      >
        <Icon name="play" size={18} />
        <span>{t(replay.replayAvailable ? "replays.detail.watch" : "replays.detail.notUploaded")}</span>
      </Button>
    </header>
  );
}

interface PreviewProps {
  mapThumbnailUrl: string;
  effectiveMap: string;
  mapLabel: string;
  cardTitle: string;
  copiedMapName: boolean;
  onCopyMapName: () => void;
  onClose: () => void;
}

/**
 * The enlarged preview, in the panel's own markup rather than in a second
 * `Modal`. It covers the viewport the way a dialog would, and leaves the same
 * three ways out: the button, the scrim, and Escape (the panel's overlay
 * layer).
 */
export function ReplayMapPreviewOverlay({
  mapThumbnailUrl,
  effectiveMap,
  mapLabel,
  cardTitle,
  copiedMapName,
  onCopyMapName,
  onClose,
}: PreviewProps) {
  const { t } = useTranslation();
  return (
    <div
      className="replay-preview-scrim"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="replay-preview-overlay"
        role="dialog"
        aria-label={t("maps.preview.enlarge", { name: mapLabel })}
        onClick={(event) => event.stopPropagation()}
      >
        {/* The same frame the Play tab and the Maps tab open a map in, so
            a preview looks like a preview wherever it was reached from.
            The technical name under it is what the Play tab's preview has
            too. */}
        <MapPreviewFrame
          kicker={t("lobby.browser.mapPreview")}
          title={mapLabel}
          subtitle={cardTitle === mapLabel ? undefined : cardTitle}
          onClose={onClose}
          footer={effectiveMap ? (
            <div className="replay-preview-overlay-name">
              <span>{t("lobby.browser.mapFullName")}</span>
              <code>{effectiveMap}</code>
              <button
                type="button"
                className="replay-card-icon-btn"
                aria-label={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                title={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                onClick={onCopyMapName}
              >
                <Icon name={copiedMapName ? "check" : "copy"} size={13} />
              </button>
            </div>
          ) : null}
        >
          <ReplayMapThumb
            url={mapThumbnailUrl}
            mapName={effectiveMap}
            className="replay-preview-overlay-image"
            emptyClassName="replay-detail-thumb-empty"
            iconSize={64}
            large
          />
        </MapPreviewFrame>
      </div>
    </div>
  );
}
