#!/usr/bin/env python3
"""Build a page that shows each map's preview next to the tags computed for it.

The point is a check a person can actually make. Every other test here proves
the arithmetic against itself; this one puts the answer next to the picture and
lets you see whether "desert" looks like desert. A systematic mistake, in the
classification or in the mask reading, shows up immediately when you scroll.

    python review.py terrain.jsonl --out review.html
    python review.py terrain.jsonl --biome TUNDRA --out tundra.html
    python review.py terrain.jsonl --water naval --limit 100
    python review.py new.jsonl --changed-from old.jsonl --out changed.html
    python review.py terrain.jsonl --family SETONS --out setons.html

`--biome` lists every map whose *leading* biome is that one, which is what the
column stores. `--any` widens it to every map carrying that biome at all, which
is how you see what storing only the leading one leaves out.

Previews are loaded from the FAF content server by folder name, so the page
needs a connection to be useful. Maps whose preview is missing show a note
instead: for the co-op missions no preview was ever generated.

Requires Python 3.8+ and nothing else.
"""

import argparse
import html
import json
import os
import random
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from map_terrain import MAP_FAMILIES, map_family   # noqa: E402


PREVIEW_URL = "https://content.faforever.com/maps/previews/small/%s.png"

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>Map terrain review</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #181818; color: #f3f3f3;
         font: 14px/1.5 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .lede { margin: 0 0 20px; color: #9b9b9b; }
  .grid { display: grid; gap: 14px;
          grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
  .card { display: flex; flex-direction: column; gap: 6px; padding: 8px;
          border: 1px solid rgba(255,255,255,.1); border-radius: 8px;
          background: #202020; }
  .thumb { position: relative; aspect-ratio: 1; border-radius: 6px;
           overflow: hidden; background: #111; }
  .thumb img { width: 100%%; height: 100%%; object-fit: cover; display: block; }
  .thumb .missing { position: absolute; inset: 0; display: grid; place-items: center;
                    color: #6f6f6f; font-size: 12px; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; }
  .meta { color: #9b9b9b; font-size: 12px; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { padding: 1px 6px; border: 1px solid rgba(255,255,255,.16);
         border-radius: 4px; font-size: 11px; color: #9b9b9b; }
  .tag.lead { color: #f3f3f3; }
  .tag.water { color: #4b9de8; border-color: rgba(75,157,232,.45); }
  .tag.none { color: #d6a35d; border-color: rgba(214,163,93,.45); }
  .tag.was { color: #e06c75; border-color: rgba(224,108,117,.45);
             text-decoration: line-through; }
  .tag.family { color: #d5ad45; border-color: rgba(213,173,69,.5); }
</style>
<h1>Map terrain review</h1>
<p class="lede">%(lede)s</p>
<div class="grid">
%(cards)s
</div>
"""

CARD = """  <div class="card">
    <div class="thumb">
      <span class="missing">no preview</span>
      <img loading="lazy" src="%(url)s" alt="" onerror="this.remove()">
    </div>
    <div class="name" title="%(name)s">%(name)s</div>
    <div class="meta">%(meta)s</div>
    <div class="tags">%(tags)s</div>
  </div>"""


def load(path):
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if "error" not in record:
                records.append(record)
    return records


def card(record):
    tags = []
    family = map_family(record["name"])
    if family:
        tags.append('<span class="tag family">%s</span>' % html.escape(family))
    if record.get("was"):
        # What this map used to be called, so the two can be judged together
        # rather than by flipping between pages.
        tags.append('<span class="tag was">was %s</span>' % html.escape(record["was"]))
    for index, share in enumerate(record["biomes"]):
        tags.append('<span class="tag%s">%s %d%%</span>'
                    % (" lead" if index == 0 else "",
                       html.escape(share["biome"]), share["percent"]))
    if not record["biomes"]:
        tags.append('<span class="tag none">no biome</span>')
    tags.append('<span class="tag water">%d%% water</span>' % record["waterPercent"])
    return CARD % {
        # Folder names carry spaces and apostrophes, so the name is percent
        # encoded before it goes in the URL and HTML escaped after.
        "url": html.escape(PREVIEW_URL % urllib.parse.quote(record["name"]), quote=True),
        "name": html.escape(record["name"]),
        "meta": "%d x %d, scmap v%d" % (record["width"], record["height"],
                                        record["scmapVersion"]),
        "tags": "".join(tags),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("jsonl", help="the output of map_terrain.py")
    parser.add_argument("--out", default="review.html", metavar="FILE")
    parser.add_argument("--biome", metavar="VALUE",
                        help="only maps whose leading biome is this, e.g. TUNDRA")
    parser.add_argument("--without-families", action="store_true",
                        help="drop the three named map families from a --biome "
                             "listing. Off by default: terrain and family are "
                             "different questions, and a Setons map is still an "
                             "evergreen map.")
    parser.add_argument("--any", action="store_true",
                        help="widen it to every map carrying that biome at all, "
                             "which shows what storing only the leading one omits")
    parser.add_argument("--family", metavar="VALUE",
                        help="only maps in this family: %s. Recognised by name, "
                             "so every spelling of Dual Gap lands together."
                             % ", ".join(f for f, _ in MAP_FAMILIES))
    parser.add_argument("--water", choices=("land", "mixed", "naval"),
                        help="only maps in this water bracket")
    parser.add_argument("--changed-from", metavar="FILE",
                        help="only maps whose leading biome differs from this "
                             "earlier run, labelled with both. The sharpest "
                             "check there is after a change to the weighing.")
    parser.add_argument("--limit", type=int, default=0, metavar="N",
                        help="show at most N, sampled (default: all of them)")
    parser.add_argument("--seed", type=int, default=0, metavar="N",
                        help="sampling seed, so a review can be repeated")
    args = parser.parse_args(argv)

    records = load(args.jsonl)
    if not records:
        print("nothing readable in %s" % args.jsonl, file=sys.stderr)
        return 1
    total = len(records)

    described = []
    if args.family:
        family = args.family.strip().upper()
        # Computed from the name rather than read from the file, so an extract
        # made before families existed still works.
        records = [r for r in records if map_family(r["name"]) == family]
        records.sort(key=lambda r: r["name"].lower())
        described.append("in the %s family" % family)

    wanted = args.biome.strip().upper() if args.biome else None
    if wanted and args.without_families:
        left = sum(1 for r in records if map_family(r["name"]))
        records = [r for r in records if not map_family(r["name"])]
        if left:
            described.append("%d in a named family left out" % left)
    if wanted:
        # The same rule the column stores: a map is the biome covering most of
        # it. Reviewing anything looser would be reviewing something that never
        # ships, which is how a check ends up agreeing with nothing.
        def share_of(record):
            return next((b["percent"] for b in record["biomes"]
                         if b["biome"] == wanted), 0)

        def leads(record):
            return bool(record["biomes"]) and record["biomes"][0]["biome"] == wanted

        records = [r for r in records if (share_of(r) > 0 if args.any else leads(r))]
        # Strongest first, so the weakest examples, the ones worth arguing
        # about, end up together at the end.
        records.sort(key=lambda r: (-share_of(r), r["name"]))
        described.append("carrying %s" % wanted if args.any
                         else "whose leading biome is %s" % wanted)
    if args.water:
        bounds = {"land": (0, 15), "mixed": (16, 49), "naval": (50, 100)}[args.water]
        records = [r for r in records if bounds[0] <= r["waterPercent"] <= bounds[1]]
        described.append("%s maps" % args.water)

    if args.changed_from:
        before = {}
        for record in load(args.changed_from):
            before[record["name"].lower()] = (record["biomes"][0]["biome"]
                                              if record["biomes"] else "(none)")
        changed = []
        for record in records:
            was = before.get(record["name"].lower())
            now = record["biomes"][0]["biome"] if record["biomes"] else "(none)"
            if was is not None and was != now:
                record["was"] = was
                changed.append(record)
        records = changed
        described.append("whose leading biome changed since %s" % args.changed_from)

    matched = len(records)
    if args.limit and matched > args.limit:
        # A sample rather than the first N: the file is in name order, so the
        # head of it is all maps whose names start with a digit. Only when a
        # limit was asked for: "show me the tundra maps" means all of them.
        random.Random(args.seed).shuffle(records)
        records = records[:args.limit]
        if wanted:
            records.sort(key=lambda r: (-next((b["percent"] for b in r["biomes"]
                                               if b["biome"] == wanted), 0), r["name"]))

    lede = ("%d of %d maps%s. Each preview is the map; the tags beside it are what "
            "was read out of its terrain. They should agree." %
            (len(records), total,
             ", " + " and ".join(described) if described else ""))
    if wanted:
        lede += (" Sorted by how much of the map is %s, so the arguable ones are"
                 " at the end." % wanted)
        if not args.any:
            lede += (" This is what the column stores; pass --any to see every"
                     " map that merely contains some.")

    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(PAGE % {"lede": html.escape(lede),
                             "cards": "\n".join(card(r) for r in records)})
    print("wrote %s (%d of %d matched)" % (args.out, len(records), matched),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
