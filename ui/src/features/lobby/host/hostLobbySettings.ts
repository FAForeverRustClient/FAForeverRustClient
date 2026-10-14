// The lobby settings both host dialogs collect: title, who may join, and the
// rating window. Shared because they are the same fields with the same rules
// whether the game is a custom skirmish or a co-op mission. Only the columns
// underneath them differ.

import { useState } from "react";
import { useTranslation } from "../../../i18n/useTranslation";
import type { HostGamePreferences } from "../../../ipc/bindings";
import { useAppStore } from "../../../store/store";

/** The bounds `HostGameConfig::validated` accepts. */
export const MIN_HOST_RATING = -9999;
export const MAX_HOST_RATING = 9999;

/**
 * The longest title this client hosts with (`HostGameConfig::MAX_TITLE_CHARS`).
 *
 * 64, down from the 128 the Python client allows: room for a title that says
 * what the game is and what it asks of the players, and none for a wall of
 * text, which a tile cut to its first twenty characters and a list row to its
 * first fifty anyway. Games hosted elsewhere can still arrive longer.
 */
export const MAX_HOST_TITLE = 64;

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

/** Which remembered form a dialog seeds from and writes back to. */
export type HostFormSlot = "hostGame" | "hostCoop";

export interface HostLobbySettings {
  title: string;
  setTitle: (title: string) => void;
  visibility: string;
  setVisibility: (visibility: string) => void;
  /** Empty means an open lobby: there is no separate switch for it. */
  password: string;
  setPassword: (password: string) => void;
  ratingEnabled: boolean;
  setRatingEnabled: (enabled: boolean) => void;
  /** `null` is an open end: no bound on that side. */
  ratingMin: number | null;
  setRatingMin: (rating: number | null) => void;
  ratingMax: number | null;
  setRatingMax: (rating: number | null) => void;
  /** Empty when the field is fine; the dialog's submit is blocked by any of them. */
  titleError: string;
  passwordError: string;
  ratingError: string;
  hostConfig: () => HostAdmissionConfig;
  /**
   * The form as a remembered block, for writing back on the way out.
   *
   * `featuredMod` and `map` are the caller's to fill in: this hook owns the
   * admission fields and knows nothing about what is being hosted.
   */
  remembered: (featuredMod: string, map: string) => HostGamePreferences;
}

export function useHostLobbySettings(
  initialTitle?: string,
  slot: HostFormSlot = "hostGame",
): HostLobbySettings {
  const { t } = useTranslation();
  const player = useAppStore((state) => state.state.auth.player);
  // Co-op seeds from its own slot. Sharing `hostGame` would mean a mission's
  // lobby name replacing the skirmish form, which is what kept the two apart
  // in the first place.
  const remembered = useAppStore((state) => state.state.settings.browsing[slot]);

  // Cut to the limit on the way in, as anything set from code is below: a
  // title remembered from before the limit was lowered, or a co-op mission's
  // long name in its default, would otherwise reach the backend and be
  // refused there, after the form had been filled in.
  const [title, setTitleState] = useState(
    (initialTitle ??
      (remembered.title ||
        t("lobby.host.defaultTitle", { player: player?.name ?? t("lobby.matchmaker.player") })))
      .slice(0, MAX_HOST_TITLE),
  );
  const setTitle = (value: string) => setTitleState(value.slice(0, MAX_HOST_TITLE));
  const [visibility, setVisibility] = useState(remembered.visibility);
  // A password remembered while its old checkbox was off was not in use, and
  // with the field as the only switch, putting it back would turn it on.
  const [password, setPassword] = useState(remembered.passwordEnabled ? remembered.password : "");
  const [ratingEnabled, setRatingEnabled] = useState(remembered.enforceRatingRange);
  const [ratingMin, setRatingMin] = useState(remembered.ratingMin);
  const [ratingMax, setRatingMax] = useState(remembered.ratingMax);

  const titleError = !title.trim()
    ? t("lobby.host.error.title")
    : !PRINTABLE_ASCII.test(title.trim())
      ? t("lobby.host.error.titleAscii")
      : "";
  const passwordError = !PRINTABLE_ASCII.test(password) ? t("lobby.host.error.passwordAscii") : "";
  // Checked whether or not the range is enforced: a back-to-front range is a
  // mistake worth pointing out while it is being typed, not only once the
  // checkbox is ticked.
  //
  // Every rule the backend applies to the range is applied here as well, so a
  // range it would refuse keeps the Host button disabled with the reason on
  // screen. Refused after the dialog had closed, the player lost everything
  // they had set up in it (#372). Either end may be left open.
  const outOfBounds = (limit: number | null) =>
    limit !== null && (limit < MIN_HOST_RATING || limit > MAX_HOST_RATING);
  const ratingError =
    outOfBounds(ratingMin) || outOfBounds(ratingMax)
      ? t("lobby.host.error.ratingBounds", { min: MIN_HOST_RATING, max: MAX_HOST_RATING })
      : ratingMin !== null && ratingMax !== null && ratingMin > ratingMax
        ? t("lobby.host.error.ratingOrder")
        : "";

  return {
    title,
    setTitle,
    visibility,
    setVisibility,
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
      password: password ? password : null,
      enforceRatingRange: ratingEnabled,
      ratingMin: ratingEnabled ? ratingMin : null,
      ratingMax: ratingEnabled ? ratingMax : null,
    }),
    remembered: (featuredMod, map) => ({
      title,
      featuredMod,
      visibility,
      map,
      // Still stored, so settings written before the checkbox went read the
      // same: it now only says whether the field held anything.
      passwordEnabled: password !== "",
      password,
      enforceRatingRange: ratingEnabled,
      ratingMin,
      ratingMax,
    }),
  };
}
