# Changelog unit pictures

Some images in the original balance-note archive have strategic or status
symbols baked into a corner of the unit picture. These are redundant beside
the unit caption and difficult to read at contents-thumbnail sizes.

`ui/src/shared/changelogUnitIcons.ts` maps 73 verified legacy image paths to
the corresponding clean pictures already published under
`https://faforever.github.io/fa/assets/icons/`. The article, historical captions
and contents thumbnails all use the same mapping.

The legacy images are pinned to `FAForever/patchnotes` revision
`0d01e845da4d72173492751d153771ee17a0f079`. The matches were checked against
the clean unit artwork, comparing the picture independently of its corner
symbols and allowing for the old files' different border sizes. For example,
`images/nukesub.png` is UEF's `UES0304`, and
`images/UEF_T2_Shield_Boat.png` is `XES0205`. The mapping follows the image
itself, including representative pictures used for multi-unit changes;
it does not infer an identity from a patch's heading or unit code.

Only these exact pinned source URLs are replaced. Unknown images, enhancement
glyphs, category artwork and existing clean icons retain their sources.
Original patch text, illustration metadata and provenance are preserved.
No source artwork is cropped, painted over or regenerated.

## Local picture cache

Recognized unit pictures prefer the installed game's existing `unit-icon`
cache. The source URL identifies the artwork after applying the mapping;
captions and unit labels do not override that identity. The shared catalogue
request is retained with its result for the session, so returning to a note
or switching between the article and contents does not wait for another lookup.

While the small catalogue is loading, pictures keep their reserved dimensions
without starting remote downloads. Text remains readable. Pictures load lazily
from the existing local protocol, which reuses decoded PNGs on disk. Missing
installations, missing local pictures and decode failures retain the original
web artwork as a fallback. Unknown images and enhancement glyphs keep their
existing sources and do not start a catalogue lookup.
