// The single bridge for desktop-shell capabilities that are not domain commands.
// Feature code stays unaware of Tauri packages, which keeps it browser-testable
// and gives architecture checks one explicit native boundary to enforce.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";

export type LogKind = "game" | "client";

export interface LogPreview {
  fileName: string;
  content: string;
}

export const native = {
  openLogFolder(kind: LogKind): Promise<void> {
    return invoke("open_log_folder", { kind });
  },

  readLatestLog(kind: LogKind): Promise<LogPreview | null> {
    return invoke<LogPreview | null>("read_latest_log", { kind });
  },

  revealReplay(path: string): Promise<void> {
    return invoke("reveal_replay", { path });
  },

  async selectFile(options: OpenDialogOptions): Promise<string | null> {
    const selected = await open({ ...options, multiple: false });
    return typeof selected === "string" ? selected : null;
  },

  openUrl(url: string): Promise<void> {
    return openUrl(url);
  },

  isWindowFocused(): Promise<boolean> {
    return getCurrentWindow().isFocused();
  },

  async ensureNotificationPermission(): Promise<boolean> {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  },

  sendNotification(title: string, body: string): void {
    sendNotification({ title, body });
  },
};
