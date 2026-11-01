//! Pinned early patchnotes, including cumulative notes of unverified lineage.
//! Their capture timestamps are provenance, never release dates.

use std::sync::OnceLock;

use serde::Deserialize;

use super::{ChangelogBlock, ChangelogEntry, ChangelogListItem, ChangelogRelease, ChangelogSpan};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    patch: String,
    kind: String,
    date: String,
    year: String,
    source_url: String,
    html: String,
    evidence: String,
}

#[derive(Deserialize)]
struct Correction {
    id: String,
    date: String,
}

#[derive(Deserialize)]
struct Archive {
    notes: Vec<Note>,
    corrections: Vec<Correction>,
}

fn archive() -> &'static Archive {
    static ARCHIVE: OnceLock<Archive> = OnceLock::new();
    ARCHIVE.get_or_init(|| {
        serde_json::from_str(include_str!("../data/early_changelog.json"))
            .expect("the source-verified early changelog archive must be valid")
    })
}

/// Identify an embedded historical source without parsing its content.
pub fn is_early_release(release: &ChangelogRelease) -> bool {
    archive()
        .notes
        .iter()
        .any(|note| note.id == release.id && note.source_url == release.source_url)
}

fn rank(release: &ChangelogRelease) -> u8 {
    if release.is_rolling() {
        3
    } else if release.kind == "Legacy notes" {
        0
    } else if release.date.is_empty() {
        1
    } else {
        2
    }
}

/// Keep current published notes where they exist; add missing historical ones.
/// Corrections change the displayed date, never the source filename/URL.
/// Git milestones in the import ledger are not release dates: 3616's first
/// named commit opens testing, while 3609 was tagged after its announcement.
/// An undated imported note must therefore stay undated until a source proves
/// public release, even when its development/tagging day is known.
pub fn with_early_releases(mut releases: Vec<ChangelogRelease>) -> Vec<ChangelogRelease> {
    for correction in &archive().corrections {
        if let Some(release) = releases.iter_mut().find(|release| {
            release.id == correction.id
                && release
                    .web_url
                    .starts_with("https://faforever.github.io/fa/changelog/")
        }) {
            release.date.clone_from(&correction.date);
            release.year = correction.date[..4].to_string();
        }
    }
    for note in &archive().notes {
        if releases.iter().any(|release| release.id == note.id) {
            continue;
        }
        releases.push(ChangelogRelease {
            id: note.id.clone(),
            kind: note.kind.clone(),
            date: note.date.clone(),
            year: note.year.clone(),
            source_url: note.source_url.clone(),
            web_url: note.source_url.clone(),
        });
    }
    releases.sort_by(|left, right| {
        if left.is_rolling() && right.is_rolling() {
            return std::cmp::Ordering::Equal;
        }
        rank(right)
            .cmp(&rank(left))
            .then_with(|| right.date.cmp(&left.date))
            .then_with(|| right.id.cmp(&left.id))
    });
    releases
}

fn literal_references(spans: &mut [ChangelogSpan], source: &str) {
    for span in spans {
        if let ChangelogSpan::Issue { number, label, url } = span {
            let text = label.clone().unwrap_or_else(|| format!("#{number}"));
            let escaped = url
                .replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            // Keep links actually supplied by the author. Only inferred modern
            // GitHub issue links are removed from these pre-GitHub citations.
            *span = if source.contains(&format!("href=\"{escaped}\"")) {
                ChangelogSpan::Link {
                    text,
                    url: url.clone(),
                }
            } else {
                ChangelogSpan::Text(text)
            };
        }
    }
}

fn literal_list_references(items: &mut [ChangelogListItem], source: &str) {
    for item in items {
        literal_references(&mut item.spans, source);
        literal_list_references(&mut item.children, source);
    }
}

/// One-bullet lists in a row, as one list. The wiki wrote some notes a bullet
/// at a time, each its own `<ul>` (five in a row in 3608), which drew a
/// paragraph's gap between bullets that belong together. A list of several
/// bullets is a list of its own and keeps its neighbours apart: in 3616 the
/// four new XP values are followed straight away by an unrelated one-bullet
/// change, which must not read as a fifth value. Items keep order and text.
fn merge_adjacent_lists(blocks: Vec<ChangelogBlock>) -> Vec<ChangelogBlock> {
    let mut merged: Vec<ChangelogBlock> = Vec::with_capacity(blocks.len());
    // Whether the last block is a list built from one-bullet lists only.
    let mut singles = false;
    for block in blocks {
        match block {
            ChangelogBlock::List { items } if items.len() == 1 && items[0].ordinal.is_none() => {
                if let (true, Some(ChangelogBlock::List { items: previous })) =
                    (singles, merged.last_mut())
                {
                    previous.extend(items);
                } else {
                    merged.push(ChangelogBlock::List { items });
                    singles = true;
                }
            }
            block => {
                merged.push(block);
                singles = false;
            }
        }
    }
    merged
}

