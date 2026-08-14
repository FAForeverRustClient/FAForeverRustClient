import { Icon } from "../../design-system/Icon";
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
  return (
    <>
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
