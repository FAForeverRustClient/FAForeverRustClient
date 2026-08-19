import { describe, expect, it } from "vitest";
import { formatUserAgent } from "./PlayerOverview";

describe("formatUserAgent", () => {
  it("formats Java client user agents", () => {
    expect(formatUserAgent("faf-client")).toBe("Java client");
    expect(formatUserAgent("downlords-faf-client")).toBe("Java client");
    expect(formatUserAgent("Downlords-FAF-Client/2024.1.0")).toBe("Java client");
    expect(formatUserAgent("faf-client/2023.2.1")).toBe("Java client");
  });

  it("formats Python client user agents", () => {
    expect(formatUserAgent("faf-python-client")).toBe("Python client");
    expect(formatUserAgent("python-client")).toBe("Python client");
    expect(formatUserAgent("python")).toBe("Python client");
  });

  it("formats Rust client user agents", () => {
    expect(formatUserAgent("faf-rust-client")).toBe("Rust client");
    expect(formatUserAgent("forge-client")).toBe("Rust client");
    expect(formatUserAgent("rust")).toBe("Rust client");
  });

  it("falls back gracefully for missing or custom user agents", () => {
    expect(formatUserAgent(null)).toBe("N/A");
    expect(formatUserAgent(undefined)).toBe("N/A");
    expect(formatUserAgent("")).toBe("N/A");
    expect(formatUserAgent("   ")).toBe("N/A");
    expect(formatUserAgent("custom-faf-client-fork")).toBe("Java client");
    expect(formatUserAgent("SomeOtherTool/1.0")).toBe("SomeOtherTool/1.0");
  });
});
