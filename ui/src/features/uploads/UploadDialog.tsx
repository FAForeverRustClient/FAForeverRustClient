// Publishing a local map or mod to the vault.
//
// Mirrors the reference clients' upload widgets: confirm what is being
// published, set the ranked flag (maps only: mods have no equivalent in
// either client), then watch the two stages go by.

import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { UploadKind, UploadsState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { isUploadBusy } from "../../store/reducers/uploads";
import { useAppStore } from "../../store/store";
import "./uploads.css";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";

export const openUpload = (kind: UploadKind, folderName: string, displayName: string) =>
  ipc.send({
    kind: "Uploads",
    command: {
      type: "open",
      payload: { request: { kind, folderName, displayName, ranked: false, sourcePath: null } },
    },
  });

/** The last path segment, for either separator: Windows gives back backslashes. */
const folderNameOf = (path: string): string =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

/**
 * Publish a folder picked from disk rather than one the client installed.
 *
 * Java's equivalent entry point is `MapUploadController.setMapPath`, reached
 * from the vault rather than from the installed list: a map being published is
 * usually one the author just built, which by definition is not in the vault
 * yet. The backend does the real validation; this only refuses a path with no
 * usable last segment, which a picker should never return.
 */
export async function openUploadFromDisk(kind: UploadKind): Promise<void> {
  const path = await native.selectFile({
    directory: true,
    title: t(kind === "map" ? "uploads.pick.map" : "uploads.pick.mod"),
  });
  if (path === null) return;
  const folderName = folderNameOf(path);
  if (folderName === "") return;
  ipc.send({
    kind: "Uploads",
    command: {
      type: "open",
      payload: {
        request: { kind, folderName, displayName: folderName, ranked: false, sourcePath: path },
      },
    },
  });
}

const close = () => ipc.send({ kind: "Uploads", command: { type: "close" } });
const setRanked = (ranked: boolean) =>
  ipc.send({ kind: "Uploads", command: { type: "setRanked", payload: { ranked } } });
const start = () => ipc.send({ kind: "Uploads", command: { type: "start" } });

function statusLine(status: UploadsState["status"]): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "compressing":
      return t("uploads.compressing");
    case "uploading": {
      const { sentBytes, totalBytes } = status.payload;
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      return sentBytes >= totalBytes && totalBytes > 0
        ? t("uploads.uploaded", { mb })
        : t("uploads.uploading", { mb });
    }
    case "finishing":
      return t("uploads.registering");
    case "succeeded":
      return null;
    case "failed":
      return status.payload.reason;
  }
}

export function UploadDialog() {
  useLocale();
  const { request, status } = useAppStore((store) => store.state.uploads);
  if (request === null) return null;

  const busy = isUploadBusy(status);
  const done = status.type === "succeeded";
  const line = statusLine(status);

  return (
    <Modal className="upload-dialog" onClose={close}>
      <h2>{t(request.kind === "map" ? "uploads.title.map" : "uploads.title.mod")}</h2>
      <p className="muted">
        {t("uploads.description", { name: request.displayName })}
      </p>
      {/* The full path when it was picked from disk: the folder name alone is
          not enough to tell two copies apart. */}
      <p className="upload-folder muted">{request.sourcePath ?? request.folderName}</p>

      {/* Maps only: the ranked flag decides whether games on it affect
          ratings. Neither reference client offers an equivalent for mods. */}
      {request.kind === "map" && (
        <label className="check-field">
          <input
            type="checkbox"
            checked={request.ranked}
            disabled={busy || done}
            onChange={(event) => setRanked(event.target.checked)}
          />
          {t("uploads.allowRanked")}
        </label>
      )}

      {done && <p className="upload-status is-ok">{t("uploads.published")}</p>}
      {line && (
        <p className={status.type === "failed" ? "upload-status is-error" : "upload-status muted"}>
          {line}
        </p>
      )}

      <div className="upload-actions">
        <Button onClick={close}>{t(done ? "uploads.close" : "uploads.cancel")}</Button>
        {!done && (
          <Button variant="primary" disabled={busy} onClick={start}>
            {t(busy ? "uploads.publishing" : "uploads.publish")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
