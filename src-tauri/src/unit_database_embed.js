// Use the database's supported author-link hooks, only in its client frame.
(() => {
  if (
    window.top === window ||
    window.location.origin !== "https://unitdb.faforever.com"
  ) return;

  const forumLink = "https://forum.faforever.com/post/72705";
  window.authorLinkOverride = forumLink;

  // Also handle an already-mounted AuthorBlock without replacing its Vue ref.
  const authorLink = window.authorLink;
  if (authorLink && typeof authorLink === "object") {
    authorLink.value = forumLink;
  }
})();