fn split_inline_bullets(items: Vec<ChangelogListItem>) -> Vec<ChangelogListItem> {
    let mut result = Vec::new();
    for mut item in items {
        item.children = split_inline_bullets(item.children);
        // Legacy 3605 pasted a second bullet into the Restorer prose. Restrict
        // this repair to plain, childless bullets, leaving code and values alone.
        if item.ordinal.is_none() && item.change.is_none() && item.children.is_empty() {
            if let [ChangelogSpan::Text(text)] = item.spans.as_slice() {
                if text.contains(" • ") {
                    result.extend(text.split(" • ").map(|part| ChangelogListItem {
                        ordinal: None,
                        spans: vec![ChangelogSpan::Text(part.trim().to_string())],
                        change: None,
                        children: Vec::new(),
                    }));
                    continue;
                }
            }
        }
        result.push(item);
    }
    result
}

fn repair_legacy_lists(id: &str, blocks: Vec<ChangelogBlock>) -> Vec<ChangelogBlock> {
    let mut result = Vec::with_capacity(blocks.len());
    let mut blocks = blocks.into_iter().peekable();
    while let Some(mut block) = blocks.next() {
        if id == "legacy-3605" {
            if let ChangelogBlock::List { items } = block {
                result.push(ChangelogBlock::List {
                    items: split_inline_bullets(items),
                });
                continue;
            }
        }
        if id == "3615" {
            if let ChangelogBlock::Paragraph { spans } = &mut block {
                // The wiki mixed literal dashes, italic captions and real lists.
                // Keep captions as captions; the complete Gunship sentence is a
                // list item, continuing the other Tier 2 changes that follow it.
                let marked = match spans.first_mut() {
                    Some(ChangelogSpan::Text(text) | ChangelogSpan::Strong(text)) => {
                        if let Some(unmarked) = text.strip_prefix('-') {
                            let unmarked = unmarked.trim_start();
                            if unmarked.is_empty() || unmarked.starts_with(char::is_alphabetic) {
                                *text = unmarked.to_string();
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                    _ => false,
                };
                let sentence = spans
                    .iter()
                    .filter_map(|span| match span {
                        ChangelogSpan::Text(text) | ChangelogSpan::Strong(text) => {
                            Some(text.as_str())
                        }
                        _ => None,
                    })
                    .collect::<String>();
                // The source also has an otherwise empty dash between naval captions.
                if marked && sentence.trim().is_empty() {
                    continue;
                }
                if marked && sentence.trim_end().ends_with('.') {
                    let item = ChangelogListItem {
                        ordinal: None,
                        spans: std::mem::take(spans),
                        change: None,
                        children: Vec::new(),
                    };
                    let mut items = vec![item];
                    if matches!(blocks.peek(), Some(ChangelogBlock::List { items })
                        if items.iter().all(|item| item.ordinal.is_none()))
                    {
                        if let Some(ChangelogBlock::List { items: following }) = blocks.next() {
                            items.extend(following);
                        }
                    }
                    result.push(ChangelogBlock::List { items });
                    continue;
                }
            }
        }
        result.push(block);
    }
    result
}

/// An exact identity/source match is required. An arbitrary incoming URL never
/// selects a different embedded note, and no archive network request is made.
pub fn early_entry(release: &ChangelogRelease) -> Option<ChangelogEntry> {
    let note = archive()
        .notes
        .iter()
        .find(|note| note.id == release.id && note.source_url == release.source_url)?;
    // Raw captures remain hash-pinned. Repair their list presentation here;
    // the importer tidies punctuation spacing, as the attribution discloses.
    let mut blocks = merge_adjacent_lists(repair_legacy_lists(
        &note.id,
        super::parse_html_blocks(&note.html),
    ));
    for block in &mut blocks {
        match block {
            ChangelogBlock::Paragraph { spans } => literal_references(spans, &note.html),
            ChangelogBlock::List { items } => literal_list_references(items, &note.html),
            _ => {}
        }
    }
    // Attribution is metadata after the original article, never an invented
    // introduction or replacement description for the historical changes.
    blocks.push(ChangelogBlock::Provenance {
        source_url: note.source_url.clone(),
        evidence_url: note.evidence.clone(),
    });
    Some(ChangelogEntry {
        id: note.id.clone(),
        title: format!("Patch {}", note.patch),
        blocks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> ChangelogEntry {
        let release = with_early_releases(vec![])
            .into_iter()
            .find(|release| release.id == id)
            .unwrap();
        early_entry(&release).unwrap()
    }

    fn text(spans: &[ChangelogSpan]) -> String {
        spans
            .iter()
            .map(|span| match span {
                ChangelogSpan::Text(text)
                | ChangelogSpan::Strong(text)
                | ChangelogSpan::Code(text) => text.clone(),
                ChangelogSpan::Link { text, .. } => text.clone(),
                ChangelogSpan::Issue { number, label, .. } => {
                    label.clone().unwrap_or_else(|| format!("#{number}"))
                }
            })
            .collect()
    }

    #[test]
    fn legacy_3615_repairs_caption_markers_and_the_gunship_bullet() {
        let entry = entry("3615");
        let captions: Vec<_> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::Paragraph { spans } => Some(text(spans)),
                _ => None,
            })
            .collect();
        assert!(captions
            .iter()
            .all(|caption| !caption.trim_start().starts_with('-') && !caption.is_empty()));
        for caption in [
            "air scouts",
            "Sera T1 arty:",
            "UEF BattleCruiser:",
            "Soul Ripper:",
            "Galactic Colossus Veterancy",
        ] {
            assert!(
                captions.iter().any(|found| found == caption),
                "{caption}: {captions:?}"
            );
        }
        assert!(entry.blocks.iter().any(|block| matches!(block,
            ChangelogBlock::List { items } if items.len() >= 2
                && text(&items[0].spans) == "T2 Gunship: Health reduced to 80% of the original value."
                && text(&items[1].spans) == "Siren proto cannon buff to 92."
        )));
        // Keep arithmetic signs and negative values outside literal markers intact.
        let control = super::super::parse_html_blocks("<p>-5 energy</p><p>+ 15 range</p>");
        assert_eq!(repair_legacy_lists("3615", control.clone()), control);
    }

    #[test]
    fn legacy_3605_splits_restorer_changes_without_rewriting_their_values() {
        let entry = entry("legacy-3605");
        let items = entry
            .blocks
            .iter()
            .find_map(|block| match block {
                ChangelogBlock::List { items }
                    if items
                        .iter()
                        .any(|item| text(&item.spans).starts_with("Restorer max")) =>
                {
                    Some(items)
                }
                _ => None,
            })
            .unwrap();
        let index = items
            .iter()
            .position(|item| text(&item.spans).starts_with("Restorer max"))
            .unwrap();
        assert_eq!(text(&items[index].spans), "Restorer max airspeed reduced to 8 from 10, health reduced to 6500 from 7200 and anti ground damage per shot reduced to 24 from 32. AA weapon damage increased to 71 * 2 from 65 * 2.");
        assert_eq!(
            text(&items[index + 1].spans),
            "Restorers cost 50% + 400 more energy than a Air Superiority fighter now."
        );
        assert!(items[index].children.is_empty());
    }

    #[test]
    fn early_archive_retains_numbered_steps_and_nested_faction_lists() {
        let entry = entry("3626");
        let steps = entry
            .blocks
            .iter()
            .find_map(|block| match block {
                ChangelogBlock::List { items }
                    if text(&items[0].spans).starts_with("Select some of your units.") =>
                {
                    Some(items)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            steps.iter().map(|item| item.ordinal).collect::<Vec<_>>(),
            [Some(1), Some(2), Some(3)]
        );
        assert_eq!(text(&steps[1].spans), "Press shift-G.");
        let entry = self::entry("3629");
        fn find_numbered(items: &[ChangelogListItem]) -> Option<&ChangelogListItem> {
            items.iter().find_map(|item| {
                if text(&item.spans).starts_with("One Projectile at a time") {
                    Some(item)
                } else {
                    find_numbered(&item.children)
                }
            })
        }
        let mobile_aa = entry
            .blocks
            .iter()
            .find_map(|block| match block {
                ChangelogBlock::List { items } => find_numbered(items),
                _ => None,
            })
            .unwrap();
        assert_eq!(mobile_aa.ordinal, Some(1));
        let factions = &mobile_aa.children;
        assert_eq!(
            factions.iter().map(|item| item.ordinal).collect::<Vec<_>>(),
            [Some(1), Some(2)]
        );
        assert!(factions.iter().all(|faction| !faction.children.is_empty()
            && faction.children.iter().all(|item| item.ordinal.is_none())));
    }

    #[test]
    fn early_archive_formatting_preserves_every_source_word_in_order() {
        fn list_text(items: &[ChangelogListItem], output: &mut String) {
            for item in items {
                output.push_str(&text(&item.spans));
                output.push('\n');
                list_text(&item.children, output);
            }
        }
        fn words(blocks: &[ChangelogBlock]) -> Vec<String> {
            let mut output = String::new();
            for block in blocks {
                match block {
                    ChangelogBlock::Heading { text, .. } | ChangelogBlock::CodeBlock { text } => {
                        output.push_str(text)
                    }
                    ChangelogBlock::Paragraph { spans } => output.push_str(&text(spans)),
                    ChangelogBlock::List { items } => list_text(items, &mut output),
                    ChangelogBlock::Unit { name, .. } => output.push_str(name),
                    ChangelogBlock::HistoricalBalance { .. }
                    | ChangelogBlock::Provenance { .. } => {}
                }
                output.push('\n');
            }
            output
                .split(|ch: char| !ch.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .map(String::from)
                .collect()
        }
        for note in &archive().notes {
            assert_eq!(
                words(&entry(&note.id).blocks),
                words(&super::super::parse_html_blocks(&note.html)),
                "{}",
                note.id
            );
        }
    }

    #[test]
    fn early_archive_keeps_explicit_numeric_links_without_inventing_pr_links() {
        let mut spans = vec![
            ChangelogSpan::Issue {
                number: "3612".into(),
                label: None,
                url: "https://github.com/FAForever/fa/issues/3612".into(),
            },
            ChangelogSpan::Issue {
                number: "14".into(),
                label: None,
                url: "https://forums.faforever.com/viewtopic.php?t=14&f=2".into(),
            },
        ];
        literal_references(
            &mut spans,
            r#"<a href="https://forums.faforever.com/viewtopic.php?t=14&amp;f=2">#14</a>"#,
        );
        assert_eq!(spans[0], ChangelogSpan::Text("#3612".into()));
        assert!(matches!(&spans[1], ChangelogSpan::Link { url, .. } if url.ends_with("t=14&f=2")));
    }

    #[test]
    fn early_archive_preserves_identity_dates_and_modern_sources() {
        let original = ChangelogRelease {
            id: "3639".into(),
            kind: "Game Patch".into(),
            date: "2015-02-05".into(),
            year: "2015".into(),
            source_url: super::super::post_source_url("2015-02-05", "3639"),
            web_url: "https://faforever.github.io/fa/changelog/3639".into(),
        };
        let mut duplicate = original.clone();
        duplicate.id = "3612".into();
        let releases = with_early_releases(vec![original.clone(), duplicate]);
        assert_eq!(releases.len(), 29);
        assert_eq!(
            releases
                .iter()
                .filter(|release| release.id == "3612")
                .count(),
            1
        );
        let corrected = releases
            .iter()
            .find(|release| release.id == "3639")
            .unwrap();
        assert_eq!(corrected.date, "2015-01-05");
        assert_eq!(corrected.source_url, original.source_url);
        assert!(early_entry(corrected).is_none());
        let unknown = releases
            .iter()
            .find(|release| release.id == "3616")
            .unwrap();
        assert!(unknown.date.is_empty());
        assert!(!unknown.is_rolling());
        assert!(early_entry(unknown).is_some());
        let legacy = releases
            .iter()
            .find(|release| release.id == "legacy-3605")
            .unwrap();
        assert_eq!(legacy.kind, "Legacy notes");
        assert!(early_entry(legacy).unwrap().title.contains("3605"));
        let original = early_entry(legacy).unwrap();
        assert!(
            matches!(&original.blocks[0], ChangelogBlock::Paragraph { spans }
            if matches!(&spans[0], ChangelogSpan::Text(text) if text.starts_with("Complete changelog from 3599 to 3605.")))
        );
        assert_eq!(with_early_releases(releases.clone()), releases);
    }

    #[test]
    fn bullets_written_one_list_at_a_time_read_as_one_list() {
        let single = |block: &ChangelogBlock| matches!(block, ChangelogBlock::List { items } if items.len() == 1);
        for release in with_early_releases(vec![]) {
            let entry = early_entry(&release).unwrap();
            assert!(
                !entry
                    .blocks
                    .windows(2)
                    .any(|pair| single(&pair[0]) && single(&pair[1])),
                "{} has two one-bullet lists in a row",
                release.id
            );
        }
        let release = with_early_releases(vec![])
            .into_iter()
            .find(|release| release.id == "3608")
            .unwrap();
        let lists: Vec<usize> = early_entry(&release)
            .unwrap()
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::List { items } => Some(items.len()),
                _ => None,
            })
            .collect();
        assert!(lists.iter().any(|&items| items >= 5), "{lists:?}");
    }

    #[test]
    fn the_attribution_line_is_shown_but_not_searched() {
        let releases = with_early_releases(vec![]);
        let release = releases
            .iter()
            .find(|release| release.id == "3616")
            .unwrap();
        let entry = early_entry(release).unwrap();
        let Some(ChangelogBlock::Provenance { source_url, .. }) = entry.blocks.last() else {
            panic!("historical note must end with source attribution");
        };
        let document = super::super::ChangelogSearchDocument::new(&entry);
        // Neither its address nor any of its words: the reader's language
        // words it, and the search reads only the note itself.
        for footer_only in [
            source_url.to_lowercase().as_str(),
            "original source",
            "editorial note",
        ] {
            assert!(document.search(footer_only).is_none(), "{footer_only}");
        }
    }

    #[test]
    fn wiki_balance_notes_are_prose_and_lists_instead_of_code_panels() {
        let releases = with_early_releases(vec![]);
        for id in ["legacy-3605", "3615", "3616", "3619"] {
            let release = releases.iter().find(|release| release.id == id).unwrap();
            let entry = early_entry(release).unwrap();
            assert!(
                !entry
                    .blocks
                    .iter()
                    .any(|block| matches!(block, ChangelogBlock::CodeBlock { .. })),
                "ordinary wiki balance notes became code in {id}"
            );
            if id == "3616" {
                assert!(entry.blocks.iter().any(|block| matches!(
                    block,
                    ChangelogBlock::List { items }
                    if items.len() == 4 && items[0].spans == [ChangelogSpan::Text("T1 = 1".into())]
                        && items[3].spans == [ChangelogSpan::Text("XP = 50".into())]
                )));
            }
            if id == "legacy-3605" {
                assert!(entry.blocks.iter().any(|block| matches!(
                    block,
                    ChangelogBlock::Paragraph { spans }
                    if spans.iter().any(|span| matches!(span,
                        ChangelogSpan::Text(text)
                        if text.contains("Cybran cloak energy drain -5 Aeon radar range +5")
                    ))
                )));
            }
        }
    }

    #[test]
    fn early_archive_ends_every_note_with_its_provenance() {
        for release in with_early_releases(vec![]) {
            let entry = early_entry(&release).unwrap();
            let Some(ChangelogBlock::Provenance { source_url, .. }) = entry.blocks.last() else {
                panic!("historical note must end with source attribution");
            };
            assert_eq!(source_url, &release.source_url);
            // Only the last block: the attribution never interrupts the note.
            assert_eq!(
                entry
                    .blocks
                    .iter()
                    .filter(|block| matches!(block, ChangelogBlock::Provenance { .. }))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn early_archive_searches_offline_and_keeps_old_references_literal() {
        for release in with_early_releases(vec![]) {
            let entry = early_entry(&release).unwrap();
            assert!(!entry.blocks.is_empty());
            assert!(!release.is_rolling());
            fn check(items: &[ChangelogListItem]) {
                for item in items {
                    assert!(!item
                        .spans
                        .iter()
                        .any(|span| matches!(span, ChangelogSpan::Issue { .. })));
                    check(&item.children);
                }
            }
            for block in &entry.blocks {
                if let ChangelogBlock::List { items } = block {
                    check(items);
                }
            }
            if release.id == "3616" {
                assert!(super::super::search_entry(&entry, "veterancy").is_some());
            }
            let mut wrong = release;
            wrong.source_url = "https://example.invalid/other-note".into();
            assert!(early_entry(&wrong).is_none());
        }
        assert!(ChangelogRelease {
            id: "fafbeta".into(),
            date: String::new(),
            kind: String::new(),
            year: String::new(),
            source_url: String::new(),
            web_url: String::new()
        }
        .is_rolling());
    }
}
