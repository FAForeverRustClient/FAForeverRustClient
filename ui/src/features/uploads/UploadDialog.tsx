// Publishing a local map or mod to the vault.
//
// Mirrors the reference clients' upload widgets: confirm what is being
// published, set the ranked flag (maps only: mods have no equivalent in
// either client), then watch the two stages go by.

import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { UploadKind, UploadsState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { isUploadBusy } from "../../store/reducers/uploads";
import { useAppStore } from "../../store/store";
import "./uploads.css";

export const openUpload = (kind: UploadKind, folderName: string, displayName: string) =>
  ipc.send({
    kind: "Uploads",
    command: { type: "open", payload: { request: { kind, folderName, displayName, ranked: false } } },
  });

const close = () => ipc.send({ kind: "Uploads", command: { type: "close" } });
const setRanked = (ranked: boolean) =>
  ipc.send({ kind: "Uploads", command: { type: "setRanked", payload: { ranked } } });
const start = () => ipc.send({ kind: "Uploads", command: { type: "start" } });

function statusLine(status: UploadsState["status"]): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "compressing":
      return "Compressing the folder…";
    case "uploading": {
      const { sentBytes, totalBytes } = status.payload;
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      return sentBytes >= totalBytes && totalBytes > 0
        ? `Uploaded ${mb} MB.`
        : `Uploading ${mb} MB…`;
    }
    case "finishing":
      return "Registering it with the vault…";
    case "succeeded":
      return null;
    case "failed":
      return status.payload.reason;
  }
}

export function UploadDialog() {
  const { request, status } = useAppStore((store) => store.state.uploads);
  if (request === null) return null;

  const busy = isUploadBusy(status);
  const done = status.type === "succeeded";
  const line = statusLine(status);

  return (
    <Modal className="upload-dialog" onClose={close}>
      <h2>Publish {request.kind === "map" ? "map" : "mod"}</h2>
      <p className="muted">
        “{request.displayName}” will be compressed and uploaded to the FAF vault under your
        account, where everyone can download it.
      </p>
      <p className="upload-folder muted">{request.folderName}</p>

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
          Allow ranked games on this map
        </label>
      )}

      {done && <p className="upload-status is-ok">Published. It may take a moment to appear.</p>}
      {line && (
        <p className={status.type === "failed" ? "upload-status is-error" : "upload-status muted"}>
          {line}
        </p>
      )}

      <div className="upload-actions">
        <Button onClick={close}>{done ? "Close" : "Cancel"}</Button>
        {!done && (
          <Button variant="primary" disabled={busy} onClick={start}>
            {busy ? "Publishing…" : "Publish"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
