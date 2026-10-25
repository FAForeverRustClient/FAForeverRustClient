import { test } from "vitest";
import assert from "node:assert/strict";
import { assetPath, extractPage, fingerprint } from "./import-historical-changelog.mjs";

test("historical image paths must exist in the pinned tree and stay on the source host", () => {
  const assets = new Set(["images/Hunter.png", "images/space name.png"]);
  assert.equal(assetPath("/images/hunter.png", assets), "images/Hunter.png");
  assert.equal(assetPath("../images/Hunter.png", assets), "images/Hunter.png");
  assert.equal(assetPath("/images/space%20name.png", assets), "images/space%20name.png");
  for (const source of ["javascript:alert(1)", "data:image/png;base64,x", "file:///images/Hunter.png",
    "https://other.example/images/Hunter.png", "//other.example/images/Hunter.png",
    "/images/missing.png", "/images/Hunter.png?tracking=1", "/images/../secret.png"]) {
    assert.equal(assetPath(source, assets), null, source);
  }
});

test("the importer extracts heading context and exact prose associations without evaluating scripts", async () => {
  const html = `<title>Patch 3718</title><div class="content"><h1>Patch 3718</h1><h2>Land</h2>
    <div class="card"><h3><img src="/images/hunter.png">Hunter</h3>
    <p>This historical sentence explains a change to one unit without changing its published values.</p>
    <a href="https://github.com/FAForever/fa/pull/42">#42</a></div></div>
    <script>throw new Error('Historical scripts must never execute')</script>`;
  const result = await extractPage(html, "3718", new Set(["images/hunter.png"]));
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].name, "Hunter");
  assert.deepEqual(result.headings[0].context, ["Land"]);
  assert.deepEqual(result.headings[0].images, ["images/hunter.png"]);
  assert.deepEqual(result.headings[0].issues, ["42"]);
  assert.deepEqual(result.headings[0].paragraphs,
    [fingerprint("This historical sentence explains a change to one unit without changing its published values.")]);
});

test("shared cards do not assign common paragraphs or issue links to an individual unit", async () => {
  const html = `<title>Patch 3750</title><div class="content"><h1>Patch 3750</h1><h2>Land</h2><div class="card">
    <h3><img src="/images/titan.png">Titan</h3><h3><img src="/images/loyalist.png">Loyalist</h3>
    <p>This paragraph describes both units and must not be attributed to just one of their headings.</p>
    <a href="https://github.com/FAForever/fa/pull/42">#42</a></div></div>`;
  const result = await extractPage(html, "3750", new Set(["images/titan.png", "images/loyalist.png"]));
  assert.equal(result.headings.length, 2);
  assert(result.headings.every(heading => heading.paragraphs.length === 0 && heading.issues.length === 0));
});

test("source identity is checked and unavailable images are omitted without inventing IDs", async () => {
  const html = `<title>Patch 3718</title><div class="content"><h1>Patch 3718</h1>
    <h3><img src="/images/missing.png">Seraphim (Usha-Ah)</h3></div>`;
  const result = await extractPage(html, "3718", new Set());
  assert.deepEqual(result.headings[0].images, []);
  assert(result.headings[0].aliases.includes("Usha-Ah"));
  assert.equal(result.warnings.length, 1);
  await assert.rejects(extractPage(html, "3750", new Set()), /version mismatch/);
});

test("illustrated bold captions retain their section context without claiming shared prose", async () => {
  const html = `<title>Patch 3761</title><div class="content"><h1>Patch 3761</h1><h2>Land</h2>
    <div class="card"><h3>Tech 2 Amphibious Tanks</h3><p>This shared description must remain associated with the group.</p>
    <img src="/images/riptide.png"><b><u>Riptide</u></b><ul><li>Vision: 15 to 18</li></ul>
    <img src="/images/wagner.png"><b><u>Wagner</u></b></div></div>`;
  const { headings } = await extractPage(html, "3761", new Set(["images/riptide.png", "images/wagner.png"]));
  assert.deepEqual(headings.map(heading => heading.name), ["Riptide", "Wagner"]);
  assert(headings.every(heading => heading.context.join("/") === "Land/Tech 2 Amphibious Tanks"));
  assert(headings.every(heading => heading.paragraphs.length === 0));
});

test("bold captions grouped under one illustrated heading are recorded as its members", async () => {
  // 3718's "Nukes" card, whose three missiles a post lists as bullets of their own.
  const html = `<title>Patch 3718</title><div class="content"><h1>Patch 3718</h1><h2>Miscellaneous</h2>
    <div class="card"><h3><img src="/images/sml.png">Nukes</h3>
    <b><u>Experimental Nuclear Missile</u></b><ul><li>Health: 60 to 60000</li></ul>
    <b><u>Nuclear Missile</u></b><ul><li>Health: 25 to 25000</li></ul></div>
    <div class="card"><h3><img src="/images/t2airhq.png">Air Factory Rolloff</h3>
    <p>Air factory rolloff times have been equalized between factions.</p></div></div>`;
  const { headings } = await extractPage(html, "3718", new Set(["images/sml.png", "images/t2airhq.png"]));
  assert.deepEqual(headings[0].members, [fingerprint("Experimental Nuclear Missile"), fingerprint("Nuclear Missile")]);
  assert.equal(headings[1].members, undefined, "a card without captions records none");
});
