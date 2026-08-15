import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { ACCOUNT_LINKS, openExternalUrl } from "../../shared/externalLinks";
import { SettingRow } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

function ExternalAction({ href, children }: { href: string; children: string }) {
  return (
    <a
      className="settings-external-link surface-raised surface-interactive"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}<Icon name="external" size={14} />
    </a>
  );
}

export function AccountSupportSettingsSection() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.state.auth);
  const player = auth.player;
  const logout = () =>
    ipc.send({
      kind: "Auth",
      command: { type: auth.mode === "test" ? "logoutTest" : "logout" },
    });

  return (
    <>
      <SettingRow
        label={t("settings.account.session")}
        hint={player ? t("settings.account.signedInAs", { name: player.name, id: player.id }) : t("settings.account.sessionHint")}
      >
        <Button
          onClick={logout}
          aria-label={t("settings.account.logOut")}
        >
          <Icon name="logout" size={14} /> {t("settings.account.logOut")}
        </Button>
      </SettingRow>
      <SettingRow label={t("settings.account.fafAccount")} hint={t("settings.account.fafAccountHint")}>
        <div className="settings-external-links">
          <ExternalAction href={ACCOUNT_LINKS.rename}>{t("settings.account.changeUsername")}</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.recover}>{t("settings.account.resetPassword")}</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.steam}>{t("settings.account.linkSteam")}</ExternalAction>
        </div>
      </SettingRow>
      <SettingRow label={t("settings.account.helpCommunityRules")} hint={t("settings.account.helpCommunityRulesHint")}>
        <div className="settings-external-links">
          <ExternalAction href={ACCOUNT_LINKS.support}>{t("settings.account.support")}</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.help}>{t("settings.account.technicalHelp")}</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.rules}>{t("settings.account.rules")}</ExternalAction>
        </div>
      </SettingRow>
    </>
  );
}
