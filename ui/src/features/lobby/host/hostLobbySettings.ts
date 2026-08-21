// The lobby settings both host dialogs collect: title, who may join, and the
// rating window. Shared because they are the same fields with the same rules
// whether the game is a custom skirmish or a co-op mission. Only the columns
// underneath them differ.

import { useState } from "react";
import { useTranslation } from "../../../i18n/useTranslation";
import { useAppStore } from "../../../store/store";

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** The part of a `Lobby::host` config this section decides. */
export interface HostAdmissionConfig {
  title: string;
  visibility: string;
  /** `null` when the lobby is open, which is not the same as an empty password. */
  password: string | null;
  enforceRatingRange: boolean;
  ratingMin: number | null;
  ratingMax: number | null;
}

export interface HostLobbySettings {
  title: string;
  setTitle: (title: string) => void;
  visibility: string;
  setVisibility: (visibility: string) => void;
  passwordEnabled: boolean;
  setPasswordEnabled: (enabled: boolean) => void;
  password: string;
  setPassword: (password: string) => void;
  ratingEnabled: boolean;
  setRatingEnabled: (enabled: boolean) => void;
  ratingMin: number;
  setRatingMin: (rating: number) => void;
  ratingMax: number;
  setRatingMax: (rating: number) => void;
  /** Empty when the field is fine; the dialog's submit is blocked by any of them. */
  titleError: string;
  passwordError: string;
  ratingError: string;
  hostConfig: () => HostAdmissionConfig;
}

export function useHostLobbySettings(initialTitle?: string): HostLobbySettings {
  const { t } = useTranslation();
  const player = useAppStore((state) => state.state.auth.player);
  const remembered = useAppStore((state) => state.state.settings.browsing.hostGame);

  const [title, setTitle] = useState(
    initialTitle ??
      (remembered.title ||
        t("lobby.host.defaultTitle", { player: player?.name ?? t("lobby.matchmaker.player") })),
  );
  const [visibility, setVisibility] = useState(remembered.visibility);
  const [passwordEnabled, setPasswordEnabled] = useState(remembered.passwordEnabled);
  const [password, setPassword] = useState(remembered.password);
  const [ratingEnabled, setRatingEnabled] = useState(remembered.enforceRatingRange);
  const [ratingMin, setRatingMin] = useState(remembered.ratingMin);
  const [ratingMax, setRatingMax] = useState(remembered.ratingMax);

  const titleError = !title.trim()
    ? t("lobby.host.error.title")
    : !PRINTABLE_ASCII.test(title.trim())
      ? t("lobby.host.error.titleAscii")
      : "";
  const passwordError =
    passwordEnabled && !PRINTABLE_ASCII.test(password) ? t("lobby.host.error.passwordAscii") : "";
  const ratingError = ratingEnabled && ratingMin > ratingMax ? t("lobby.host.error.ratingOrder") : "";

  return {
    title,
    setTitle,
    visibility,
    setVisibility,
    passwordEnabled,
    setPasswordEnabled,
    password,
    setPassword,
    ratingEnabled,
    setRatingEnabled,
    ratingMin,
    setRatingMin,
    ratingMax,
    setRatingMax,
    titleError,
    passwordError,
    ratingError,
    hostConfig: () => ({
      title: title.trim(),
      visibility,
      password: passwordEnabled && password ? password : null,
      enforceRatingRange: ratingEnabled,
      ratingMin: ratingEnabled ? ratingMin : null,
      ratingMax: ratingEnabled ? ratingMax : null,
    }),
  };
}
