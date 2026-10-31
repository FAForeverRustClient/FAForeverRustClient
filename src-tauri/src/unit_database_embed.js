// The embedded database's AuthorBlock contains only the support link:
// https://github.com/FAForever/etfreeman-db/blob/main/src/components/AuthorBlock.vue
// Hide both its desktop and mobile instances inside the client frame.
(() => {
  if (
    window.top === window ||
    window.location.protocol !== "https:" ||
    window.location.hostname.toLowerCase() !== "unitdb.faforever.com"
  ) return;

  const hideSupportLink = () => {
    const style = document.createElement("style");
    style.textContent = ".author { display: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  };

  if (document.documentElement) {
    hideSupportLink();
  } else {
    document.addEventListener("DOMContentLoaded", hideSupportLink, { once: true });
  }
})();
