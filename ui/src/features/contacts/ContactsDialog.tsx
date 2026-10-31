import { useId, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { SectionTabs, sectionPanelProps } from "../../design-system/SectionTabs";
import type { Relation } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { EMPTY_CONTACTS } from "../../store/reducers/social";
import { usePlayerMenu } from "../../shared/hooks/usePlayerMenu";
import { ProfileAvatar } from "../../shared/components/ProfileAvatar";
import { nickKey } from "../../shared/nameColorsUtil";
import { openPlayerCard } from "../../shared/playerCardActions";
import { closeContacts } from "../../shared/contactsActions";
import { contactRows } from "./contactRows";
import "./contacts.css";

export function ContactsDialog() {
  const open = useAppStore(store => store.state.social.contacts?.open ?? false);
  return open ? <ContactsContent /> : null;
}

function ContactsContent() {
  const { t } = useTranslation();
  const social = useAppStore(store => store.state.social);
  const contacts = social.contacts ?? EMPTY_CONTACTS;
  const lobbyStatus = useAppStore(store => store.state.lobby.status);
  const channels = useAppStore(store => store.state.chat.channels);
  const self = useAppStore(store => store.state.auth.player?.name ?? "");
  const [tab, setTab] = useState<Relation>("friend");
  const [search, setSearch] = useState("");
  const prefix = useId();
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu({ onNavigate: closeContacts });
  const online = useMemo(() => new Set([
    ...social.players.map(player => nickKey(player.login)),
    ...channels.flatMap(channel => channel.users.map(user => nickKey(user.name))),
  ]), [social.players, channels]);
  const lists = useMemo(() => ({ friend: contactRows(social, "friend", online), foe: contactRows(social, "foe", online) }),
    [social, online]);
  const query = search.trim().toLocaleLowerCase();
  const rows = lists[tab].filter(row => `${row.login ?? ""} ${row.playerId ?? ""}`.toLocaleLowerCase().includes(query));
  const ready = lobbyStatus === "connected";
  const presenceKnown = ready && social.players.some(player => nickKey(player.login) !== nickKey(self));
  const unresolved = contacts.entries.some(entry => entry.login === null);

  return (
    <Modal className="contacts-modal" ariaLabel={t("contacts.title")} onClose={closeContacts}>
      <header className="contacts-heading">
        <h2>{t("contacts.title")}</h2>
        <p className="muted">{t("contacts.description")}</p>
      </header>
      <SectionTabs active={tab} onChange={setTab} idPrefix={prefix} ariaLabel={t("contacts.title")} items={[
        { id: "friend", label: t("chat.category.friends"), count: lists.friend.length },
        { id: "foe", label: t("chat.category.foes"), count: lists.foe.length },
      ]} />
      <label className="search-field contacts-search">
        <Icon name="search" size={16} />
        <input type="search" aria-label={t("contacts.search")} placeholder={t("contacts.search")}
          value={search} onChange={event => setSearch(event.target.value)} />
      </label>
      {!ready && <p className="contacts-notice muted" role="status">{t("contacts.disconnected")}</p>}
      {unresolved && <div className="contacts-notice" role="status">
        <span>{t("contacts.unresolved")}</span>
        <Button disabled={!ready || contacts.refreshing} onClick={() => ipc.send({ kind: "Social", command: { type: "resolveContacts" } })}>
          {t(contacts.refreshing ? "contacts.loadingNames" : "contacts.retryNames")}
        </Button>
      </div>}
      <div className="contacts-results" {...sectionPanelProps(prefix, tab)}>
        {rows.length === 0 ? <p className="contacts-empty muted">{t(query ? "contacts.noMatches" : tab === "friend" ? "contacts.noFriends" : "contacts.noFoes")}</p> : (
          <ul className="contacts-list">
            {rows.map(row => {
              const name = row.login ?? t("contacts.unknownAccount", { id: row.playerId ?? "" });
              const presence = row.login === null ? "unknown" : row.online ? "online" : presenceKnown ? "offline" : "unknown";
              return <li key={row.key} className={`contacts-row${row.login !== null && playerMenuTarget === row.login ? " is-menu-target" : ""}`}
                onContextMenu={row.login ? event => openPlayerMenu(row.login!, event) : undefined}>
                <span className="contacts-avatar">
                  <ProfileAvatar name={row.login ?? "?"} avatarUrl={row.avatarUrl} tooltip={row.avatarTooltip} />
                  <span className={`contacts-presence is-${presence}`} aria-hidden="true" />
                </span>
                <div className="contacts-person">
                  <button type="button" className="contacts-name" disabled={row.playerId === null && !row.login}
                    onClick={() => { closeContacts(); void openPlayerCard(row.playerId, row.login ?? ""); }}>{name}</button>
                  <span className="muted">{t(row.login === null ? "contacts.nameUnavailable" : presence === "online" ? "contacts.online" : presence === "offline" ? "contacts.offline" : "contacts.presenceUnknown")}</span>
                </div>
                <div className="contacts-actions">
                  <Button disabled={!ready || row.playerId === null}
                    aria-label={t(tab === "friend" ? "contacts.removeFriend" : "contacts.removeFoe", { name })}
                    onClick={() => ipc.send({ kind: "Social", command: { type: "setRelation", payload: {
                      playerId: row.playerId!, login: row.login ?? "", relation: tab, member: false,
                    } } })}>{t("contacts.remove")}</Button>
                  {row.login && <Button aria-label={t("contacts.actionsFor", { name })} aria-haspopup="menu"
                    onClick={event => openPlayerMenu(row.login!, event)}>{t("contacts.actions")}</Button>}
                </div>
              </li>;
            })}
          </ul>
        )}
      </div>
      {playerMenu}
    </Modal>
  );
}
