// Clan management, on your own player card's clan tab.
//
// Everything here used to be a trip to faforever.com. It lives on the card
// rather than in a tab of its own because that is where a clan already is: the
// roster, the founder, the join dates. Adding controls to the page people
// already open to look at a clan beats a fourteenth entry in the tab bar.
//
// Which controls are *drawn* comes from `clan.identity.isLeader`. That is not
// a permission: `Clan` is owned by its leader and `ClanMembership` carries its
// own delete rule, so the server answers 403 whatever this file believes. It
// is the same posture as the tournament roles.

import { useEffect, useMemo, useState } from "react";
import type { ClanAction, ClanCommand, ClanDraft, ClanState } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";
import { PlayerName } from "../../shared/nameColors";

/** Mirrors `faf_domain::state::clan::MAX_CLAN_TAG`, which is the API's own cap. */
const MAX_TAG = 3;

const send = (command: ClanCommand) => ipc.send({ kind: "Clan", command });

const load = () => send({ type: "load" });

const ACTION_LABEL = {
  creating: "clan.action.creating",
  editing: "clan.action.editing",
  inviting: "clan.action.inviting",
  joining: "clan.action.joining",
  removing: "clan.action.removing",
  leaving: "clan.action.leaving",
  handingOver: "clan.action.handingOver",
  disbanding: "clan.action.disbanding",
} as const satisfies Record<ClanAction, MessageKey>;

/** Twin of `ClanDraft::problem`, so the form does not wait for a round trip. */
function draftProblem(draft: ClanDraft): MessageKey | null {
  if (!draft.name.trim()) return "clan.problem.nameMissing";
  if (!draft.tag.trim()) return "clan.problem.tagMissing";
  if (draft.tag.trim().length > MAX_TAG) return "clan.problem.tagTooLong";
  return null;
}

function ActionBanner({ action }: { action: ClanState["action"] }) {
  const { t } = useTranslation();
  if (action.type === "working") {
    return (
      <p className="clan-banner muted" role="status">
        {t(ACTION_LABEL[action.payload.action])}
      </p>
    );
  }
  if (action.type === "failed") {
    // The server's own sentence. `faf-java-api` answers a refused clan write
    // with something written for a player ("the clan tag BRO is already
    // taken"), and any category this client mapped it to would say less.
    return (
      <p className="clan-banner is-error" role="alert">
        {action.payload.reason}
      </p>
    );
  }
  return null;
}

function ClanForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
}: {
  initial: ClanDraft;
  submitLabel: MessageKey;
  busy: boolean;
  onSubmit: (draft: ClanDraft) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  // Reset when the clan underneath changes: after a rename the form should
  // hold what the clan now says, not what was typed to get there.
  useEffect(() => setDraft(initial), [initial]);

  const problem = draftProblem(draft);
  const set = (patch: Partial<ClanDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <form
      className="clan-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!problem && !busy) onSubmit(draft);
      }}
    >
      <label className="clan-field">
        <span>{t("clan.field.name")}</span>
        <input value={draft.name} disabled={busy} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="clan-field clan-field-tag">
        <span>{t("clan.field.tag")}</span>
        <input
          value={draft.tag}
          maxLength={MAX_TAG}
          disabled={busy}
          onChange={(e) => set({ tag: e.target.value })}
        />
      </label>
      <label className="clan-field clan-field-wide">
        <span>{t("clan.field.description")}</span>
        <textarea
          value={draft.description}
          rows={3}
          disabled={busy}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <div className="clan-form-actions">
        {problem && <span className="muted">{t(problem)}</span>}
        <Button type="submit" variant="primary" disabled={busy || problem !== null}>
          {t(submitLabel)}
        </Button>
      </div>
    </form>
  );
}

