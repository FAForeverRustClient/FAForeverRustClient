# Testing notifications

Open **Settings > Notifications > Desktop > Preview and test**. Choose an event and inspect its desktop popup, in-client toast or bell history entry. These use the components that display live notifications. Every example is labeled **Test**, and clicking its action records a simulated result.

**Preview appearance** shows the example regardless of notification preferences. **Keep previews visible** pauses automatic expiry for gallery cards and desktop appearance previews. **Replay preview** restores dismissed gallery cards. **Play selected sound** auditions the event's configured sound at the current notification volume.

**Test current settings** sends synthetic events through the client's delivery code. It applies the event switch, delivery channels, repeat cooldown, focus rules, desktop style and fallback. The results explain filtering, requested sound playback, acknowledged popup display and fallback failures. A system-notification request or sound request does not prove that Windows or the audio device presented it.

Choose **Three simultaneous notifications**, **Repeated event**, **Long message** or **Missing artwork** to check those cases. The repeat scenario is filtered according to the configured cooldown. Reset tests clears that test session's cooldown and results.

Both desktop popups and in-client toasts display up to three cards at once. Further notifications wait for a free slot and receive their full display duration when shown. Real found-match, full-game and party-invitation alerts appear immediately, keeping any displaced card queued. A held test preview yields to a real notification.

The shared **Popup duration (seconds)** control is near the top of Notification settings and accepts 2 to 60 seconds. It applies to desktop client popups and in-client toasts. The operating system controls its own notification duration. Repeat after, event/channel switches, visible-conversation suppression and focus/game rules still determine whether an event is announced at all.

For a background check, choose a five- or ten-second delay, send the test and switch to another application while leaving the dialog open. Closing the dialog cancels scheduled tests and removes its desktop previews. Client popups should appear without taking focus; exclusive fullscreen games may cover them. Check placement on each display and at the DPI settings in use, hover/focus pause, dismissal and simulated activation.

The fixtures exercise presentation and delivery after event creation. They do not reproduce server events or determine whether a fictional host passes a friends-only filter. Real event creation and actual destinations still need backend tests and occasional end-to-end checks.

Focused automated coverage lives in `NotificationTestDialog.dom.test.tsx`, `NotificationCenter.dom.test.tsx`, `NotificationPopup.dom.test.tsx`, `TimedToast.dom.test.tsx`, `notificationDelivery.test.ts` and `src-tauri/src/notification_popup.rs`. Native calls and sound are mocked in DOM tests; monitor geometry and the popup's command boundary have Rust unit coverage.
