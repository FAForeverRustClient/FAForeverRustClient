import { useMemo, useState } from "react";
import type { PlayerClan } from "../../ipc/bindings";
import { formatDate } from "../../shared/dates";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { Button } from "../../design-system/Button";
import { openPlayerCard } from "./playerCardActions";
import { PlayerName } from "../../shared/nameColors";

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
  const [search, setSearch] = useState("");
  const members = useMemo(() => clan?.members.filter((member) => member.login.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [], [clan, search]);
  if (!clan) return <div className="player-card-empty muted">This player is not a member of a clan.</div>;
  const leader = clan.leader.trim();
  const canMessageLeader = leader !== "" && leader.localeCompare(selfLogin, undefined, { sensitivity: "base" }) !== 0;
  const websiteUrl = optionalHttpsUrl(clan.websiteUrl);
  return (
    <div className="player-clan-view">
      <section className="player-clan-overview surface-panel">
        <header>
          <div><span className="player-card-eyebrow">Clan #{clan.id}</span><h3>{clan.name} [{clan.tag}]</h3></div>
          <div className="player-clan-actions">
            {canMessageLeader && <Button onClick={() => void onMessageLeader(leader)}>Message {leader}</Button>}
            {websiteUrl && <Button onClick={() => void openHttpsUrl(websiteUrl)}>Visit website</Button>}
          </div>
        </header>
        <p>{clan.description || "No clan description."}</p>
        <dl className="player-account-details surface">
          <div><dt>Created</dt><dd>{displayDate(clan.createdAt)}</dd></div>
          <div><dt>Members</dt><dd>{clan.members.length}</dd></div>
          <div><dt>Invitation required</dt><dd>{clan.requiresInvitation ? "Yes" : "No"}</dd></div>
          <div><dt>Leader</dt><dd>{clan.leader || "N/A"}</dd></div>
          <div><dt>Founder</dt><dd>{clan.founder || "N/A"}</dd></div>
        </dl>
      </section>
      <section>
        <div className="player-card-section-heading"><div><span className="player-card-eyebrow">Roster</span><h3>Clan members</h3></div><label className="player-card-search"><span>Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Member name…" /></label></div>
        <div className="player-clan-members">
          {members.map((member) => (
            <button className="surface surface-interactive" key={member.playerId} onClick={() => void openPlayerCard(member.playerId, member.login)}>
              <strong><PlayerName name={member.login} /></strong>
              <span>Joined {displayDate(member.joinedAt)}</span>
              <span>Registered {displayDate(member.accountCreatedAt)}</span>
              <span>Last seen {displayDate(member.lastSeenAt)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
