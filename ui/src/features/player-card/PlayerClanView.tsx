import { useMemo, useState } from "react";
import type { PlayerClan } from "../../ipc/bindings";
import { formatDate } from "../../shared/dates";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { Button } from "../../design-system/Button";
import { openPlayerCard } from "./playerCardActions";
import { useTranslation } from "../../i18n/useTranslation";

function displayDate(value: string): string {
  return formatDate(value, "N/A");
}

export function PlayerClanView({
  clan,
  selfLogin,
  onMessageLeader,
}: {
  clan: PlayerClan | null;
  selfLogin: string;
  onMessageLeader: (login: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const members = useMemo(() => clan?.members.filter((member) => member.login.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [], [clan, search]);
  if (!clan) return <div className="player-card-empty muted">{t("playerCard.clan.none")}</div>;
  const leader = clan.leader.trim();
  const canMessageLeader = leader !== "" && leader.localeCompare(selfLogin, undefined, { sensitivity: "base" }) !== 0;
  const websiteUrl = optionalHttpsUrl(clan.websiteUrl);
  return (
    <div className="player-clan-view">
      <section className="player-clan-overview surface-panel">
        <header>
          <div><span className="player-card-eyebrow">{t("playerCard.clan.eyebrow", { id: clan.id })}</span><h3>{clan.name} [{clan.tag}]</h3></div>
          <div className="player-clan-actions">
            {canMessageLeader && <Button onClick={() => void onMessageLeader(leader)}>{t("playerCard.clan.messageLeader", { leader })}</Button>}
            {websiteUrl && <Button onClick={() => void openHttpsUrl(websiteUrl)}>{t("playerCard.clan.visitWebsite")}</Button>}
          </div>
        </header>
        <p>{clan.description || t("playerCard.clan.noDescription")}</p>
        <dl className="player-account-details surface">
          <div><dt>{t("playerCard.clan.created")}</dt><dd>{displayDate(clan.createdAt)}</dd></div>
          <div><dt>{t("playerCard.clan.members")}</dt><dd>{clan.members.length}</dd></div>
          <div><dt>{t("playerCard.clan.invitationRequired")}</dt><dd>{t(clan.requiresInvitation ? "playerCard.clan.yes" : "playerCard.clan.no")}</dd></div>
          <div><dt>{t("playerCard.clan.leader")}</dt><dd>{clan.leader || "N/A"}</dd></div>
          <div><dt>{t("playerCard.clan.founder")}</dt><dd>{clan.founder || "N/A"}</dd></div>
        </dl>
      </section>
      <section>
        <div className="player-card-section-heading"><div><span className="player-card-eyebrow">{t("playerCard.clan.rosterEyebrow")}</span><h3>{t("playerCard.clan.rosterTitle")}</h3></div><label className="player-card-search"><span>{t("playerCard.clan.search")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("playerCard.clan.searchPlaceholder")} /></label></div>
        <div className="player-clan-members">
          {members.map((member) => (
            <button className="surface surface-interactive" key={member.playerId} onClick={() => void openPlayerCard(member.playerId, member.login)}>
              <strong>{member.login}</strong>
              <span>{t("playerCard.clan.joined", { date: displayDate(member.joinedAt) })}</span>
              <span>{t("playerCard.clan.registered", { date: displayDate(member.accountCreatedAt) })}</span>
              <span>{t("playerCard.clan.lastSeen", { date: displayDate(member.lastSeenAt) })}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
