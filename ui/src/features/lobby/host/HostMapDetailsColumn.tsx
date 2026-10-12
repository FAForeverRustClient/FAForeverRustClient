// The host dialog's last column: the chosen map's picture, name, facts and
// description, and the delete button for a map that is on disk.

import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import type { VaultMap } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { generatedMapDescriptionRows } from "../../../shared/generatedMapDescription";
import { useTranslation } from "../../../i18n/useTranslation";
import { GameMapImage } from "../GameMapImage";
import { formatMapDimensions, type HostMap } from "./hostMapCatalogue";

interface Props {
  chosen: HostMap | undefined;
  vault: VaultMap[];
  canUninstall: boolean;
  onEnlarge: () => void;
  onUninstall: (map: HostMap) => void;
}

/** Memoised: its props change with the selection, not with the form beside it. */
export const HostMapDetailsColumn = memo(function HostMapDetailsColumn({
  chosen,
  vault,
  canUninstall,
  onEnlarge,
  onUninstall,
}: Props) {
  const { t } = useTranslation();
  const [copiedTitle, setCopiedTitle] = useState(false);

  // Reset by itself, so the tick is feedback rather than a state the button
  // gets stuck in.
  useEffect(() => {
    if (!copiedTitle) return;
    const timer = window.setTimeout(() => setCopiedTitle(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copiedTitle]);

  // Empty for every map whose description is prose, which is every map that
  // was not generated. Memoised on the description alone: reparsing it on each
  // keystroke in the map filter would be work for nothing.
  const generatorFacts = useMemo(
    () => generatedMapDescriptionRows(chosen?.description, t),
    [chosen?.description, t],
  );

  return (
    <section className="host-column host-column-preview surface-panel">
      <div className="host-column-header">
        <h3>
          <Icon name="info" size={14} />
          {t("lobby.host.selectedMap")}
        </h3>
      </div>

      <div className="host-column-body host-preview-body">
        <div className="host-preview-thumb-wrap">
          {chosen ? (
            <button
              type="button"
              className="host-preview-button"
              onClick={onEnlarge}
              title={t("maps.preview.enlarge", { name: chosen.displayName })}
              aria-label={t("maps.preview.enlarge", { name: chosen.displayName })}
            >
              <GameMapImage
                mapName={chosen.folderName}
                vault={vault}
                className="host-preview-img"
                placeholderClassName="host-preview-placeholder"
                large
              />
            </button>
          ) : (
            <div className="host-preview-placeholder">
              <Icon name="maps" size={32} />
            </div>
          )}
        </div>

        {/* The name, under the picture rather than printed over it. The
            overlay dimmed the corner of every preview to repeat a name the
            row below already carried, which is the part of the map a
            reader is most likely to be looking at. The button copies what
            is written here: the map's name as everyone says it, not the
            folder it happens to live in, which is the row below. */}
        <div className="host-preview-name">
          <span title={chosen?.displayName ?? t("lobby.host.selectMap")}>
            {chosen?.displayName ?? t("lobby.host.selectMap")}
          </span>
          {chosen && (
            <button
              type="button"
              className="host-map-fullname-copy"
              aria-label={t(
                copiedTitle ? "lobby.host.mapTitleCopied" : "lobby.host.copyMapTitle",
              )}
              title={t(copiedTitle ? "lobby.host.mapTitleCopied" : "lobby.host.copyMapTitle")}
              onClick={() =>
                ipc.run(
                  navigator.clipboard
                    .writeText(chosen.displayName)
                    .then(() => setCopiedTitle(true)),
                )
              }
            >
              <Icon name={copiedTitle ? "check" : "copy"} size={13} />
            </button>
          )}
          {/* Whether a game on this map is rated, at the end of the map's
              name: the one property of a map that changes what hosting it
              means. A tag like every other tag in the client, quiet for the
              usual case and in the error tint when the map is unranked, as
              on a game's tile. It was a green capsule. */}
          {chosen && (
            <span
              className={chosen.ranked ? "host-map-ranked" : "host-map-ranked is-unranked"}
              title={t(chosen.ranked ? "maps.view.ranked" : "maps.view.unranked")}
            >
              {t(chosen.ranked ? "maps.view.ranked" : "maps.view.unranked")}
            </span>
          )}
        </div>

        {chosen && (
          <div className="host-map-info-section">
            {/* The four facts as one list of label and value, the shape a
                generated map's settings take below. They were icons beside
                values, and two had no icon to give: the author borrowed the
                edit pencil and the version a bold letter "V". */}
            <dl className="host-map-facts host-map-basic-facts">
              <dt>{t("lobby.browser.players")}</dt>
              <dd>{chosen.maxPlayers > 0 ? chosen.maxPlayers : t("common.notAvailable")}</dd>
              <dt>{t("lobby.browser.mapSize")}</dt>
              <dd>
                {chosen.width > 0
                  ? formatMapDimensions(chosen.width, chosen.height)
                  : t("common.notAvailable")}
              </dd>
              {(chosen.version || chosen.author) && (
                <>
                  <dt>{t("lobby.host.mapAuthor")}</dt>
                  <dd title={chosen.author || undefined}>{chosen.author || t("lobby.host.mapAuthorUnknown")}</dd>
                  <dt>{t("lobby.host.mapVersion")}</dt>
                  <dd>{chosen.version || t("lobby.host.mapAuthorUnknown")}</dd>
                </>
              )}
            </dl>
            {/* A generated map's description is not prose: it is the
                generator's parameter dump, one line, with its escapes
                unexpanded and `null` wherever it had nothing to say.
                Rendering it verbatim is what put one unbroken line of
                visible escapes, a repeated seed and two styles under the
                preview. Parsed, it is the most complete answer anywhere
                in the client to "what settings made this map": the folder
                name encodes the style that was asked for, this records
                what it resolved to. A real description stays prose. */}
            {generatorFacts.length > 0 ? (
              <dl className="host-map-facts host-map-generator-facts">
                {generatorFacts.map((row) => (
                  <Fragment key={row.key}>
                    <dt>{row.label}</dt>
                    <dd title={row.value}>{row.value}</dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              chosen.description && (
                <p className="host-map-description">{chosen.description}</p>
              )
            )}
            {/* Under the description, which is as far from the map list as
                this column goes: picking through a few hundred maps for
                something to host is exactly when a delete button near the
                rows would get hit by accident. Only for a map that is on
                disk and not part of the game. */}
            {canUninstall && (
              <button
                type="button"
                className="host-map-delete"
                onClick={() => onUninstall(chosen)}
              >
                <Icon name="trash" size={13} />
                {t("lobby.host.deleteMap")}
              </button>
            )}
          </div>
        )}
      </div>

    </section>
  );
});
