# Vault lookup catalogue cache

Map and mod lookup indexes are saved separately under the cache directory in
catalogue/maps.json.zst and catalogue/mods.json.zst. A schema-1 envelope records
the configured API base, the last full read time, the newest observed API change
timestamp and every field of each catalogue entry. Files are compressed, bounded,
and atomically replaced. Corrupt files, schema mismatches and API-base mismatches
are discarded and rebuilt. A file that exists but cannot be opened (another
process holds it) is left alone for the next start.

A valid snapshot is published before any network read. Startup then quietly
requests entries whose parent or latest version changed since the saved
timestamp, minus an hour of overlap so that a change committed with an earlier
timestamp than one already seen is not skipped. Withdrawn latest versions remove
their parent from the index. A delta that changes nothing the snapshot holds is
neither published nor saved, unless it moves the cursor forward. Failures and
cancellation leave both the published snapshot and its saved metadata intact.

Weekly full reads remove deleted records that timestamp queries cannot report. A
failed weekly read falls back to a delta, so the snapshot still catches up, and
the full read stays due for the next start.

Explicit mod update checks always make a network request, using a delta when a
saved snapshot exists. A check waits for a running startup refresh to finish and
shows Loading until the server has answered, without publishing the saved copy
in between, so the installed-mod check reports on fresh data. Startup refreshes
remain quiet. A check that cannot reach the server still publishes the saved
copy for lookups and then reports the failure.

This is the folder/UID lookup index. Map, mod and replay browsing still uses live
server searches. Review totals and game counts in this index can remain stale
until a full read. Map versions resolved by folder during a session survive both
deltas and full reads; stale ordinary catalogue entries do not.

## Timestamp queries

Change detection relies on the FAF API's entity timestamps:

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
latestVersion.updateTime and latestVersion.createTime. Bounds are inclusive and
overlap the previous read, so replayed entries are expected and merged by key.
The hidden=false filter is intentionally absent from delta requests. All matching
pages are read; sorting only by the parent's timestamp cannot be used as an
early-stop condition. Watermarks come only from parent/version timestamps, never
related profiles or the local clock.

In a delta, a missing version or missing change timestamp aborts the read rather
than advancing the cursor past an undecodable entry. A full read skips and logs
such entries instead: it sets no cursor past them, and one bad record would
otherwise keep the whole catalogue from refreshing.
