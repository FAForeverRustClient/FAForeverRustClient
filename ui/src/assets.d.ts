declare module "*.png" {
  const url: string;
  export default url;
}

// The one bundled sound. Vite turns the import into a URL the page can fetch;
// see `ui/src/features/notifications/notificationSound.ts`.
declare module "*.mp3" {
  const url: string;
  export default url;
}
