import { describe, expect, it } from "vitest";
import { useAppStore } from "../../store/store";
import { deliveryFor } from "./notificationDelivery";

describe("per-event delivery", () => {
  it("inherits the narrow desktop list while allowing an explicit event opt-in", () => {
    const preferences = useAppStore.getState().state.settings.notifications;
    expect(deliveryFor("matchFound", preferences).desktop).toBe(true);
    expect(deliveryFor("friendOnline", preferences).desktop).toBe(false);
    expect(deliveryFor("friendOnline", { ...preferences, delivery: { friendOnline: { sound: false, popup: false, desktop: true } } })).toEqual({ sound: false, popup: false, desktop: true });
  });
  it("does not let an event override disabled global delivery", () => {
    const preferences = { ...useAppStore.getState().state.settings.notifications, sound: false, popup: false, desktop: false, delivery: { matchFound: { sound: true, popup: true, desktop: true } } };
    expect(deliveryFor("matchFound", preferences)).toEqual({ sound: false, popup: false, desktop: false });
    expect(deliveryFor("matchFound", { ...preferences, enabled: false })).toEqual({ sound: false, popup: false, desktop: false });
  });
});
