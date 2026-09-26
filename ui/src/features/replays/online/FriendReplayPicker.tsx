// "Replays of friends": the name of somebody on your friends list, without
// typing it.
//
// The ask came from a trainer who watches his trainees' games: every single
// one of them meant typing a full login into the Player box, and FAF logins
// are not names anybody types twice without a mistake. The client already
// knows exactly who is on the list, so the list is the control.
//
// A picker rather than a filter. "Show me every replay any of my friends
// played" is a different query and not one the API can answer: the vault
// filters on one player at a time, so a checkbox list would have to fan out
// into a search per friend and staple the pages together. What was asked for
// was a faster way to reach one of them, which is what this is.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { useTranslation } from "../../../i18n/useTranslation";
import "../../../design-system/multi-select.css";

interface Props {
  /** Logins from `social.friends`, in whatever order the state holds them. */
  friends: string[];
  /** The login the search is currently scoped to, so the list can mark it. */
  current: string;
  onPick: (login: string) => void;
}

export function FriendReplayPicker({ friends, current, onPick }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Same dismissal rules as `MultiSelect`, which is the other popover in this
  // bar: a pointer anywhere outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Sorted here rather than trusted from the state: the list is a set of
  // logins and the order it arrives in is the server's, which is not an order
  // a reader can scan. `localeCompare` so accented logins land where the
  // reader's language puts them.
  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return [...friends]
      .filter((login) => !needle || login.toLocaleLowerCase().includes(needle))
      .sort((left, right) => left.localeCompare(right));
  }, [filter, friends]);

  const pick = (login: string) => {
    setOpen(false);
    setFilter("");
    onPick(login);
  };

  return (
    <div className="multi-select friend-replay-picker" ref={rootRef}>
      <Button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t("replays.search.friendsHint")}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="users" size={14} /> {t("replays.search.friends")}
      </Button>
      {open && (
        <div className="multi-select-popover friend-replay-popover" role="listbox" aria-label={t("replays.search.friends")}>
          {friends.length === 0 ? (
            // Not an error, and not empty either: a friends list is only known
            // once the lobby has sent one, which it does on sign-in.
            <p className="muted multi-select-empty">{t("replays.search.friendsEmpty")}</p>
          ) : (
            <>
              {/* Only once the list is long enough to be worth narrowing. A
                  search box above three names is furniture. */}
              {friends.length > 8 && (
                <input
                  className="friend-replay-filter"
                  type="search"
                  autoFocus
                  value={filter}
                  placeholder={t("replays.search.friendsFilter")}
                  onChange={(event) => setFilter(event.target.value)}
                />
              )}
              {shown.length === 0 ? (
                <p className="muted multi-select-empty">{t("replays.search.friendsNoMatch")}</p>
              ) : (
                shown.map((login) => (
                  <button
                    key={login}
                    type="button"
                    role="option"
                    aria-selected={login.toLocaleLowerCase() === current.toLocaleLowerCase()}
                    className="multi-select-option friend-replay-option"
                    onClick={() => pick(login)}
                  >
                    {login}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
