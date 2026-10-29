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

/// An exact identity/source match is required. An arbitrary incoming URL never
/// selects a different embedded note, and no archive network request is made.
pub fn early_entry(release: &ChangelogRelease) -> Option<ChangelogEntry> {
    let note = archive()
        .notes
        .iter()
        .find(|note| note.id == release.id && note.source_url == release.source_url)?;
    let mut attribution = vec![ChangelogSpan::Link {
        text: "Original source: FAForever contributors".to_string(),
        url: note.source_url.clone(),
    }];
    if !note.evidence.is_empty() {
        attribution.push(ChangelogSpan::Text("; ".to_string()));
        attribution.push(ChangelogSpan::Link {
            text: "Date/provenance evidence".to_string(),
            url: note.evidence.clone(),
        });
    }
    let mut blocks = super::parse_html_blocks(&note.html);
    for block in &mut blocks {
        match block {
            ChangelogBlock::Paragraph { spans } => literal_references(spans, &note.html),
            ChangelogBlock::List { items } => literal_list_references(items, &note.html),
            _ => {}
        }
    }
    // Attribution is metadata after the original article, never an invented
    // introduction or replacement description for the historical changes.
    blocks.push(ChangelogBlock::Paragraph { spans: attribution });
    Some(ChangelogEntry {
        id: note.id.clone(),
        title: format!("Patch {}", note.patch),
        blocks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
