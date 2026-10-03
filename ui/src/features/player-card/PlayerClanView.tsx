import { useMemo, useState } from "react";
import type { ClanMember, PlayerClan } from "../../ipc/bindings";
import { formatDate } from "../../shared/format/dates";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { openPlayerCard } from "../../shared/playerCardActions";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/components/nameColors";
import { ClanManagement, LeaveClanAction } from "./ClanManagement";

function displayDate(value: string): string {
  return formatDate(value, "N/A");
}

/** The member who joined last, skipping any whose join date does not parse. */
export function newestOf(members: ClanMember[]): ClanMember | null {
  let newest: ClanMember | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const joinedAt = Date.parse(member.joinedAt);
    if (Number.isFinite(joinedAt) && joinedAt > newestAt) {
      newest = member;
      newestAt = joinedAt;
    }
  }
  return newest;
}

/**
 * A leader, founder or newest member, opening their card like a roster entry does. The id
 * comes from the roster when they are still in it; a founder who has left is
 * opened by name.
 */
function ClanPerson({ login, members, crown = false }: {
  login: string;
  members: ClanMember[];
  crown?: boolean;
}) {
  const { t } = useTranslation();
  if (login === "") return <>N/A</>;
  const member = members.find((entry) => entry.login.localeCompare(login, undefined, { sensitivity: "base" }) === 0);
  return (
    <button
      type="button"
      className="player-clan-person"
      onClick={() => void openPlayerCard(member?.playerId ?? null, login)}
      title={t("playerCard.clan.openProfile", { login })}
    >
      <PlayerName name={login} />
      {crown && <span className="player-clan-member-leader" aria-hidden><Icon name="crown" size={14} /></span>}
    </button>
  );
}

export function PlayerClanView({
  clan,
  selfLogin,
  onMessageLeader,
  manageable = false,
}: {
  clan: PlayerClan | null;
  selfLogin: string;
  onMessageLeader: (login: string) => Promise<void>;
  /** Whether this is your own card, and so whether anything here can be changed. */
  manageable?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  // Whether anyone still joins: "20 members" reads the same for a clan that is
  // recruiting and one nobody has joined in years.
  const newestMember = useMemo(() => newestOf(clan?.members ?? []), [clan]);
  const members = useMemo(() => clan?.members.filter((member) => member.login.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [], [clan, search]);
  // On your own card, "no clan" is not an empty state: it is the one place
  // that offers founding one and redeeming an invitation to one.
  if (!clan) {
    return manageable
      ? <ClanManagement />
      : <div className="player-card-empty muted">{t("playerCard.clan.none")}</div>;
  }
  const leader = clan.leader.trim();
  const isSelfLeader = leader !== "" && leader.localeCompare(selfLogin, undefined, { sensitivity: "base" }) === 0;
  const canMessageLeader = leader !== "" && !isSelfLeader;
  const websiteUrl = optionalHttpsUrl(clan.websiteUrl);
  const founder = clan.founder.trim();
  return (
    <div className="player-clan-view">
      <section className="player-clan-overview surface-panel">
        <header>
          <div>
            <span className="player-card-eyebrow">{t("playerCard.clan.eyebrow", { id: clan.id })}</span>
            {/* Tag first, the way the clan is written everywhere else. */}
            <h3>[{clan.tag}] {clan.name}</h3>
            <span className="player-clan-meta">
              {t("playerCard.clan.founded", { date: displayDate(clan.createdAt) })}
              {" · "}
              {t(clan.requiresInvitation ? "playerCard.clan.invitationOnly" : "playerCard.clan.openToJoin")}
            </span>
          </div>
          <div className="player-clan-actions">
            {canMessageLeader && <Button onClick={() => void onMessageLeader(leader)}>{t("playerCard.clan.messageLeader", { leader })}</Button>}
            {websiteUrl && <Button onClick={() => void openHttpsUrl(websiteUrl)}>{t("playerCard.clan.visitWebsite")}</Button>}
            {/* The leader cannot leave; the disband panel is their way out. */}
            {manageable && !isSelfLeader && <LeaveClanAction clanName={clan.name} />}
          </div>
        </header>
        <p className={clan.description ? undefined : "muted"}>{clan.description || t("playerCard.clan.noDescription")}</p>
        <dl className="player-account-details player-clan-facts surface">
          <div>
            <dt>{t("playerCard.clan.leader")}</dt>
            <dd><ClanPerson login={leader} members={clan.members} crown /></dd>
          </div>
          <div>
            <dt>{t("playerCard.clan.founder")}</dt>
            <dd><ClanPerson login={founder} members={clan.members} /></dd>
          </div>
          <div>
            <dt>{t("playerCard.clan.newestMember")}</dt>
            <dd>
              {newestMember ? (
                <>
                  <ClanPerson login={newestMember.login} members={clan.members} />
                  {/* Beside the name rather than under it, so this cell stays
                      one line tall like the other three. */}
                  <span className="player-clan-fact-note" title={t("playerCard.clan.joined", { date: displayDate(newestMember.joinedAt) })}>
                    {displayDate(newestMember.joinedAt)}
                  </span>
                </>
              ) : "N/A"}
            </dd>
          </div>
          <div><dt>{t("playerCard.clan.members")}</dt><dd>{clan.members.length}</dd></div>
        </dl>
      </section>
      <section>
        <div className="player-card-section-heading"><div><span className="player-card-eyebrow">{t("playerCard.clan.rosterEyebrow")}</span><h3>{t("playerCard.clan.rosterTitle")}</h3></div><label className="player-card-search"><span>{t("playerCard.clan.search")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("playerCard.clan.searchPlaceholder")} /></label></div>
        <div className="player-clan-members">
          {members.map((member) => (
            <button className="surface surface-interactive" key={member.playerId} onClick={() => void openPlayerCard(member.playerId, member.login)}>
              {/* The avatar the member wears, beside their name as everywhere
                  else in the client. Empty for one who wears none, and the
                  name keeps its place either way. */}
              <span className="player-clan-member-name">
                {member.avatarUrl && (
                  <img
                    className="player-clan-member-avatar"
                    src={member.avatarUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onError={(event) => {
                      event.currentTarget.style.visibility = "hidden";
                    }}
                  />
                )}
                <strong><PlayerName name={member.login} /></strong>
                {/* The leader's crown right after their name, as in the
                    matchmaker party. */}
                {leader !== "" && member.login.localeCompare(leader, undefined, { sensitivity: "base" }) === 0 && (
                  <span className="player-clan-member-leader" role="img" aria-label={t("playerCard.clan.leader")} title={t("playerCard.clan.leader")}>
                    <Icon name="crown" size={14} />
                  </span>
                )}
              </span>
              <span>{t("playerCard.clan.joined", { date: displayDate(member.joinedAt) })}</span>
              <span>{t("playerCard.clan.registered", { date: displayDate(member.accountCreatedAt) })}</span>
            </button>
          ))}
        </div>
      </section>
      {manageable && <ClanManagement />}
    </div>
  );
}
