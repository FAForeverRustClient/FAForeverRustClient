import { Icon } from "../../design-system/Icon";
import { ACCOUNT_LINKS, openExternalUrl } from "../../shared/externalLinks";
import { SettingRow } from "./SettingControls";

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
  return (
    <>
      <SettingRow label="FAF account" hint="These actions open the canonical FAF website in your browser.">
        <div className="settings-external-links">
          <ExternalAction href={ACCOUNT_LINKS.rename}>Change username</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.recover}>Reset password</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.steam}>Link Steam</ExternalAction>
        </div>
      </SettingRow>
      <SettingRow label="Help and community rules" hint="Find account/client support or review the rules before reporting an incident.">
        <div className="settings-external-links">
          <ExternalAction href={ACCOUNT_LINKS.support}>Account support</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.help}>Technical help</ExternalAction>
          <ExternalAction href={ACCOUNT_LINKS.rules}>FAF rules</ExternalAction>
        </div>
      </SettingRow>
    </>
  );
}
