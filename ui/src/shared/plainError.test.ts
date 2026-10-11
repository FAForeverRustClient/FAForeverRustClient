import { describe, expect, it } from "vitest";
import { plainError } from "./plainError";
import { en } from "../i18n/catalog/en";

describe("plainError", () => {
  it("reads a locked folder from the os error, whatever language the system wrote it in", () => {
    // The report: a mod install on a German Windows.
    const reason =
      "could not finish installing C:\\ProgramData\\FAForever\\user\\My Games\\Gas Powered Games\\Supreme Commander Forged Alliance\\mods\\StrategicDefenceRangePreview: Zugriff verweigert (os error 5)";
    expect(plainError(reason)).toBe(en["errors.cause.locked"]);
    expect(plainError("Permission denied (os error 13)")).toBe(en["errors.cause.locked"]);
  });

  it("tells a file in use, a full disk and a missing path apart", () => {
    expect(plainError("The process cannot access the file (os error 32)")).toBe(en["errors.cause.inUse"]);
    expect(plainError("No space left on device (os error 28)")).toBe(en["errors.cause.diskFull"]);
    expect(plainError("Das System kann den angegebenen Pfad nicht finden. (os error 3)")).toBe(en["errors.cause.missing"]);
  });

  it("names network failures and HTTP statuses", () => {
    expect(plainError("error sending request for url (https://api.faforever.com/data/mod)")).toBe(en["errors.cause.offline"]);
    expect(plainError("operation timed out")).toBe(en["errors.cause.timeout"]);
    expect(plainError("HTTP 404 from the content server")).toBe(en["errors.cause.notFound"]);
    expect(plainError("server returned status 503")).toBe(en["errors.cause.server"]);
    expect(plainError("not logged in")).toBe(en["errors.cause.signIn"]);
  });

  it("keeps a sentence the client wrote itself", () => {
    const own = "That avatar is not in the server-provided list.";
    expect(plainError(own)).toBe(own);
  });

  it("tidies what it does not recognise: no long paths, no snake case, a full stop", () => {
    expect(plainError("game_not_found")).toBe("Game not found.");
    expect(plainError("could not read D:\\Games\\FA\\maps\\scmp_009\\scmp_009_scenario.lua: bad header")).toBe(
      "Could not read scmp_009_scenario.lua: bad header.",
    );
  });
});