/** Invite somebody: find the account, generate the token, hand it over. */
function InvitePanel({ clan, busy }: { clan: ClanState; busy: boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  // Debounced, because this searches the whole account directory and the field
  // is typed into a character at a time. The backend also drops a stale answer;
  // this is about not asking in the first place.
  useEffect(() => {
    const timeout = window.setTimeout(
      () => send({ type: "searchCandidates", payload: { query } }),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [query]);

  const invitation = clan.invitation;

  return (
    <section className="clan-panel surface-panel">
      <h4>{t("clan.invite.title")}</h4>
      <p className="muted">{t("clan.invite.hint")}</p>
      <label className="clan-field">
        <span>{t("clan.invite.search")}</span>
        <input
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("clan.invite.searchPlaceholder")}
        />
      </label>
      {clan.candidates.length > 0 && (
        <ul className="clan-candidates">
          {clan.candidates.map((candidate) => (
            <li key={candidate.id}>
              <span>
                <PlayerName name={candidate.login} />
                {candidate.globalRating !== null && <small> ({candidate.globalRating})</small>}
              </span>
              <Button
                disabled={busy}
                onClick={() =>
                  send({
                    type: "invite",
                    payload: { playerId: candidate.id, login: candidate.login },
                  })
                }
              >
                {t("clan.invite.generate")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {invitation && (
        <div className="clan-invitation surface">
          <p>{t("clan.invite.ready", { name: invitation.login })}</p>
          {/* Nothing is stored server side: the token *is* the invitation, so
              it has to actually be delivered. Shown rather than fired off. */}
          <textarea className="clan-invitation-token" readOnly value={invitation.token} rows={3} />
          <div className="clan-invitation-actions">
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(invitation.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              <Icon name="copy" size={13} />
              {t(copied ? "clan.invite.copied" : "clan.invite.copy")}
            </Button>
            <Button onClick={() => send({ type: "clearInvitation" })}>{t("clan.invite.done")}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** For an account in no clan: found one, or redeem an invitation to one. */
function NoClanPanel({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const [token, setToken] = useState("");

  return (
    <>
      <section className="clan-panel surface-panel">
        <h4>{t("clan.create.title")}</h4>
        <p className="muted">{t("clan.create.hint")}</p>
        <ClanForm
          initial={{ name: "", tag: "", description: "" }}
          submitLabel="clan.create.submit"
          busy={busy}
          onSubmit={(draft) => send({ type: "create", payload: { draft } })}
        />
      </section>

      <section className="clan-panel surface-panel">
        <h4>{t("clan.join.title")}</h4>
        {/* The leader is handed a link to send, so a link is what arrives.
            The service takes the token out of either. */}
        <p className="muted">{t("clan.join.hint")}</p>
        <label className="clan-field clan-field-wide">
          <span>{t("clan.join.token")}</span>
          <textarea
            value={token}
            rows={3}
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("clan.join.tokenPlaceholder")}
          />
        </label>
        <div className="clan-form-actions">
          <Button
            variant="primary"
            disabled={busy || token.trim() === ""}
            onClick={() => send({ type: "acceptInvitation", payload: { token } })}
          >
            {t("clan.join.submit")}
          </Button>
        </div>
      </section>
    </>
  );
}

export function ClanManagement() {
  const { t } = useTranslation();
  const clan = useAppStore((state) => state.state.clan);
  const [confirming, setConfirming] = useState<"leave" | "disband" | null>(null);

  useEffect(() => {
    load();
  }, []);

  const busy = clan.action.type === "working";
  const identity = clan.identity;
  const inAClan = identity.clanId !== "";

  const draft = useMemo<ClanDraft>(
    () => ({
      name: clan.clan?.name ?? identity.clanName,
      tag: clan.clan?.tag ?? identity.clanTag,
      description: clan.clan?.description ?? "",
    }),
    [clan.clan, identity.clanName, identity.clanTag],
  );

  // Everyone but you. Handing over and removing are both about somebody else,
  // and the server refuses either aimed at yourself.
  const others = (clan.clan?.members ?? []).filter(
    (member) => member.playerId !== identity.playerId,
  );

  // Nothing is drawn until the answer is in. Rendering "found a clan" under
  // the roster of the clan you are already in, for the length of a request,
  // is worse than a line of text.
  if (clan.status.type !== "ready") {
    return (
      <p className={clan.status.type === "failed" ? "clan-banner is-error" : "muted clan-banner"}>
        {clan.status.type === "failed" ? clan.status.payload.reason : t("clan.loading")}
      </p>
    );
  }

  return (
    <div className="clan-management">
      <ActionBanner action={clan.action} />

      {!inAClan ? (
        <NoClanPanel busy={busy} />
      ) : (
        <>
          {identity.isLeader ? (
            <>
              <section className="clan-panel surface-panel">
                <h4>{t("clan.edit.title")}</h4>
                <ClanForm
                  initial={draft}
                  submitLabel="clan.edit.submit"
                  busy={busy}
                  onSubmit={(next) => send({ type: "edit", payload: { draft: next } })}
                />
              </section>

              <InvitePanel clan={clan} busy={busy} />

              <section className="clan-panel surface-panel">
                <h4>{t("clan.roster.manageTitle")}</h4>
                {others.length === 0 ? (
                  <p className="muted">{t("clan.roster.aloneHint")}</p>
                ) : (
                  <ul className="clan-roster-admin">
                    {others.map((member) => (
                      <li key={member.membershipId || member.playerId}>
                        <PlayerName name={member.login} />
                        <span className="spacer" />
                        <Button
                          disabled={busy}
                          onClick={() =>
                            send({
                              type: "handOver",
                              payload: { playerId: member.playerId },
                            })
                          }
                          title={t("clan.roster.handOverHint")}
                        >
                          {t("clan.roster.handOver")}
                        </Button>
                        <Button
                          className="btn-danger"
                          disabled={busy}
                          onClick={() =>
                            send({ type: "remove", payload: { playerId: member.playerId } })
                          }
                        >
                          {t("clan.roster.remove")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="clan-panel surface-panel">
                <h4>{t("clan.disband.title")}</h4>
                {/* The leader cannot leave: the server refuses to delete the
                    leader's own membership, because a clan must have one. The
                    two ways out are handing it over and closing it down. */}
                <p className="muted">{t("clan.disband.hint")}</p>
                {confirming === "disband" ? (
                  <div className="clan-form-actions">
                    <span>{t("clan.disband.confirm", { name: identity.clanName })}</span>
                    <Button onClick={() => setConfirming(null)}>{t("clan.cancel")}</Button>
                    <Button
                      className="btn-danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        send({ type: "disband" });
                      }}
                    >
                      {t("clan.disband.submit")}
                    </Button>
                  </div>
                ) : (
                  <Button className="btn-danger" disabled={busy} onClick={() => setConfirming("disband")}>
                    {t("clan.disband.submit")}
                  </Button>
                )}
              </section>
            </>
          ) : (
            <section className="clan-panel surface-panel">
              <h4>{t("clan.leave.title")}</h4>
              <p className="muted">{t("clan.leave.hint", { name: identity.clanName })}</p>
              {confirming === "leave" ? (
                <div className="clan-form-actions">
                  <span>{t("clan.leave.confirm", { name: identity.clanName })}</span>
                  <Button onClick={() => setConfirming(null)}>{t("clan.cancel")}</Button>
                  <Button
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      send({ type: "leave" });
                    }}
                  >
                    {t("clan.leave.submit")}
                  </Button>
                </div>
              ) : (
                <Button className="btn-danger" disabled={busy} onClick={() => setConfirming("leave")}>
                  {t("clan.leave.submit")}
                </Button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
