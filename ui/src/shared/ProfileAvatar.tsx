/**
 * A player's avatar, with their initial as the fallback.
 *
 * FAF avatars are wide banners rather than portraits, which is why the image
 * case drops the initial's circle instead of cropping the picture into a disc:
 * the reference clients show them at their own shape too.
 */
export function ProfileAvatar({
  name,
  avatarUrl,
  tooltip,
}: {
  name: string;
  avatarUrl?: string | null;
  tooltip?: string | null;
}) {
  if (avatarUrl) {
    return (
      <span className="profile-avatar has-image" title={tooltip || undefined}>
        <img src={avatarUrl} alt="" loading="lazy" decoding="async" draggable={false} />
      </span>
    );
  }

  return (
    <span className="profile-avatar" aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
