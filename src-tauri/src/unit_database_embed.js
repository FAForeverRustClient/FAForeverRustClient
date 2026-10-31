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

  // Sandboxed iframe popups do not always reach the native new-window hook.
  // Use the same origin/source-validated bridge as News, for this link only.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const target = event.target instanceof Element
      ? event.target
      : event.target?.parentElement;
    const anchor = target?.closest("a[href]");
    if (anchor?.href !== forumLink) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    window.top.postMessage(
      { type: "faf:open-external-link", url: forumLink },
      "*",
    );
  }, true);
})();
