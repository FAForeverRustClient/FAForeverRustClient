#!/usr/bin/env python3
"""Turn the terrain extract into the payload the API will serve.

`map_terrain.py` writes everything it can work out about a map, which is more
than the API needs: every texture path with its coverage, the shader, the source
file. That detail is worth keeping (it is what lets the classification be
revised without reading the maps again), and it is not what a client fetches.

This reduces it to the fields that answer the questions people actually ask:

    python api_payload.py terrain.jsonl --out map_tags.json

    {
      "folderName": "scmp_009.v0001",
      "waterPercent": 59,
      "biomes": [{"biome": "EVERGREEN", "percent": 100}],
      "family": "SETONS"
    }

`waterPercent` is what makes "naval map" answerable. `biomes` is the leading two
by coverage, because a map is at most two things worth naming and the rest is
trim. `family` is the other axis: which of the three heavily-varied maps this is
a version of, or null.

Maps that could not be read are left out entirely rather than written with empty
values, so a consumer never mistakes "unreadable" for "has no biome". They are
counted on stderr and can be listed with --list-skipped.

Requires Python 3.8+ and nothing else.
"""

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from map_terrain import (   # noqa: E402
    DEFAULT_SQL_KEY, SQL_HEADER, map_family, update_statement,
)

# A map is at most two things worth naming. Everything below the second share is
# edge blending, and carrying it would triple the payload for no question anyone
# asks.
MAX_BIOMES = 2


def build(record, max_biomes=MAX_BIOMES):
    """The API-facing view of one analysed map."""
    return {
        "folderName": record["name"],
        "waterPercent": record["waterPercent"],
        "biomes": [
            {"biome": share["biome"], "percent": share["percent"]}
            for share in record["biomes"][:max_biomes]
        ],
        "family": record.get("family") or map_family(record["name"]),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("jsonl", nargs="+", metavar="FILE",
                        help="one or more terrain extracts; later files win "
                             "where the same map appears twice")
    parser.add_argument("--out", metavar="FILE",
                        help="write here instead of stdout")
    parser.add_argument("--max-biomes", type=int, default=MAX_BIOMES, metavar="N",
                        help="how many biomes to keep per map (default: %(default)s)")
    parser.add_argument("--unkeyed", action="store_true",
                        help="include maps whose name is not a known map version. "
                             "Left out by default: they cannot address a row.")
    parser.add_argument("--sql", metavar="FILE",
                        help="also write the back-fill: one UPDATE per map")
    parser.add_argument("--sql-key", metavar="TEMPLATE", default=DEFAULT_SQL_KEY,
                        help="how a map name becomes the matched filename "
                             "(default: %(default)s)")
    parser.add_argument("--list-skipped", action="store_true",
                        help="print what was left out and why")
    args = parser.parse_args(argv)

    # Keyed by name so re-running over a folder in batches and passing every
    # extract still yields one entry per map, the newest reading winning.
    maps = {}
    statements = {}
    skipped = collections.Counter()
    reasons = collections.defaultdict(list)

    for path in args.jsonl:
        try:
            handle = open(path, encoding="utf-8")
        except OSError as error:
            print("could not read %s: %s" % (path, error), file=sys.stderr)
            return 1

        with handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue

                name = record.get("name")
                if not name:
                    continue

                if "error" in record:
                    # Not written at all: a consumer must never read
                    # "unreadable" as "analysed, and it has no biome".
                    skipped["unreadable"] += 1
                    reasons["unreadable"].append(name)
                    continue

                if record.get("unkeyed") and not args.unkeyed:
                    skipped["not a known map version"] += 1
                    reasons["not a known map version"].append(name)
                    continue

                maps[name.lower()] = build(record, args.max_biomes)

                if args.sql:
                    statement = update_statement(record, args.sql_key)
                    if statement:
                        statements[name.lower()] = statement

    payload = sorted(maps.values(), key=lambda entry: entry["folderName"].lower())
    text = json.dumps(payload, ensure_ascii=False, indent=2)

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as out:
            out.write(text + "\n")
        print("wrote %s (%d maps)" % (args.out, len(payload)), file=sys.stderr)
    else:
        print(text)

    if args.sql:
        with open(args.sql, "w", encoding="utf-8", newline="\n") as out:
            out.write(SQL_HEADER)
            for key in sorted(statements):
                out.write(statements[key] + "\n")
        print("wrote %s (%d statements)" % (args.sql, len(statements)),
              file=sys.stderr)

    for reason, count in skipped.most_common():
        print("left out, %s: %d" % (reason, count), file=sys.stderr)
        if args.list_skipped:
            for name in sorted(reasons[reason]):
                print("    %s" % name, file=sys.stderr)

    with_family = sum(1 for entry in payload if entry["family"])
    two = sum(1 for entry in payload if len(entry["biomes"]) > 1)
    print("%d carry a second biome, %d are in a named family"
          % (two, with_family), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
