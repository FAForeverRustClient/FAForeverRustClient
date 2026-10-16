# Vault lookup catalogue cache

Map and mod lookup indexes are saved separately under the cache directory in
catalogue/maps.json.zst and catalogue/mods.json.zst. A schema-1 envelope records
the configured API base, the last full read time, the newest observed API change
timestamp and every field of each catalogue entry. Files are compressed, bounded,
and atomically replaced. Corrupt files, schema mismatches and API-base mismatches
are discarded and rebuilt.

A valid snapshot is published before any network read. Startup then quietly
requests entries whose parent or latest version changed at or after the saved
timestamp. Withdrawn latest versions remove their parent from the index. Empty
deltas retain the cursor. Failures and cancellation leave both the published
snapshot and its saved metadata intact. Weekly full reads remove deleted records
that timestamp queries cannot report. Explicit mod update checks always make a
network request, using a delta when a saved snapshot exists. These manual checks
queue behind a running startup refresh and announce Loading for the installed-mod
check to observe completion; startup refreshes remain quiet.

This is the folder/UID lookup index. Map, mod and replay browsing still uses live
server searches. Review totals and game counts in this index can remain stale
until a full read. Independently resolved map versions are retained across full
reads; stale ordinary catalogue entries are not.

## Timestamp query verification

The official FAF API source was checked on 2026-10-16:

- [AbstractEntity](https://github.com/FAForever/faf-java-api/blob/develop/src/main/java/com/faforever/api/data/domain/AbstractEntity.java)
  defines createTime and updateTime with Hibernate creation/update timestamps.
- [Map](https://github.com/FAForever/faf-java-api/blob/develop/src/main/java/com/faforever/api/data/domain/Map.java)
  and [Mod](https://github.com/FAForever/faf-java-api/blob/develop/src/main/java/com/faforever/api/data/domain/Mod.java)
  inherit these attributes. Their latestVersion uses a formula, so new versions
  must also be detected through the version's timestamps.
- [MapVersion](https://github.com/FAForever/faf-java-api/blob/develop/src/main/java/com/faforever/api/data/domain/MapVersion.java)
  and [ModVersion](https://github.com/FAForever/faf-java-api/blob/develop/src/main/java/com/faforever/api/data/domain/ModVersion.java)
  inherit the same timestamps and expose the hidden attribute.

The RSQL filter is an OR across updateTime, createTime,
latestVersion.updateTime and latestVersion.createTime. Bounds are inclusive so
entries with tied timestamps are replayed safely. The hidden=false filter is
intentionally absent from delta requests. All matching pages are read; sorting
only by the parent's timestamp cannot be used as an early-stop condition.
Watermarks come only from parent/version timestamps, never related profiles or
the local clock. A missing version or missing change timestamps aborts the read
rather than advancing the cursor past an undecodable entry.

## Pending authenticated and running-client checks

Anonymous catalogue requests returned HTTP 401, so source inspection and fixture
tests do not establish that the deployed API accepts every filter or returns
withdrawn entries to an ordinary account. With a signed-in client:

1. Start without snapshots, open Play and wait for both catalogues to finish.
2. Restart. Confirm map art is immediately available and no catalogue-loading
   activity appears. Inspect logs for a disk hit followed by delta requests.
3. Verify parent-only edits, a new latest version and hide/unhide changes appear
   in filtered map and mod results, including timestamp ties and pagination.
4. Confirm a failed or cancelled background read leaves the cached art/data ready.
5. Age a snapshot beyond seven days and confirm a quiet full read replaces it.
6. Use Installed mods' update check and confirm it requests fresh server data and
   finishes even when the delta is empty.
