import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractNote, sourceHash } from "./import-early-changelog.mjs";

describe("archived wiki patchnotes", () => {
  it("reconciles the bundled notes with the reviewed source inventory", () => {
    const manifest = JSON.parse(readFileSync(new URL("./data/early-changelog-sources.json", import.meta.url), "utf8"));
    const bundle = JSON.parse(readFileSync(new URL("../crates/faf-domain/src/protocol/data/early_changelog.json", import.meta.url), "utf8"));
    expect(manifest.sources).toHaveLength(33);
    expect(bundle.notes).toHaveLength(28);
    expect(manifest.sources.filter(source => source.existing)).toHaveLength(5);
    expect(new Set(bundle.notes.map(note => note.id)).size).toBe(28);
    for (const source of manifest.sources.filter(source => !source.existing)) {
      const id = source.kind === "Legacy notes" ? `legacy-${source.id}` : source.id;
      const note = bundle.notes.find(note => note.id === id);
      expect(note).toMatchObject({ kind: source.kind, date: source.date, sourceUrl: source.sourceUrl });
      expect(note.context).toBeUndefined();
      expect(note.html).not.toMatch(/<(?:script|style|iframe|object|form)\b/i);
      if (!source.date) expect(note.year).toBe("");
    }
    expect(bundle.corrections).toEqual(manifest.corrections);
    expect(bundle.notes.find(note => note.id === "3633").kind).toBe("Beta patch");
    expect(bundle.notes.find(note => note.id === "3634").kind).toBe("Beta patch");
  });

  it("records Git milestones without promoting tag or testing dates to release dates", () => {
    const manifest = JSON.parse(readFileSync(new URL("./data/early-changelog-sources.json", import.meta.url), "utf8"));
    const bundle = JSON.parse(readFileSync(new URL("../crates/faf-domain/src/protocol/data/early_changelog.json", import.meta.url), "utf8"));
    const researched = manifest.sources.filter(source => source.gitEvidence?.length);
    expect(researched.map(source => source.id)).toEqual(["3608", "3613", "3614", "3615", "3616", "3619", "3620"]);
    for (const source of researched) {
      expect(source.date).toBe("");
      expect(source.datePrecision).toBe("unknown");
      expect(bundle.notes.find(note => note.id === source.id).date).toBe("");
      for (const evidence of source.gitEvidence) {
        expect(evidence.releaseDateVerified).toBe(false);
        expect(evidence.url).toBe(`https://github.com/FAForever/fa/commit/${evidence.commit}`);
      }
    }
    expect(researched.find(source => source.id === "3616").gitEvidence[0]).toMatchObject({ date: "2012-07-15", event: "testing opened" });
  });
  it("keeps nested facts and source links while excluding active content and wiki furniture", () => {
    const html = `<nav>Not a note</nav><div id="mw-content-text"><div id="toc">Duplicate contents</div>
      <h2><span>Balance</span><span class="mw-editsection">edit</span></h2>
      <ul><li>Cost: 100 -> 125<ul><li><b>Range:</b> 20</li></ul></li></ul>
      <p>See <a href="/index.php?title=3599">3599</a> and #3612.</p>
      <script>globalThis.archiveScriptExecuted = true</script><iframe src="https://example.invalid"></iframe>
      <p><a href="javascript:alert(1)">literal caption</a><img src="file:///private" alt="unit"></p></div>`;
    const result = extractNote(html, "wiki", "http://wiki.faforever.com/index.php?title=3612", "20150313032729");
    expect(result).toContain("<h2>Balance</h2>");
    expect(result).toContain("Cost: 100 -&gt; 125<ul><li><b>Range:</b> 20</li></ul>");
    expect(result).toContain("https://web.archive.org/web/20150313032729/http://wiki.faforever.com/index.php?title=3599");
    expect(result).toContain("#3612");
    expect(result).toContain("literal caption");
    expect(result).not.toMatch(/script|iframe|javascript:|file:|Duplicate contents|Not a note|>edit</);
    expect(globalThis.archiveScriptExecuted).toBeUndefined();
  });

  it("renders multiline wiki stats as ordinary lists without inventing values or dates", () => {
    const output = extractNote('<div id="mw-content-text"><p>T1 = 1\nT2 = 3\nT3 = 6</p></div>', "wiki", "https://example.invalid");
    expect(output).toBe("<ul><li>T1 = 1</li><li>T2 = 3</li><li>T3 = 6</li></ul>");
    expect(output).not.toContain("2015");
  });

  it("separates the original veterancy caption, stats and trailing explanation", () => {
    const output = extractNote('<div id="mw-content-text"><p>Experimentals veterancy levels :\n+ Level2 = 150,\n+ Level3 = 225,\nfor ML and ythotha, Megalith same as GC.</p></div>', "wiki", "https://example.invalid");
    expect(output).toBe("<p>Experimentals veterancy levels :</p><ul><li>Level2 = 150,</li><li>Level3 = 225,</li></ul><p>for ML and ythotha, Megalith same as GC.</p>");
  });

  it("unwraps wiki indentation blocks used for balance prose and preserves explicit links", () => {
    const output = extractNote('<div id="mw-content-text"><pre>Health reduced from 1200 to 800.\nMass reduced by 25%.</pre><pre>Level1 = 75\nLevel2 = 125</pre><pre>See <a href="https://example.invalid/source">original discussion</a>.</pre></div>', "wiki", "https://example.invalid");
    expect(output).toBe('<p>Health reduced from 1200 to 800.<br> Mass reduced by 25%.</p><ul><li>Level1 = 75</li><li>Level2 = 125</li></ul><p>See <a href="https://example.invalid/source">original discussion</a>.</p>');
  });

  it("preserves genuine source code and blog preformatted blocks", () => {
    const code = '<pre>local value = 150\nreturn value</pre><pre><code>T1 = 1\nT2 = 3</code></pre>';
    expect(extractNote(`<div id="mw-content-text">${code}</div>`, "wiki", "https://example.invalid")).toBe(code);
    const blog = '<pre>Level1 = 75\nLevel2 = 125</pre>';
    expect(extractNote(`<div class="entry-content">${blog}</div>`, "blog", "https://example.invalid")).toBe(blog);
  });

  it("separates illustration links from the original surrounding prose", () => {
    const output = extractNote('<div class="entry-content"><p>Select units.<img src="/example.jpg">Then press shift-G.</p></div>', "blog", "https://direct.faforever.com/2013/07/3626/");
    expect(output).toBe('<p>Select units. <a href="https://direct.faforever.com/example.jpg">Original illustration</a> Then press shift-G.</p>');
  });

  it("handles publisher JSON and line endings reproducibly, without mistaking formatting for new content", () => {
    const original = JSON.stringify({ title: "Patch", date: "2013-03-24", original: "https://example.invalid/post", body: "<p>100</p>" });
    const fetched = JSON.stringify({ title: { rendered: "Patch" }, date: "2013-03-24", link: "https://example.invalid/post", content: { rendered: "<p>100</p>" } });
    expect(sourceHash(original, "blog-json")).toBe(sourceHash(fetched, "blog-json"));
    expect(sourceHash("a\r\nb\n", "wiki")).toBe(sourceHash("a\nb", "wiki"));
    expect(sourceHash(fetched.replace("100", "101"), "blog-json")).not.toBe(sourceHash(original, "blog-json"));
  });

  it("keeps top-level section hierarchy and spaces inside inline emphasis", () => {
    const source = '<div id="mw-content-text"><h1>Lobby</h1><h2>General</h2><p><strong>Armageddon </strong>and<strong> Bokker</strong>; <em>command</em><strong> </strong>text.</p></div>';
    const output = extractNote(source, "wiki", "https://example.invalid");
    expect(output).toContain("<h2>Lobby</h2><h3>General</h3>");
    expect(output).toContain("<strong>Armageddon</strong> and <strong>Bokker</strong>");
    expect(output).toContain("<em>command</em> text.");
    expect(extractNote('<div class="entry-content"><h1>Changelog</h1><h2>Balance</h2></div>', "blog", "https://example.invalid"))
      .toBe("<p><strong>Changelog</strong></p><h2>Balance</h2>");
  });

  it("rejects missing, empty, oversized and excessively nested sources", () => {
    expect(() => extractNote("<p>Not an article</p>", "wiki", "https://example.invalid")).toThrow("Missing");
    expect(() => extractNote('<div id="mw-content-text"><script>1</script></div>', "wiki", "https://example.invalid")).toThrow("Empty");
    expect(() => extractNote("x".repeat(4 * 1024 * 1024 + 1), "wiki", "https://example.invalid")).toThrow("Oversized");
    expect(() => extractNote('<div id="mw-content-text">'+"<div>".repeat(35)+"text"+"</div>".repeat(35)+"</div>", "wiki", "https://example.invalid")).toThrow("limits");
  });
});
