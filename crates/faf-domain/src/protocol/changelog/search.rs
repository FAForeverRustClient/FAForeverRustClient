//! Pure text lookup for the public patch archive. No query leaves the client.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{ChangelogBlock, ChangelogEntry, ChangelogListItem, ChangelogSpan};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogSearchMatch {
    pub release_id: String,
    pub block_path: Vec<u32>,
    pub excerpt: String,
    pub occurrences: u32,
}

fn spans_text(spans: &[ChangelogSpan]) -> String {
    spans
        .iter()
        .map(|span| match span {
            ChangelogSpan::Text(text) | ChangelogSpan::Code(text) | ChangelogSpan::Strong(text) => {
                text.clone()
            }
            ChangelogSpan::Link { text, .. } => text.clone(),
            ChangelogSpan::Issue { number, label, .. } => {
                label.clone().unwrap_or_else(|| format!("#{number}"))
            }
        })
        .collect()
}

fn list_text(items: &[ChangelogListItem], output: &mut String) {
    for item in items {
        if let Some(change) = &item.change {
            output.push_str(&format!(
                "{}: {} -> {}",
                change.label, change.old, change.new
            ));
        } else {
            output.push_str(&spans_text(&item.spans));
        }
        output.push('\n');
        list_text(&item.children, output);
    }
}

fn block_text(block: &ChangelogBlock) -> String {
    match block {
        ChangelogBlock::Heading { text, .. } | ChangelogBlock::CodeBlock { text } => text.clone(),
        ChangelogBlock::Unit { name, units } => format!(
            "{} {}",
            name,
            units
                .iter()
                .filter_map(|unit| unit.unit_id.as_deref())
                .collect::<Vec<_>>()
                .join(" ")
        ),
        ChangelogBlock::Paragraph { spans } => spans_text(spans),
        ChangelogBlock::List { items } => {
            let mut text = String::new();
            list_text(items, &mut text);
            text
        }
        ChangelogBlock::HistoricalBalance { .. } => String::new(),
    }
}

fn snippet(text: &str, folded_offset: usize) -> String {
    // Map only the first hit back to its source, rather than allocating an
    // offset for every byte in every block, including blocks without a hit.
    let mut folded_bytes = 0;
    let source_at = text
        .char_indices()
        .find_map(|(offset, character)| {
            folded_bytes += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            (folded_bytes > folded_offset).then_some(offset)
        })
        .unwrap_or(0);
    let start = text[..source_at]
        .char_indices()
        .rev()
        .nth(60)
        .map(|(offset, _)| offset)
        .unwrap_or(0);
    let end = text[source_at..]
        .char_indices()
        .nth(180)
        .map(|(offset, _)| source_at + offset)
        .unwrap_or(text.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        &text[start..end],
        if end < text.len() { "…" } else { "" }
    )
}

struct SearchBlock {
    path: Vec<u32>,
    text: String,
    folded: String,
}

/// Reusable plain text index. It contains no images or external resources.
pub struct ChangelogSearchDocument {
    id: String,
    blocks: Vec<SearchBlock>,
}

impl ChangelogSearchDocument {
    pub fn new(entry: &ChangelogEntry) -> Self {
        fn walk(blocks: &[ChangelogBlock], prefix: &[u32], indexed: &mut Vec<SearchBlock>) {
            for (index, block) in blocks.iter().enumerate() {
                // An early note's attribution is the client's, not the note's.
                if prefix.is_empty() && super::early::is_attribution(block) {
                    continue;
                }
                let mut path = prefix.to_vec();
                path.push(index as u32);
                if let ChangelogBlock::HistoricalBalance { blocks, .. } = block {
                    walk(blocks, &path, indexed);
                } else {
                    let text = block_text(block)
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    let folded = text.to_lowercase();
                    indexed.push(SearchBlock { path, text, folded });
                }
            }
        }
        let mut blocks = Vec::new();
        walk(&entry.blocks, &[], &mut blocks);
        Self {
            id: entry.id.clone(),
            blocks,
        }
    }

    /// Includes allocated string/vector capacities for the bounded session cache.
    pub fn allocated_bytes(&self) -> usize {
        self.id.capacity()
            + self.blocks.capacity() * std::mem::size_of::<SearchBlock>()
            + self
                .blocks
                .iter()
                .map(|block| {
                    block.text.capacity()
                        + block.folded.capacity()
                        + block.path.capacity() * std::mem::size_of::<u32>()
                })
                .sum::<usize>()
    }

    /// The query is already whitespace-normalized and lowercased by the caller.
    pub fn search(&self, query: &str) -> Option<ChangelogSearchMatch> {
        if query.is_empty() {
            return None;
        }
        let mut found: Option<ChangelogSearchMatch> = None;
        for block in &self.blocks {
            let mut hits = block.folded.match_indices(query);
            if let Some((at, _)) = hits.next() {
                let count = (1 + hits.count()).min(u32::MAX as usize) as u32;
                if let Some(found) = &mut found {
                    found.occurrences = found.occurrences.saturating_add(count);
                } else {
                    found = Some(ChangelogSearchMatch {
                        release_id: self.id.clone(),
                        block_path: block.path.clone(),
                        excerpt: snippet(&block.text, at),
                        occurrences: count,
                    });
                }
            }
        }
        found
    }
}

/// Convenience lookup for one-off consumers. Archive searches reuse the index.
pub fn search_entry(entry: &ChangelogEntry, query: &str) -> Option<ChangelogSearchMatch> {
    ChangelogSearchDocument::new(entry).search(
        &query
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_lookup_searches_code_original_notes_ids_and_stat_values() {
        let entry =
            super::super::parse_entry("3822", include_str!("../fixtures/changelog-3822.md"));
        assert!(search_entry(&entry, "cooper").unwrap().occurrences >= 2);
        assert!(search_entry(&entry, "XES0102").is_some());
        assert!(search_entry(&entry, "JESTER").is_some());
        assert!(search_entry(&entry, "SelectionSizeZ: 1.3 -> 1.4").is_some());
        assert!(search_entry(&entry, "not-a-published-change").is_none());
        assert!(search_entry(&entry, " ").is_none());
        let nested = ChangelogEntry {
            id: "original".into(),
            title: String::new(),
            blocks: vec![ChangelogBlock::HistoricalBalance {
                patch_id: "original".into(),
                source_url: String::new(),
                unavailable: false,
                blocks: vec![ChangelogBlock::Paragraph {
                    spans: vec![ChangelogSpan::Text("Original SHIELD details".into())],
                }],
            }],
        };
        assert_eq!(search_entry(&nested, "shield").unwrap().block_path, [0, 0]);
    }

    #[test]
    fn archive_excerpts_keep_the_match_in_long_unicode_text() {
        let text = format!("{} İNTEL {}", "前文 ".repeat(200), "後文 ".repeat(200));
        let entry = ChangelogEntry {
            id: "unicode".into(),
            title: String::new(),
            blocks: vec![ChangelogBlock::CodeBlock { text }],
        };
        let found = search_entry(&entry, "i\u{307}ntel").unwrap();
        assert!(found.excerpt.contains("İNTEL"));
        assert!(found.excerpt.chars().count() < 250);
        assert_eq!(found.occurrences, 1);
    }
}
