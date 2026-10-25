# Historical changelog illustrations

Older Markdown posts sometimes omit the unit pictures and heading structure
that their original balance pages contained. The client enriches those posts
using generated heading/image metadata from the public
[FAForever/patchnotes repository](https://github.com/FAForever/patchnotes).
Published descriptions, stat values and links stay in the current note.

The source revision is pinned in `scripts/import-historical-changelog.mjs`.
The importer reads inert HTML, checks the page version and verifies image paths
against that revision's file tree. It imports heading captions, context, image
references and fingerprints of unchanged paragraphs, without importing source
prose, scripts or styles. Conflicting versions are skipped. Missing image
references are reported and omitted.

To fetch the public source documents and regenerate the metadata:

```sh
node scripts/import-historical-changelog.mjs --fetch
```

This explicitly downloads only the fixed public repository tree and historical
pages into `target/historical-changelog-source`. Subsequent regeneration is
offline:

```sh
node scripts/import-historical-changelog.mjs
node scripts/import-historical-changelog.mjs --check
pnpm exec vitest run scripts/import-historical-changelog.test.mjs --maxWorkers=1
```

The generated data is
`crates/faf-domain/src/protocol/data/historical_changelog.json`. Matching and
content-preservation tests are in `protocol/changelog/historical.rs`. Caption
matches use their heading context; unchanged prose is associated only when its
fingerprint or issue reference identifies one source heading. Ambiguous
matches stay as written. Image-only headings have a null blueprint ID and use
the verified original image URL. Illustrated bold captions beside an image are
handled like subheadings.

Bold captions inside one heading's original card are also recorded as
fingerprints, such as the three missiles under 3718's Nukes. A post bullet with
such a caption restores that heading above it; stat lines are never matched
this way. When a description paragraph identifies a unit and the bullet
directly above it titles the change by its pull request, as each change in
3777 does, the unit heading goes above that bullet rather than between the
title and its description. Once one category in a list has become a section
heading, later categories beside it become headings at the same level, so
3718's Game Patch no longer reads as part of Vision Fix.

If a post contains only a summary or a link and none of its unit sections can
be matched, the client fetches the full original balance page from the same
pinned revision. It appends a separate **Original balance notes** section and
keeps the current post unchanged. This currently covers 3761, 3774, 3775 and
3776. Scripts, styles and site navigation are excluded; historical strike tags
are parsed as old/new value changes. The section has its own contents entries
and a link to its original source.
Its contents entries follow the original page's hierarchy: main sections, unit
groups and units remain navigable. Groups matter because many units are named
only by faction there: 3761 lists "Aeon" and "Cybran" under Frigates, Tech 1
Subs and Cruisers. Faction sublabels (3775), labels naming one unit of the
header above them ("Stinger" under "Stinger & Vulthoo") and source dates stay
in the article without filling the contents list.

Fenced Markdown text and rendered HTML `pre` elements become distinct code
blocks. Their line breaks, blank lines and relative indentation are retained;
headings, unit IDs and issue syntax inside them remain literal. The reader shows
a scrollable monospace box with a square copy button in a column of its own
beside the text, so no line runs underneath it. This restores the two unit
rosters in 3822 and the Lua example in 3745. Copies contain only the original
block text; a clipboard failure leaves it selectable.

The standard client find dialog remains on Ctrl+F. The top-right **Search all
patches** button opens an additional archive search using the shared modal.
Submitting a query searches descriptions, unit names, blueprint IDs, stat values,
code blocks and original balance sections across the published game index.
Queries stay local; only the public documents are downloaded. Twelve
concurrent reads, cancellation and a bounded 16 MiB session index keep searches
bounded. The first search reads about 170 small files and is bound by round
trips: four at a time took 13 to 25 seconds, twelve about 6. Notes are parsed
off the async runtime, so parsing one does not hold up the downloads beside it.
Each note's normalized text is built once and reused across queries. Cached
matches appear before outstanding downloads finish. Rolling search documents
expire after 60 seconds; opening a rolling note still fetches it fresh.
Failed or incomplete sources can be retried.

Dated source documents and original balance pages also use a separate 16 MiB
disk cache, limited to 512 files and seven days. Entries are keyed by a SHA-256
hash of their source URL, written atomically and reparsed by the current parser.
The index and rolling pages always fetch fresh. Cache I/O and eviction run off
the async runtime. Neither queries nor search results are persisted.

Search progress is batched every eight documents and limited to five updates
per second, plus initial and final states. The open reader subscribes only to
its entry and release state, so search
updates do not redraw its blocks. Choosing a result opens that patch and jumps
to the matching block.

Indented stat lists end before a following list item with less indentation.
This keeps the Cooper stats in 3822 separate from the next artillery change.
In a balance section, a fully bold caption that introduces a list becomes a
unit heading even without a trailing blueprint ID, as 3822 groups changes under
"All ACUs, as well as Aeon and Seraphim SACUs" and "Tactical Missile Launchers
(TMLs)". IDs anywhere in the caption give its icons ("Aeon ACU (UAL0001) Sensor
System"); otherwise a small table maps the unit classes these notes group by
(ACUs, SACUs, TMLs, TMDs) to their blueprints, narrowed by the factions named
in the same clause. A caption naming none keeps no icon rather than a guessed
one. Faction labels such as 3750's "UEF" or "Aeon, UEF" stay labels, and bold
captions outside a balance section, such as 3837's bug fixes, stay bold text.
Indented stat lines written without their own marker, as 3718 lists the Mech
Marine's and Selen's stats, are changes of the bullet above them. Read as
prose, they ended the list, ran the stats into one paragraph and restarted the
rest of the list a level too high.

Comma-separated numeric citations, such as `(#6481, #6482)`, link each reference
individually using the existing HTTPS GitHub issue route, which also opens PR
numbers. Wrapped contributor references stay in their original bullet rather
than becoming headings or contents entries. Numeric groups accept commas or
whitespace, including the missing commas between wrapped lines in 3728. They
remain limited to 1,024 bytes, 128 references and 20 digits per number.
Whitespace and punctuation are retained. Non-numeric or oversized
groups remain text, and inline/fenced code is not linked. Client release notes
continue to relink references to the client's repository.

The optional source request has a five-second timeout and a 4 MiB size limit.
Failure leaves the published summary readable and offers a retry. An incomplete
result is not reused from the session cache. No Wayback request is needed.

The 3689 source has conflicting version labels and stays untouched. The missing
3750 T2 Transports image is omitted while retaining its heading.

Updating the source revision requires regenerating the data, inspecting the
reported omissions and rechecking actual affected-note coverage.
