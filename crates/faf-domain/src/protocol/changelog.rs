//! Codec for FAForever/fa's changelog: the index page and one patch note.
//!
//! Three shapes, one origin. The index is the rendered Jekyll page at
//! `faforever.github.io/fa/changelog`; a dated patch note is the Markdown
//! source of the matching post in `docs/_posts`; and the two rolling branch
//! pages are read from their *rendered* HTML, because their Markdown source
//! does not contain them.
//!
//! That last one is not a preference. `docs/changelog/fafbeta.md` on `master`
//! is a Jekyll template with a header and nothing else: the body is assembled
//! during the Pages build by `docs-build.yml`, which concatenates
//! `changelog/snippets/*.md` from the `deploy/fafbeta` branch onto it. Reading
//! the raw file therefore shows a client the preamble and none of the changes,
//! which is exactly what it did. The built page is the only published place
//! the compiled notes exist.
//!
//! Reading the index from the rendered page rather than the GitHub API is
//! deliberate: the API is rate limited per IP (60/hour unauthenticated), which
//! a shared address would exhaust, while GitHub Pages is a plain CDN. The page
//! also states the release *kind*, which the repository only records inside
//! each post's front matter.
//!
//! Post filenames are `YYYY-MM-DD-<patch>.md`, and Jekyll derives the date it
//! prints from that same filename, so the date on the index reconstructs the
//! source path exactly rather than approximately.
//!
//! The Markdown is not general Markdown. It is what `changelog/template.md` and
//! the repository's two Liquid plugins produce, so this parses that dialect and
//! nothing more: headings, paragraphs, nested dashed lists, `{% unit %}` blocks,
//! and the `old -> new` lines that `balance_change.rb` styles.
//!
//! Early wiki and announcement notes are embedded separately in `early` with
//! pinned provenance. Unknown historical dates are not deployment branches.

use serde::{Deserialize, Serialize};
use specta::Type;

mod early;
mod historical;
mod search;
pub use early::{early_entry, is_early_release, with_early_releases};
pub use historical::{historical_balance_source, parse_historical_balance};
pub use search::{search_entry, ChangelogSearchDocument, ChangelogSearchMatch};

/// Where a patch note's Markdown lives, and where its unit icons come from.
const RAW_POSTS_BASE: &str = "https://raw.githubusercontent.com/FAForever/fa/master/docs/_posts";
const PAGES_BASE: &str = "https://faforever.github.io/fa";
const ICON_BASE: &str = "https://faforever.github.io/fa/assets/icons";
const ISSUE_BASE: &str = "https://github.com/FAForever/fa/issues";

/// One release in the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogRelease {
    /// Game version, e.g. `"3837"`, or `"legacy-3605"` for unverified legacy
    /// material. Deployment branches use `"fafbeta"` and `"fafdevelop"`.
    pub id: String,
    /// `"Game Patch"`, `"Hotfix"`, a historical status, or a deployment branch name.
    pub kind: String,
    /// ISO `YYYY-MM-DD`, or empty when a historical release date is unverified
    /// or the entry is a rolling branch. Capture/edit times are never dates.
    pub date: String,
    /// Calendar year supported by the source, for grouping. Empty for rolling
    /// branches and historical notes whose release date remains unverified.
    pub year: String,
    /// Absolute URL of the document this release's note is read from: the
    /// Markdown post for a dated release, the rendered page for a rolling one,
    /// or the provenance URL identifying an embedded historical note.
    pub source_url: String,
    /// The page a "view on the website" link should open.
    pub web_url: String,
}

impl ChangelogRelease {
    /// Whether this is one of the two explicitly identified deployment branches.
    /// An unknown historical date does not make a note a rolling branch.
    ///
    /// Worth a name because the answer decides three separate things: which
    /// codec reads the note, whether the note may be cached at all, and whether
    /// the release is a candidate for "open on the newest patch". A dated post
    /// is finished the day it is published; a branch page is rewritten every
    /// time something is deployed to that branch.
    pub fn is_rolling(&self) -> bool {
        matches!(self.id.as_str(), "fafbeta" | "fafdevelop")
    }
}

/// An inline run inside a paragraph or list item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChangelogSpan {
    Text(String),
    Strong(String),
    Code(String),
    #[serde(rename_all = "camelCase")]
    Link {
        text: String,
        url: String,
    },
    /// A bare `(#7121)`, which the patch notes use constantly to cite the pull
    /// request a change came from. Resolved to a link so it is followable.
    #[serde(rename_all = "camelCase")]
    Issue {
        number: String,
        url: String,
        /// The source label when a numeric citation omitted its hash.
        #[serde(default)]
        label: Option<String>,
    },
}

/// One unit named by a header, with the icon the site would show for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogUnit {
    /// Historical illustrations can identify a unit without naming its blueprint.
    #[serde(default)]
    pub unit_id: Option<String>,
    pub icon_url: String,
}

/// A `Label: old -> new` line. Split out because these are the substance of a
/// balance patch and deserve to be read as a diff rather than as prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogChange {
    pub label: String,
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogListItem {
    pub spans: Vec<ChangelogSpan>,
    /// Set instead of `spans` carrying the whole line when it is a value change.
    pub change: Option<ChangelogChange>,
    pub children: Vec<ChangelogListItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChangelogBlock {
    #[serde(rename_all = "camelCase")]
    Heading {
        level: u8,
        text: String,
    },
    Paragraph {
        spans: Vec<ChangelogSpan>,
    },
    /// The icon-and-caption header that introduces a unit's changes.
    ///
    /// Carries a list because the two spellings differ in arity: the
    /// `{% unit XRL0302 %}` tag names exactly one, while the older prose form
    /// `**T3 Mass Fabricators (UEB1303, URB1303, UAB1303, XSB1303):**` names
    /// a whole family in a single heading.
    Unit {
        units: Vec<ChangelogUnit>,
        name: String,
    },
    List {
        items: Vec<ChangelogListItem>,
    },
    CodeBlock {
        text: String,
    },
    /// Original detail retained separately when the current post is a summary.
    #[serde(rename_all = "camelCase")]
    HistoricalBalance {
        patch_id: String,
        source_url: String,
        blocks: Vec<ChangelogBlock>,
        unavailable: bool,
    },
}

/// One fully parsed patch note.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub id: String,
    /// The post's front-matter title, e.g. `"3837 - Game Patch"`.
    pub title: String,
    pub blocks: Vec<ChangelogBlock>,
}

/// Absolute Markdown URL for a dated post.
pub fn post_source_url(date: &str, patch: &str) -> String {
    format!("{RAW_POSTS_BASE}/{date}-{patch}.md")
}

/// Where one of the two rolling branch notes is actually readable.
///
/// The built page rather than `docs/changelog/{branch}.md`, which holds only
/// the template the build appends the snippets to. See the module header.
pub fn branch_source_url(branch: &str) -> String {
    format!("{PAGES_BASE}/changelog/{branch}")
}

/// Icon URL for a unit id, mirroring `unit_block.rb`: enhancements keep their
/// path and case, everything else is upper-cased and suffixed.
pub fn unit_icon_url(unit_id: &str) -> String {
    if unit_id.starts_with("enhancements") {
        format!("{ICON_BASE}/{unit_id}.png")
    } else {
        format!("{ICON_BASE}/{}_icon.png", unit_id.to_uppercase())
    }
}

/// Parse the rendered index page into releases, newest first.
///
/// Driven by two markers the Jekyll template emits: `<h2 id="YYYY">` opens a
/// year, and each `<a class="preview-title" href="/fa/changelog/…">` is one
/// release. Anything else on the page is ignored, so the surrounding theme
/// markup can change without breaking this.
pub fn parse_index(html: &str) -> Vec<ChangelogRelease> {
    let mut releases = Vec::new();
    let mut year = String::new();

    // Walk the document once, tracking whichever marker comes next.
    let mut rest = html;
    loop {
        let next_year = rest.find("<h2 id=\"");
        let next_release = rest.find("<a class=\"preview-title\"");
        let at = match (next_year, next_release) {
            (None, None) => break,
            (Some(y), None) => y,
            (None, Some(r)) => r,
            (Some(y), Some(r)) => y.min(r),
        };

        if Some(at) == next_year {
            let after = &rest[at + "<h2 id=\"".len()..];
            if let Some(id) = after.split('"').next() {
                // Only the year headings matter; "past-game-patches" and friends
                // are not years and must not become one.
                if id.len() == 4 && id.chars().all(|c| c.is_ascii_digit()) {
                    year = id.to_string();
                }
            }
            rest = &rest[at + 1..];
            continue;
        }

        let after = &rest[at..];
        rest = &rest[at + 1..];
        let Some(release) = parse_index_entry(after, &year) else {
            continue;
        };
        releases.push(release);
    }

    releases
}

fn parse_index_entry(anchor: &str, year: &str) -> Option<ChangelogRelease> {
    let href_start = anchor.find("href=\"")? + "href=\"".len();
    let href = anchor[href_start..].split('"').next()?;
    let slug = href.rsplit('/').next()?.trim();
    if slug.is_empty() {
        return None;
    }

    let label_start = anchor.find('>')? + 1;
    let label = decode_entities(anchor[label_start..].split('<').next()?.trim());

    let web_url = format!("https://faforever.github.io{href}");

    // The two rolling branches are listed like releases but carry no date.
    if !slug.chars().all(|c| c.is_ascii_digit()) {
        return Some(ChangelogRelease {
            id: slug.to_string(),
            kind: label,
            date: String::new(),
            year: String::new(),
            source_url: branch_source_url(slug),
            web_url,
        });
    }

    // "3837 - Game Patch" → kind "Game Patch".
    let kind = label
        .split_once(" - ")
        .map(|(_, kind)| kind.trim().to_string())
        .unwrap_or_else(|| label.clone());

    // The "(Aug 14)" that follows the anchor, plus the open year heading, is the
    // post's filename date: Jekyll prints what the filename declares.
    let day = anchor.find("<span>").and_then(|start| {
        let text = anchor[start + "<span>".len()..].split('<').next()?;
        parse_month_day(text.trim())
    });
    let date = match (year.is_empty(), day) {
        (false, Some((month, day))) => format!("{year}-{month:02}-{day:02}"),
        _ => String::new(),
    };

    Some(ChangelogRelease {
        id: slug.to_string(),
        kind,
        source_url: if date.is_empty() {
            String::new()
        } else {
            post_source_url(&date, slug)
        },
        date,
        year: year.to_string(),
        web_url,
    })
}

/// `"(Aug 14)"` → `(8, 14)`.
fn parse_month_day(text: &str) -> Option<(u32, u32)> {
    let trimmed = text.trim_matches(|c| c == '(' || c == ')').trim();
    let (name, day) = trimmed.split_once(' ')?;
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS.iter().position(|m| m.eq_ignore_ascii_case(name))? as u32 + 1;
    Some((month, day.trim().parse().ok()?))
}

/// Parse one post's Markdown into blocks.
pub fn parse_entry(id: &str, markdown: &str) -> ChangelogEntry {
    let (front_matter, body) = split_front_matter(markdown);
    let title = front_matter_value(front_matter, "title").unwrap_or_else(|| id.to_string());

    let mut entry = ChangelogEntry {
        id: id.to_string(),
        title,
        blocks: parse_blocks(body),
    };
    balance_captions(&mut entry.blocks);
    nested_balance_units(&mut entry.blocks);
    historical::enrich(&mut entry);
    entry
}

/// Split the leading `---` fenced YAML from the body. A post without front
/// matter is all body rather than an error: the branch pages have none.
fn split_front_matter(markdown: &str) -> (&str, &str) {
    let text = markdown.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---") else {
        return ("", text);
    };
    let rest = rest.trim_start_matches(['\r', '\n']);
    match rest.find("\n---") {
        Some(end) => {
            let body = &rest[end + "\n---".len()..];
            (&rest[..end], body.trim_start_matches(['\r', '\n', '-']))
        }
        None => ("", text),
    }
}

fn front_matter_value(front_matter: &str, key: &str) -> Option<String> {
    front_matter.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name.trim() == key).then(|| value.trim().trim_matches('"').to_string())
    })
}

/// The sentence the Release workflow appends to every client release. It points
/// at the assets on the GitHub page, which a reader inside the client cannot
/// see, so it is dropped rather than shown as the last line of every release.
const INSTALLER_TRAILER: &str = "Download the installer for your platform from the assets below";

/// The line the Release workflow puts first in a release that must be
/// installed at once (its `required` input): a security fix, or a change the
/// server will not talk to older clients without. A client behind such a
/// release skips the grace period (`is_overdue` in the client-update slice).
///
/// Kept as a line people read, not a hidden comment: the notes are also the
/// Discord post, where a comment would show as markup, and a player should see
/// why the client asks. `.github/workflows/release.yml` writes it verbatim; a
/// test below holds the two together.
pub const REQUIRED_UPDATE_LINE: &str =
    "**Required update.** Older versions of the client ask to install it right away.";

/// Whether a release body carries [`REQUIRED_UPDATE_LINE`] on a line of its own.
pub fn marks_required_update(markdown: &str) -> bool {
    markdown
        .lines()
        .any(|line| line.trim() == REQUIRED_UPDATE_LINE)
}

/// Parse the body of one of this client's own GitHub releases into blocks.
///
/// The same parser as a patch note, because the body is a simpler cousin of
/// that dialect: `scripts/changelog.mjs combine` writes one `### Features`,
/// `### Bug fixes`, `### Performance` or `### Other changes` heading per
/// category with a dashed line per change under it, and the Release workflow
/// appends one sentence about the installer. Three things differ, and are
/// adjusted after parsing rather than threaded through it:
///
/// - The installer sentence is dropped; see [`INSTALLER_TRAILER`].
/// - A `(#123)` cites this client's repository, not FAForever/fa, so its link
///   is rebuilt on `issue_base` (`https://github.com/{owner}/{repo}/issues`).
/// - A `Label: old -> new` line stays prose. The split exists for balance
///   values, and a client note such as "Chat: tabs -> a sidebar" would
///   otherwise be drawn as a stat diff.
///
/// Releases published before the snippets existed carry whatever was typed
/// into GitHub's form, or nothing at all. GitHub's own generated notes list
/// with `*` rather than `-`, so those bullets are read as list items too;
/// anything else this dialect does not know becomes a paragraph rather than
/// vanishing. An empty body is no blocks.
pub fn parse_release_notes(markdown: &str, issue_base: &str) -> Vec<ChangelogBlock> {
    let mut fence: Option<CodeFence> = None;
    let body = markdown
        .lines()
        .map(|line| {
            if let Some(open) = fence {
                if open.closes(line.trim()) {
                    fence = None;
                }
                line.into()
            } else if let Some(open) = CodeFence::open(line.trim()) {
                fence = Some(open);
                line.into()
            } else {
                dash_bullet(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut blocks = parse_blocks(&body);
    blocks.retain(|block| !is_installer_trailer(block));
    for block in &mut blocks {
        match block {
            ChangelogBlock::Paragraph { spans } => relink_issues(spans, issue_base),
            ChangelogBlock::List { items } => as_release_items(items, issue_base),
            ChangelogBlock::Heading { .. }
            | ChangelogBlock::Unit { .. }
            | ChangelogBlock::CodeBlock { .. }
            | ChangelogBlock::HistoricalBalance { .. } => {}
        }
    }
    blocks
}

/// `* item` and `+ item` as `- item`, keeping the indentation that nests it.
/// A bold run (`**`) is not a bullet: only a marker followed by a space is.
fn dash_bullet(line: &str) -> std::borrow::Cow<'_, str> {
    let indent = line.len() - line.trim_start().len();
    let rest = &line[indent..];
    match rest.strip_prefix("* ").or_else(|| rest.strip_prefix("+ ")) {
        Some(item) => format!("{}- {item}", &line[..indent]).into(),
        None => line.into(),
    }
}

fn is_installer_trailer(block: &ChangelogBlock) -> bool {
    let ChangelogBlock::Paragraph { spans } = block else {
        return false;
    };
    let text: String = spans
        .iter()
        .map(|span| match span {
            ChangelogSpan::Text(text) | ChangelogSpan::Strong(text) | ChangelogSpan::Code(text) => {
                text.as_str()
            }
            ChangelogSpan::Link { text, .. } => text.as_str(),
            ChangelogSpan::Issue { .. } => "",
        })
        .collect();
    text.trim_start().starts_with(INSTALLER_TRAILER)
}

fn relink_issues(spans: &mut [ChangelogSpan], issue_base: &str) {
    for span in spans {
        if let ChangelogSpan::Issue { number, url, .. } = span {
            *url = format!("{issue_base}/{number}");
        }
    }
}

fn as_release_items(items: &mut [ChangelogListItem], issue_base: &str) {
    for item in items {
        // `spans` already carries the whole line, so dropping the split loses
        // nothing: the item reads as the sentence it was written as.
        item.change = None;
        relink_issues(&mut item.spans, issue_base);
        as_release_items(&mut item.children, issue_base);
    }
}

fn parse_blocks(body: &str) -> Vec<ChangelogBlock> {
    let lines: Vec<&str> = body.lines().collect();
    let mut blocks = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();

        if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks);
            index += 1;
            continue;
        }

        if let Some(fence) = CodeFence::open(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            let indent = &line[..line.len() - line.trim_start().len()];
            let mut code = Vec::new();
            index += 1;
            while index < lines.len() && !fence.closes(lines[index].trim()) {
                code.push(lines[index].strip_prefix(indent).unwrap_or(lines[index]));
                index += 1;
            }
            if index < lines.len() {
                index += 1;
            }
            blocks.push(ChangelogBlock::CodeBlock {
                text: code.join("\n"),
            });
            continue;
        }

        if let Some(unit) = parse_unit_open(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            let mut name = Vec::new();
            index += 1;
            while index < lines.len() && lines[index].trim() != "{% endunit %}" {
                name.push(lines[index].trim());
                index += 1;
            }
            index += 1; // consume the closing tag
            blocks.push(ChangelogBlock::Unit {
                units: vec![ChangelogUnit {
                    icon_url: unit_icon_url(&unit),
                    unit_id: Some(unit),
                }],
                name: name.join(" ").trim().to_string(),
            });
            continue;
        }

        if let Some(level) = heading_level(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(ChangelogBlock::Heading {
                level,
                text: trimmed[level as usize..].trim().to_string(),
            });
            index += 1;
            continue;
        }

        if is_list_marker(line) {
            flush_paragraph(&mut paragraph, &mut blocks);
            if let Some(unit) = list_unit_block(line) {
                blocks.push(unit);
                index += 1;
                continue;
            }
            let start = index;
            let base_indent = line.len() - line.trim_start().len();
            let mut item_line = line;
            while index < lines.len() && list_unit_block(lines[index]).is_none() {
                if !lines[index].trim().is_empty()
                    && lines[index].len() - lines[index].trim_start().len() < base_indent
                {
                    break;
                }
                if is_list_marker(lines[index]) {
                    item_line = lines[index];
                } else if !lines[index].trim().is_empty()
                    && !continues_list_item(lines[index], item_line)
                    && !unmarked_change(lines[index], item_line)
                {
                    break;
                }
                // A blank line only continues the list if a further item follows.
                if lines[index].trim().is_empty()
                    && !lines[index + 1..]
                        .iter()
                        .take(1)
                        .any(|next| is_list_marker(next))
                {
                    break;
                }
                index += 1;
            }
            let items = parse_list(&lines[start..index]);
            if !items.is_empty() {
                blocks.push(ChangelogBlock::List { items });
            }
            continue;
        }

        paragraph.push(trimmed.to_string());
        index += 1;
    }

    flush_paragraph(&mut paragraph, &mut blocks);
    blocks
}

#[derive(Clone, Copy)]
struct CodeFence {
    marker: u8,
    width: usize,
}

impl CodeFence {
    fn open(line: &str) -> Option<Self> {
        let marker = *line.as_bytes().first()?;
        if marker != b'`' && marker != b'~' {
            return None;
        }
        let width = line.bytes().take_while(|byte| *byte == marker).count();
        if width < 3 || (marker == b'`' && line[width..].contains('`')) {
            return None;
        }
        Some(Self { marker, width })
    }

    fn closes(self, line: &str) -> bool {
        let width = line.bytes().take_while(|byte| *byte == self.marker).count();
        width >= self.width && line[width..].trim().is_empty()
    }
}

fn flush_paragraph(paragraph: &mut Vec<String>, blocks: &mut Vec<ChangelogBlock>) {
    if paragraph.is_empty() {
        return;
    }
    let text = paragraph.join(" ");
    paragraph.clear();

    // Before the `{% unit %}` tag existed this bold line *was* the unit header,
    // so reading it gives the archive the same icons the newest patch has.
    if let Some(unit) = prose_unit_block(&text) {
        blocks.push(unit);
        return;
    }

    blocks.push(ChangelogBlock::Paragraph {
        spans: parse_spans(&text),
    });
}

fn heading_level(trimmed: &str) -> Option<u8> {
    let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    // Some old notes use `###Contributors`. Keep those labels, but a digit
    // directly after the hashes is an issue number rather than a heading.
    ((1..=6).contains(&hashes)
        && trimmed
            .as_bytes()
            .get(hashes)
            .is_none_or(|byte| matches!(byte, b' ' | b'\t') || byte.is_ascii_alphabetic()))
    .then_some(hashes as u8)
}

/// Soft-wrapped list text belongs to the preceding bullet, including PR lists.
/// Explicit blocks retain their existing headings, unit captions and code boxes.
fn continues_list_item(line: &str, item_line: &str) -> bool {
    let trimmed = line.trim();
    let indent = item_line.len() - item_line.trim_start().len();
    line.len() - line.trim_start().len() >= indent + 2
        && parse_change(item_line.trim_start().trim_start_matches('-').trim()).is_none()
        && parse_change(trimmed).is_none()
        && !trimmed.is_empty()
        && !is_list_marker(line)
        && heading_level(trimmed).is_none()
        && CodeFence::open(trimmed).is_none()
        && parse_unit_open(trimmed).is_none()
        && prose_unit_block(trimmed).is_none()
}

/// A stat line under a bullet written without its own marker, the way 3718
/// lists the Mech Marine's and Selen's stats. It is a change of that bullet:
/// read as prose, it ended the list, ran the stats together into one
/// paragraph and restarted the rest of the list a level too high.
fn unmarked_change(line: &str, item_line: &str) -> bool {
    let indent = item_line.len() - item_line.trim_start().len();
    line.len() - line.trim_start().len() >= indent + 2
        && !is_list_marker(line)
        && parse_change(line.trim()).is_some()
}

fn parse_unit_open(trimmed: &str) -> Option<String> {
    let inner = trimmed.strip_prefix("{%")?.strip_suffix("%}")?.trim();
    let id = inner.strip_prefix("unit ")?.trim();
    (!id.is_empty()).then(|| id.to_string())
}

fn is_list_marker(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("- ") || trimmed == "-"
}

/// Older balance notes nest unit headings under the change's description.
/// They become normal unit sections, splitting the surrounding list without
/// changing the order of descriptions, stat groups or repeated unit entries.
fn list_unit_block(line: &str) -> Option<ChangelogBlock> {
    prose_unit_block(line.trim_start().strip_prefix("- ")?)
}

fn prose_unit_block(text: &str) -> Option<ChangelogBlock> {
    let (name, ids) = unit_header(text)?;
    Some(ChangelogBlock::Unit {
        units: ids
            .into_iter()
            .map(|unit_id| ChangelogUnit {
                icon_url: unit_icon_url(&unit_id),
                unit_id: Some(unit_id),
            })
            .collect(),
        name,
    })
}

/// Build the item tree from indentation. The template indents nested changes by
/// two spaces per level, and the depth is what tells a category apart from the
/// values under it.
fn parse_list(lines: &[&str]) -> Vec<ChangelogListItem> {
    let mut roots: Vec<ChangelogListItem> = Vec::new();
    // Indentation of each open level, so a deeper line attaches to the right parent.
    let mut open: Vec<usize> = Vec::new();

    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if !is_list_marker(line) {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let mut text = line.trim_start().trim_start_matches('-').trim().to_string();
        while index < lines.len() && continues_list_item(lines[index], line) {
            text.push(' ');
            text.push_str(lines[index].trim());
            index += 1;
        }
        let mut item = build_item(&text);
        while index < lines.len() && unmarked_change(lines[index], line) {
            item.children.push(build_item(lines[index].trim()));
            index += 1;
        }

        while open.last().is_some_and(|last| indent <= *last) {
            open.pop();
        }

        let depth = open.len();
        open.push(indent);

        // A list that starts indented has no parent to attach to; keep the
        // content rather than dropping it.
        if let Some(item) = append_at_depth(&mut roots, depth, item) {
            open.clear();
            open.push(indent);
            roots.push(item);
        }
    }

    roots
}

/// Attach `item` at `depth`, or hand it back when there is no parent there.
fn append_at_depth(
    items: &mut Vec<ChangelogListItem>,
    depth: usize,
    item: ChangelogListItem,
) -> Option<ChangelogListItem> {
    if depth == 0 {
        items.push(item);
        return None;
    }
    match items.last_mut() {
        Some(parent) => append_at_depth(&mut parent.children, depth - 1, item),
        None => Some(item),
    }
}

fn build_item(text: &str) -> ChangelogListItem {
    ChangelogListItem {
        change: parse_change(text),
        spans: parse_spans(text),
        children: Vec::new(),
    }
}

/// `"Health: 500 -> 1340"` → a change. Requires both a label and an arrow, so
/// ordinary prose containing a colon is left as prose.
fn parse_change(text: &str) -> Option<ChangelogChange> {
    let (label, values) = text.split_once(':')?;
    let (old, new) = split_on_arrow(values)?;
    let (label, old, new) = (label.trim(), old.trim(), new.trim());
    if label.is_empty() || old.is_empty() || new.is_empty() || label.contains("](") {
        return None;
    }
    Some(ChangelogChange {
        label: label.to_string(),
        old: old.to_string(),
        new: new.to_string(),
    })
}

/// Split a value pair on whichever arrow the author used.
///
/// These notes are hand-written across more than a decade and spell this
/// three ways, sometimes within one post. Matching only `->` silently
/// truncated the old value of every `-->` line to a trailing dash.
fn split_on_arrow(values: &str) -> Option<(&str, &str)> {
    // Longest first: `-->` contains `->`, so the short form would split inside it.
    ["-->", "\u{2192}", "->"]
        .iter()
        .find_map(|arrow| values.split_once(arrow))
}

/// Recognise the older prose form of a unit header, which predates the
/// `{% unit %}` tag and is all the archive has to identify a unit by.
///
/// Shape: an entirely bold line ending in blueprint ids, such as
/// `**Yathsou: T3 Submarine Hunter (XSS0304):**`. Families use commas, an
/// ampersand or "and"; some headings give each unit its own parenthesised id.
/// Parentheses describing the unit stay in its name. The trailing group must
/// contain only valid blueprint ids, so ordinary bold prose stays prose.
fn unit_header(text: &str) -> Option<(String, Vec<String>)> {
    let inner = text.trim().strip_prefix("**")?.strip_suffix("**")?.trim();
    unit_caption(inner)
}

fn unit_caption(text: &str) -> Option<(String, Vec<String>)> {
    let inner = text.trim();
    let inner = inner.strip_suffix(':').unwrap_or(inner).trim_end();
    let (_, trailing_ids) = inner.rsplit_once('(')?;
    unit_ids(trailing_ids.strip_suffix(')')?)?;
    let (name, ids) = caption_units(inner)?;
    (!name.is_empty()).then_some((name, ids))
}

/// A caption's name without its bracketed blueprint ids, and those ids in
/// order, wherever they stand: "Aeon ACU (UAL0001) Sensor System" names its
/// unit mid-caption. `None` for an unclosed bracket.
fn caption_units(caption: &str) -> Option<(String, Vec<String>)> {
    let mut rest = caption;
    let mut name = String::new();
    let mut ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while let Some(open) = rest.find('(') {
        let close = open + rest[open..].find(')')?;
        name.push_str(&rest[..open]);
        if let Some(group) = unit_ids(&rest[open + 1..close]) {
            for id in group {
                if seen.insert(id.to_ascii_uppercase()) {
                    ids.push(id);
                }
            }
        } else {
            name.push_str(&rest[open..=close]);
        }
        rest = &rest[close + 1..];
    }
    name.push_str(rest);
    Some((
        collapse_whitespace(name.trim().trim_end_matches(':').trim()),
        ids,
    ))
}

/// Bold captions that introduce a list of balance changes. 3822 groups its
/// teleport, missile and defence changes under "**All ACUs, as well as Aeon
/// and Seraphim SACUs**" and "**Tactical Missile Launchers (TMLs)**": they name
/// what changes the way a unit header does, but end in no blueprint id, so
/// they read as stray bold text. Only inside a balance section, and never a
/// bare faction label: 3750 labels each faction's values with one inside a
/// unit's section, and those stay labels.
fn balance_captions(blocks: &mut [ChangelogBlock]) {
    let mut balance = false;
    for index in 0..blocks.len() {
        let caption = match &blocks[index] {
            ChangelogBlock::Heading { level, text } => {
                if *level <= 2 {
                    balance = text.to_lowercase().contains("balance");
                }
                continue;
            }
            ChangelogBlock::Paragraph { spans }
                if balance
                    && matches!(blocks.get(index + 1), Some(ChangelogBlock::List { .. })) =>
            {
                bold_caption(spans)
            }
            _ => continue,
        };
        let Some((name, mut ids)) = caption
            .filter(|caption| !is_faction_label(caption))
            .and_then(|caption| caption_units(&caption))
            .filter(|(name, _)| !name.is_empty())
        else {
            continue;
        };
        if ids.is_empty() {
            ids = class_units(&name);
        }
        blocks[index] = ChangelogBlock::Unit {
            units: ids
                .into_iter()
                .map(|unit_id| ChangelogUnit {
                    icon_url: unit_icon_url(&unit_id),
                    unit_id: Some(unit_id),
                })
                .collect(),
            name,
        };
    }
}

/// Older notes put unbolded unit captions and their stats inside a PR's
/// list item (3810 and 3813). Promote only complete captions ending in
/// verified-format blueprint IDs, retaining the introduction and stat order.
fn nested_balance_units(blocks: &mut Vec<ChangelogBlock>) {
    fn caption(item: &ChangelogListItem) -> Option<(String, Vec<String>)> {
        if item.change.is_some() || item.children.is_empty() {
            return None;
        }
        let mut text = String::new();
        for span in &item.spans {
            match span {
                ChangelogSpan::Text(value) | ChangelogSpan::Strong(value) => text.push_str(value),
                _ => return None,
            }
            if text.len() > 256 {
                return None;
            }
        }
        unit_caption(&text)
    }
    fn contains(items: &[ChangelogListItem], depth: u8) -> bool {
        depth < 32
            && items
                .iter()
                .any(|item| caption(item).is_some() || contains(&item.children, depth + 1))
    }
    fn flush(pending: &mut Vec<ChangelogListItem>, output: &mut Vec<ChangelogBlock>) {
        if !pending.is_empty() {
            output.push(ChangelogBlock::List {
                items: std::mem::take(pending),
            });
        }
    }
    fn expand(items: Vec<ChangelogListItem>, depth: u8, output: &mut Vec<ChangelogBlock>) {
        let mut pending = Vec::new();
        for mut item in items {
            if depth >= 32 {
                pending.push(item);
            } else if let Some((name, ids)) = caption(&item) {
                flush(&mut pending, output);
                output.push(ChangelogBlock::Unit {
                    name,
                    units: ids
                        .into_iter()
                        .map(|unit_id| ChangelogUnit {
                            icon_url: unit_icon_url(&unit_id),
                            unit_id: Some(unit_id),
                        })
                        .collect(),
                });
                expand(item.children, depth + 1, output);
            } else if contains(&item.children, depth + 1) {
                flush(&mut pending, output);
                let children = std::mem::take(&mut item.children);
                output.push(ChangelogBlock::List { items: vec![item] });
                expand(children, depth + 1, output);
            } else {
                pending.push(item);
            }
        }
        flush(&mut pending, output);
    }
    let mut balance = false;
    for block in std::mem::take(blocks) {
        if let ChangelogBlock::Heading { level, ref text } = block {
            if level <= 2 {
                balance = text.to_lowercase().contains("balance");
            }
        }
        match block {
            ChangelogBlock::List { items } if balance && contains(&items, 0) => {
                expand(items, 0, blocks)
            }
            other => blocks.push(other),
        }
    }
}

/// The text of a paragraph that is bold from end to end, as a caption is.
fn bold_caption(spans: &[ChangelogSpan]) -> Option<String> {
    let mut caption = String::new();
    for span in spans {
        match span {
            ChangelogSpan::Strong(text) => caption.push_str(text),
            ChangelogSpan::Text(text) if text.trim_matches([' ', ':']).is_empty() => {}
            _ => return None,
        }
    }
    let caption = caption.trim().trim_end_matches(':').trim();
    (!caption.is_empty() && caption.len() <= 256).then(|| caption.to_string())
}

fn is_faction_label(caption: &str) -> bool {
    caption
        .split([',', '&', '/'])
        .flat_map(|part| part.split(" and "))
        .all(|part| {
            matches!(
                part.trim().to_ascii_lowercase().as_str(),
                "uef" | "aeon" | "cybran" | "seraphim" | "sera" | "nomads" | "all factions"
            )
        })
}

/// Words a caption uses for a whole class of units, with that class's
/// blueprint ids in faction order (UEF, Aeon, Cybran, Seraphim). Only the
/// classes the notes group changes by; a caption naming none keeps no icon.
const UNIT_CLASSES: [(&[&str], [&str; 4]); 4] = [
    (
        &["sacu", "sacus"],
        ["UEL0301", "UAL0301", "URL0301", "XSL0301"],
    ),
    (
        &["acu", "acus"],
        ["UEL0001", "UAL0001", "URL0001", "XSL0001"],
    ),
    (
        &["tml", "tmls", "tacticalmissilelauncher"],
        ["UEB2108", "UAB2108", "URB2108", "XSB2108"],
    ),
    (
        &[
            "tmd",
            "tmds",
            "tacticalmissiledefense",
            "tacticalmissiledefence",
        ],
        ["UEB4201", "UAB4201", "URB4201", "XSB4201"],
    ),
];

const FACTIONS: [&[&str]; 4] = [&["uef"], &["aeon"], &["cybran"], &["seraphim", "sera"]];

/// The units a caption names by class. Each clause names a class and the
/// factions in that clause narrow it: "All ACUs, as well as Aeon and Seraphim
/// SACUs" is every ACU and two SACUs.
fn class_units(name: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for clause in name.split([',', ';']) {
        let words: Vec<String> = clause
            .split(|character: char| !character.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .map(str::to_lowercase)
            .collect();
        let joined = words.concat();
        let factions: Vec<usize> = FACTIONS
            .iter()
            .enumerate()
            .filter(|(_, names)| words.iter().any(|word| names.contains(&word.as_str())))
            .map(|(faction, _)| faction)
            .collect();
        for (names, units) in UNIT_CLASSES {
            // Whole words, or one of the long multi-word names run together:
            // matched inside the joined words, a short one like "sacus" could
            // turn up across two unrelated words.
            let named = words.iter().any(|word| names.contains(&word.as_str()))
                || names
                    .iter()
                    .any(|phrase| phrase.len() > 12 && joined.contains(phrase));
            if !named {
                continue;
            }
            for (faction, id) in units.iter().enumerate() {
                if (factions.is_empty() || factions.contains(&faction))
                    && !ids.iter().any(|known| known == id)
                {
                    ids.push((*id).to_string());
                }
            }
        }
    }
    ids
}

fn unit_ids(text: &str) -> Option<Vec<String>> {
    let mut ids = Vec::new();
    for group in text.split([',', '&']) {
        let mut words = group.split_whitespace();
        let id = words.next()?;
        if !is_unit_id(id) {
            return None;
        }
        ids.push(id.to_string());
        while let Some(separator) = words.next() {
            if !separator.eq_ignore_ascii_case("and") {
                return None;
            }
            let id = words.next()?;
            if !is_unit_id(id) {
                return None;
            }
            ids.push(id.to_string());
        }
    }
    Some(ids)
}

/// Blueprint ids normally have three letters and four digits (`XSS0304`).
/// Some FAF units use four letters and three digits instead (`DSLK004`).
///
/// The digits matter: allowing letters there made `finally` a unit id, because
/// it is also seven characters. A looser rule turns any bracketed word into a
/// unit and asks the site for an icon that does not exist.
fn is_unit_id(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    if bytes.len() != 7 {
        return false;
    }
    let letters = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_alphabetic())
        .count();
    (3..=4).contains(&letters) && bytes[letters..].iter().all(u8::is_ascii_digit)
}

/// Inline parsing for the handful of constructs the patch notes actually use.
pub fn parse_spans(text: &str) -> Vec<ChangelogSpan> {
    let mut spans = Vec::new();
    let mut plain = String::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut index = 0;

    while index < bytes.len() {
        let rest: String = bytes[index..].iter().collect();

        if let Some(inner) = delimited(&rest, "**", "**") {
            push_text(&mut plain, &mut spans);
            spans.push(ChangelogSpan::Strong(inner.clone()));
            index += inner.chars().count() + 4;
            continue;
        }
        if let Some(inner) = delimited(&rest, "`", "`") {
            push_text(&mut plain, &mut spans);
            spans.push(ChangelogSpan::Code(inner.clone()));
            index += inner.chars().count() + 2;
            continue;
        }
        if let Some((label, url, consumed)) = markdown_link(&rest) {
            push_text(&mut plain, &mut spans);
            spans.push(ChangelogSpan::Link { text: label, url });
            index += consumed;
            continue;
        }
        if let Some((number, consumed)) = issue_reference(&rest) {
            push_text(&mut plain, &mut spans);
            spans.push(ChangelogSpan::Issue {
                label: None,
                url: format!("{ISSUE_BASE}/{number}"),
                number,
            });
            index += consumed;
            continue;
        }

        plain.push(bytes[index]);
        index += 1;
    }

    push_text(&mut plain, &mut spans);
    spans
}

fn push_text(plain: &mut String, spans: &mut Vec<ChangelogSpan>) {
    let text = std::mem::take(plain);
    let mut cursor = 0;
    let mut pending = 0;
    while let Some(offset) = text[cursor..].find("(#") {
        let start = cursor + offset;
        if let Some((references, consumed)) = grouped_references(&text[start..]) {
            if pending < start {
                spans.push(ChangelogSpan::Text(text[pending..start].into()));
            }
            spans.extend(references);
            cursor = start + consumed;
            pending = cursor;
        } else {
            cursor = start + 2;
        }
    }
    if pending < text.len() {
        spans.push(ChangelogSpan::Text(text[pending..].into()));
    }
}

/// Split numeric citations without accepting destinations from their text.
/// The existing HTTPS issue route also resolves GitHub pull-request numbers.
fn grouped_references(rest: &str) -> Option<(Vec<ChangelogSpan>, usize)> {
    let inner = rest.strip_prefix('(')?;
    if !inner.starts_with('#') {
        return None;
    }
    let end = inner.bytes().take(1025).position(|byte| byte == b')')?;
    let content = &inner[..end];
    let bytes = content.as_bytes();
    let mut references = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let start = cursor;
        let marked = bytes[cursor] == b'#';
        if marked {
            cursor += 1;
        }
        let digits = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == digits || cursor - digits > 20 || references.len() >= 128 {
            return None;
        }
        references.push((start + 1, digits + 1, cursor + 1, marked));
        if cursor == bytes.len() {
            break;
        }
        // An explicit next hash also separates references in old typoed lists.
        if bytes[cursor] == b'#' {
            continue;
        }
        let separator = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor < bytes.len() && bytes[cursor] == b',' {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor == bytes.len() {
                return None;
            }
        } else if cursor == separator {
            return None;
        }
    }
    if references.len() < 2 {
        return None;
    }
    let source = &rest[..end + 2];
    let mut spans = Vec::new();
    let mut cursor = 0;
    for (start, digits, end, marked) in references {
        if start > cursor {
            spans.push(ChangelogSpan::Text(source[cursor..start].into()));
        }
        let number = &source[digits..end];
        spans.push(ChangelogSpan::Issue {
            number: number.into(),
            url: format!("{ISSUE_BASE}/{number}"),
            label: (!marked).then(|| number.into()),
        });
        cursor = end;
    }
    spans.push(ChangelogSpan::Text(source[cursor..].into()));
    Some((spans, end + 2))
}

fn delimited(rest: &str, open: &str, close: &str) -> Option<String> {
    let after = rest.strip_prefix(open)?;
    let end = after.find(close)?;
    (end > 0).then(|| after[..end].to_string())
}

fn markdown_link(rest: &str) -> Option<(String, String, usize)> {
    let after = rest.strip_prefix('[')?;
    let label_end = after.find("](")?;
    let label = &after[..label_end];
    let url_part = &after[label_end + 2..];
    let url_end = url_part.find(')')?;
    let url = &url_part[..url_end];
    if url.is_empty() {
        return None;
    }
    let consumed = 1 + label.chars().count() + 2 + url.chars().count() + 1;
    Some((label.to_string(), url.to_string(), consumed))
}

/// `(#7121)` and the bare `#7121` both appear; only the parenthesised form is
/// unambiguous enough to link without swallowing a Markdown heading.
fn issue_reference(rest: &str) -> Option<(String, usize)> {
    let after = rest.strip_prefix("(#")?;
    let end = after.find(')')?;
    let number = &after[..end];
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((number.to_string(), number.len() + 3))
}

/// Parse one of the rolling branch pages out of its rendered HTML.
///
/// The counterpart to [`parse_entry`], producing the same blocks from the built
/// page instead of from Markdown, because for these two pages the Markdown
/// source is empty (see the module header).
///
/// The markup is not general HTML: it is what Jekyll's `just-the-docs` theme
/// plus this repository's two Liquid plugins emit, so this handles that subset
/// and ignores the rest. Anything unrecognised contributes its text rather than
/// vanishing, which is the failure mode to prefer for a changelog.
pub fn parse_rendered_entry(id: &str, html: &str) -> ChangelogEntry {
    // Stripped once, up front, rather than skipped during the walk: the branch
    // template ends in a comment explaining that the content below is appended
    // by the build, and that sentence is not part of the patch notes.
    let body = strip_comments(main_content(html));
    ChangelogEntry {
        id: id.to_string(),
        title: rendered_title(html).unwrap_or_else(|| id.to_string()),
        blocks: parse_html_blocks(&body),
    }
}

/// The page title as the front matter set it, without the site name Jekyll
/// appends. Matches what [`parse_entry`] reads out of `title:`.
fn rendered_title(html: &str) -> Option<String> {
    let raw = slice_between(html, "<title>", "</title>")?;
    let decoded = decode_entities(raw.trim());
    let title = decoded.split(" | ").next().unwrap_or(&decoded).trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// The article body, or the whole document if the theme's `<main>` is missing.
/// Everything outside it is navigation, breadcrumbs and a footer.
fn main_content(html: &str) -> &str {
    match slice_between(html, "<main", "</main>") {
        Some(inner) => match inner.find('>') {
            Some(at) => &inner[at + 1..],
            None => inner,
        },
        None => html,
    }
}

fn slice_between<'a>(html: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = html.find(open)? + open.len();
    let rest = &html[start..];
    let end = rest.find(close)?;
    Some(&rest[..end])
}

fn strip_comments(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("<!--") {
        out.push_str(&rest[..at]);
        match rest[at..].find("-->") {
            Some(end) => rest = &rest[at + end + "-->".len()..],
            // Unterminated: everything after it is comment, not content.
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// One element found by [`next_element`], with the markup that preceded it.
struct Element<'a> {
    /// Lower-cased tag name.
    name: String,
    /// The opening tag verbatim, so attributes can still be read off it.
    open_tag: &'a str,
    /// Whatever came before it, which belongs to the enclosing content.
    before: &'a str,
    inner: &'a str,
    after: &'a str,
}

impl Element<'_> {
    /// Whether the opening tag carries this class. Whole values only, so
    /// `change` never matches `change-category`.
    fn has_class(&self, class: &str) -> bool {
        attribute(self.open_tag, "class")
            .is_some_and(|value| value.split_whitespace().any(|present| present == class))
    }
}

/// Elements that never carry a closing tag, so their content is not searched
/// for one. `img` is the one that actually appears here; the rest are cheap
/// insurance against a theme change.
const VOID_TAGS: [&str; 6] = ["img", "br", "hr", "input", "meta", "link"];

/// The next element at this level, or `None` once the markup runs out.
fn next_element(html: &str) -> Option<Element<'_>> {
    let mut cursor = 0;
    loop {
        let at = html[cursor..].find('<')? + cursor;
        let after_bracket = &html[at + 1..];

        // A stray closing tag or a doctype: not the start of anything.
        if after_bracket.starts_with('/') || after_bracket.starts_with('!') {
            cursor = at + 1;
            continue;
        }

        let name_end = after_bracket
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .unwrap_or(after_bracket.len());
        let name = after_bracket[..name_end].to_ascii_lowercase();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
            cursor = at + 1;
            continue;
        }

        let tag_end = at + 1 + after_bracket.find('>')?;
        let open_tag = &html[at..=tag_end];
        let before = &html[..at];

        if open_tag.ends_with("/>") || VOID_TAGS.contains(&name.as_str()) {
            return Some(Element {
                name,
                open_tag,
                before,
                inner: "",
                after: &html[tag_end + 1..],
            });
        }

        let (inner, after) = match inner_of(&html[tag_end + 1..], &name) {
            Some(split) => split,
            // Unclosed: read the rest as its content rather than dropping the
            // remainder of the document.
            None => (&html[tag_end + 1..], ""),
        };
        return Some(Element {
            name,
            open_tag,
            before,
            inner,
            after,
        });
    }
}

/// Split at the closing tag matching an already-open one, counting nested opens
/// of the same name: lists inside lists are the whole reason this cannot simply
/// search for the first `</ul>`.
fn inner_of<'a>(rest: &'a str, name: &str) -> Option<(&'a str, &'a str)> {
    let open_pat = format!("<{name}");
    let close_pat = format!("</{name}");
    let mut depth = 1usize;
    let mut cursor = 0usize;

    loop {
        let next_open = find_tag(rest, &open_pat, cursor);
        let next_close = find_tag(rest, &close_pat, cursor);
        match (next_open, next_close) {
            (_, None) => return None,
            (Some(open), Some(close)) if open < close => {
                depth += 1;
                cursor = open + open_pat.len();
            }
            (_, Some(close)) => {
                depth -= 1;
                if depth == 0 {
                    let end = rest[close..].find('>')? + close + 1;
                    return Some((&rest[..close], &rest[end..]));
                }
                cursor = close + close_pat.len();
            }
        }
    }
}

/// Find `pattern` only where it is a whole tag name, so a search for `<p` does
/// not stop on `<pre`.
fn find_tag(html: &str, pattern: &str, from: usize) -> Option<usize> {
    let mut cursor = from;
    loop {
        let offset = html.get(cursor..)?.find(pattern)?;
        let at = cursor + offset;
        match html[at + pattern.len()..].chars().next() {
            Some(c) if c.is_whitespace() || c == '>' || c == '/' => return Some(at),
            None => return None,
            _ => cursor = at + pattern.len(),
        }
    }
}

/// Read one attribute off an opening tag.
fn attribute(open_tag: &str, name: &str) -> Option<String> {
    let key = format!("{name}=");
    let mut cursor = 0;
    while let Some(offset) = open_tag[cursor..].find(&key) {
        let at = cursor + offset;
        // Guard against matching the tail of a longer attribute name, which is
        // not hypothetical: every icon in a heading carries `xlink:href`.
        let starts_here = at == 0
            || open_tag[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        cursor = at + key.len();
        if !starts_here {
            continue;
        }
        let value = &open_tag[at + key.len()..];
        let quote = value.chars().next()?;
        if quote != '"' {
            let end = value.find(|c: char| c.is_whitespace() || c == '>')?;
            return Some(decode_entities(&value[..end]));
        }
        let end = value[1..].find(quote)?;
        return Some(decode_entities(&value[1..1 + end]));
    }
    None
}

fn parse_html_blocks(html: &str) -> Vec<ChangelogBlock> {
    let mut blocks = Vec::new();
    let mut rest = html;

    while let Some(element) = next_element(rest) {
        match element.name.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = element.name[1..].parse::<u8>().unwrap_or(1);
                let text = html_text(element.inner);
                if !text.is_empty() {
                    blocks.push(ChangelogBlock::Heading { level, text });
                }
            }
            "p" => {
                let spans = parse_html_spans(element.inner);
                if !spans.is_empty() {
                    blocks.push(ChangelogBlock::Paragraph { spans });
                }
            }
            "pre" => blocks.push(ChangelogBlock::CodeBlock {
                text: preformatted_html_text(element.inner),
            }),
            "ul" | "ol" => {
                let items = parse_html_items(element.inner);
                if !items.is_empty() {
                    blocks.push(ChangelogBlock::List { items });
                }
            }
            "div" if element.has_class("unit-header") => {
                if let Some(block) = parse_html_unit(element.inner) {
                    blocks.push(block);
                }
            }
            // A wrapper the theme added: look inside it rather than past it.
            "div" | "section" | "article" | "main" => {
                blocks.extend(parse_html_blocks(element.inner));
            }
            _ => {}
        }
        rest = element.after;
    }

    blocks
}

fn preformatted_html_text(html: &str) -> String {
    let mut text = String::new();
    let mut rest = html;
    loop {
        let Some(element) = next_element(rest) else {
            text.push_str(&decode_entities(rest));
            break;
        };
        text.push_str(&decode_entities(element.before));
        if !matches!(element.name.as_str(), "button" | "script" | "style" | "svg") {
            if element.name == "br" {
                text.push('\n');
            } else {
                text.push_str(&preformatted_html_text(element.inner));
            }
        }
        rest = element.after;
    }
    text
}

/// The `unit_block.rb` header: the icons, and the name beside them.
fn parse_html_unit(html: &str) -> Option<ChangelogBlock> {
    let mut units = Vec::new();
    let mut name = String::new();
    let mut rest = html;

    while let Some(element) = next_element(rest) {
        if element.name == "img" && element.has_class("unit-icon") {
            let id = attribute(element.open_tag, "src")
                .as_deref()
                .and_then(unit_id_from_icon);
            if let Some(unit_id) = id {
                units.push(ChangelogUnit {
                    icon_url: unit_icon_url(&unit_id),
                    unit_id: Some(unit_id),
                });
            }
        } else if element.has_class("unit-name") {
            name = html_text(element.inner);
        }
        rest = element.after;
    }

    (!units.is_empty() || !name.is_empty()).then_some(ChangelogBlock::Unit { units, name })
}

/// `"../assets/icons/UAB0304_icon.png"` becomes `"UAB0304"`, and an
/// enhancement's `"../assets/icons/enhancements/xyz.png"` becomes
/// `"enhancements/xyz"`: exactly what [`unit_icon_url`] turns back into the URL
/// it came from, so the icon a rolling page shows is the icon the archive shows.
fn unit_id_from_icon(src: &str) -> Option<String> {
    let path = src.rsplit_once("assets/icons/").map(|(_, tail)| tail)?;
    let stem = path.strip_suffix(".png").unwrap_or(path);
    let id = stem.strip_suffix("_icon").unwrap_or(stem);
    (!id.is_empty()).then(|| id.to_string())
}

fn parse_html_items(html: &str) -> Vec<ChangelogListItem> {
    let mut items = Vec::new();
    let mut rest = html;

    while let Some(element) = next_element(rest) {
        if element.name == "li" {
            let own = own_content(element.inner);
            items.push(ChangelogListItem {
                change: parse_html_change(&own),
                spans: parse_html_spans(&own),
                children: nested_items(element.inner),
            });
        } else if element.name == "ul" || element.name == "ol" {
            // Older pages sometimes close the category's li before its list.
            // Keep that following list under the preceding category.
            let nested = parse_html_items(element.inner);
            if let Some(previous) = items.last_mut() {
                previous.children.extend(nested);
            } else {
                items.extend(nested);
            }
        }
        rest = element.after;
    }

    items
}

/// One item's own markup, with its sub-lists removed.
///
/// Needed because a category row holds no values of its own: reading the whole
/// subtree would hand `Adjacency:` the first pair of numbers belonging to the
/// row underneath it.
fn own_content(html: &str) -> String {
    let mut own = String::new();
    let mut rest = html;

    loop {
        let Some(element) = next_element(rest) else {
            own.push_str(rest);
            break;
        };
        own.push_str(element.before);
        if element.name != "ul" && element.name != "ol" {
            own.push_str(element.open_tag);
            if !element.open_tag.ends_with("/>") && !VOID_TAGS.contains(&element.name.as_str()) {
                own.push_str(element.inner);
                own.push_str("</");
                own.push_str(&element.name);
                own.push('>');
            }
        }
        rest = element.after;
    }

    own
}

fn nested_items(html: &str) -> Vec<ChangelogListItem> {
    let mut items = Vec::new();
    let mut rest = html;

    while let Some(element) = next_element(rest) {
        if element.name == "ul" || element.name == "ol" {
            items.extend(parse_html_items(element.inner));
        }
        rest = element.after;
    }

    items
}

/// The rendered form of a `balance_change.rb` line:
/// `<span class="change">Health: </span><span class="old">500</span>`, an
/// arrow, `<span class="new">1340</span>`.
fn parse_html_change(html: &str) -> Option<ChangelogChange> {
    parse_styled_html_change(html).or_else(|| historical::strike_change(html))
}

fn parse_styled_html_change(html: &str) -> Option<ChangelogChange> {
    let label = span_with_class(html, "change")?;
    let old = span_with_class(html, "old")?;
    let new = span_with_class(html, "new")?;

    let label = label.trim().trim_end_matches(':').trim();
    let (old, new) = (old.trim(), new.trim());
    if label.is_empty() || old.is_empty() || new.is_empty() {
        return None;
    }
    Some(ChangelogChange {
        label: label.to_string(),
        old: old.to_string(),
        new: new.to_string(),
    })
}

/// Text of the first element carrying this class, at any depth.
fn span_with_class(html: &str, class: &str) -> Option<String> {
    let mut rest = html;
    while let Some(element) = next_element(rest) {
        if element.has_class(class) {
            return Some(html_text(element.inner));
        }
        if let Some(found) = span_with_class(element.inner, class) {
            return Some(found);
        }
        rest = element.after;
    }
    None
}

/// Inline parsing, mirroring [`parse_spans`] over the rendered equivalents.
fn parse_html_spans(html: &str) -> Vec<ChangelogSpan> {
    finish_spans(collect_html_spans(html))
}

/// The walk itself. Separate from [`parse_html_spans`] because tidying the runs
/// is only correct once, at the end: doing it per nested element would trim the
/// space that separates a label from the value after it.
fn collect_html_spans(html: &str) -> Vec<ChangelogSpan> {
    let mut spans = Vec::new();
    let mut plain = String::new();
    let mut rest = html;

    loop {
        let Some(element) = next_element(rest) else {
            plain.push_str(&decode_entities(rest));
            break;
        };
        plain.push_str(&decode_entities(element.before));

        match element.name.as_str() {
            // Decoration, and the theme's own furniture.
            "svg" | "img" | "button" | "use" | "path" | "script" | "style" | "iframe" => {}
            "i" if element.has_class("fa-arrow-right") => plain.push_str(" → "),
            "a" if element.has_class("anchor-heading") => {}
            "strong" | "b" => {
                push_text(&mut plain, &mut spans);
                spans.push(ChangelogSpan::Strong(html_text(element.inner)));
            }
            "code" => {
                push_text(&mut plain, &mut spans);
                spans.push(ChangelogSpan::Code(html_text(element.inner)));
            }
            "a" => {
                let url = attribute(element.open_tag, "href").unwrap_or_default();
                let text = html_text(element.inner);
                push_text(&mut plain, &mut spans);
                spans.extend(anchor_span(&text, url));
            }
            // `p`, `span`, `em` and anything else: transparent, contributing
            // its content in place.
            _ => {
                push_text(&mut plain, &mut spans);
                spans.extend(collect_html_spans(element.inner));
            }
        }
        rest = element.after;
    }

    push_text(&mut plain, &mut spans);
    spans
}

/// One anchor, as the span it should be.
///
/// `changelog-links.sh` has already turned every `(#7121)` into a link by the
/// time the page is built, so a citation arrives here as an anchor. It is put
/// back into the shape the Markdown path produces rather than left as one more
/// blue word, so both halves of the tab render a pull request reference alike.
fn anchor_span(text: &str, url: String) -> Option<ChangelogSpan> {
    if let Some(number) = text.strip_prefix('#') {
        if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
            return Some(ChangelogSpan::Issue {
                label: None,
                url: if url.is_empty() {
                    format!("{ISSUE_BASE}/{number}")
                } else {
                    url
                },
                number: number.to_string(),
            });
        }
    }
    (!text.is_empty()).then(|| ChangelogSpan::Link {
        text: text.to_string(),
        url,
    })
}

/// Plain text of a fragment: tags dropped, entities decoded, whitespace
/// collapsed the way a browser would collapse it.
fn html_text(html: &str) -> String {
    let mut text = String::new();
    let mut rest = html;

    loop {
        let Some(element) = next_element(rest) else {
            text.push_str(&decode_entities(rest));
            break;
        };
        text.push_str(&decode_entities(element.before));
        if !matches!(element.name.as_str(), "svg" | "use" | "path" | "button") {
            text.push(' ');
            text.push_str(&html_text(element.inner));
            text.push(' ');
        }
        rest = element.after;
    }

    collapse_whitespace(&text)
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Rejoin the runs the tag boundaries split, so a line assembled out of three
/// spans reads as the one sentence it is, and drop the whitespace that is only
/// there because the markup was indented.
fn finish_spans(spans: Vec<ChangelogSpan>) -> Vec<ChangelogSpan> {
    let mut merged: Vec<ChangelogSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        let span = match span {
            // Collapsed rather than trimmed: an inner run's spaces separate it
            // from the spans on either side and have to survive.
            ChangelogSpan::Text(text) => {
                let mut collapsed = collapse_whitespace(&text);
                if text.starts_with(char::is_whitespace) {
                    collapsed.insert(0, ' ');
                }
                if text.ends_with(char::is_whitespace) && !collapsed.is_empty() {
                    collapsed.push(' ');
                }
                ChangelogSpan::Text(collapsed)
            }
            other => other,
        };
        match (merged.last_mut(), span) {
            (Some(ChangelogSpan::Text(previous)), ChangelogSpan::Text(next)) => {
                previous.push_str(&next)
            }
            (_, span) => merged.push(span),
        }
    }

    if let Some(ChangelogSpan::Text(first)) = merged.first_mut() {
        *first = first.trim_start().to_string();
    }
    if let Some(ChangelogSpan::Text(last)) = merged.last_mut() {
        *last = last.trim_end().to_string();
    }
    merged.retain(|span| !matches!(span, ChangelogSpan::Text(text) if text.is_empty()));
    merged
}

fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_headings_distinguish_issue_numbers_from_legacy_titles() {
        for (source, level) in [
            ("#", 1),
            ("## Features", 2),
            ("###\tContributors", 3),
            ("###### Detail", 6),
            ("###Contributors", 3),
        ] {
            assert_eq!(heading_level(source), Some(level), "{source}");
        }
        for source in ["#3522, #3512", "##3522", "####### Detail", "ordinary text"] {
            assert_eq!(heading_level(source), None, "{source}");
        }
    }

    #[test]
    fn wrapped_list_text_stays_with_its_item_without_swallowing_following_blocks() {
        let blocks = parse_blocks("- First contributor (#12,\n  #34 #56)\n- Second contributor\n  with a wrapped description.\n\n## Reviewers\n- Reviewer (#78)\n\n{% unit URL0303 %}\nLoyalist\n{% endunit %}\n\n```\n#123 remains code\n```");
        let ChangelogBlock::List { items } = &blocks[0] else {
            panic!("missing contributors");
        };
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0]
                .spans
                .iter()
                .filter(|span| matches!(span, ChangelogSpan::Issue { .. }))
                .count(),
            3
        );
        assert_eq!(
            items[1].spans,
            vec![ChangelogSpan::Text(
                "Second contributor with a wrapped description.".into()
            )]
        );
        assert!(matches!(&blocks[1], ChangelogBlock::Heading { text, .. } if text == "Reviewers"));
        assert!(matches!(&blocks[3], ChangelogBlock::Unit { name, .. } if name == "Loyalist"));
        assert!(
            matches!(&blocks[4], ChangelogBlock::CodeBlock { text } if text == "#123 remains code")
        );
        // Unmarked stat lines are not wrapped text: they stay out of the
        // bullet's own text and become its changes.
        let stats = parse_blocks("- Mech Marine\n  Mass Cost: 35 -> 30\n  Health: 75 -> 60");
        assert_eq!(stats.len(), 1);
        let ChangelogBlock::List { items } = &stats[0] else {
            panic!("expected a list, got {stats:?}");
        };
        assert_eq!(
            items[0].spans,
            vec![ChangelogSpan::Text("Mech Marine".into())]
        );
        assert!(items[0].change.is_none());
        assert!(items[0].children.iter().all(|child| child.change.is_some()));
        assert_eq!(items[0].children.len(), 2);
    }

    #[test]
    fn grouped_references_preserve_punctuation_and_use_only_numeric_repository_urls() {
        let spans = parse_spans("Before (#6481, #6482) after");
        assert_eq!(
            spans,
            vec![
                ChangelogSpan::Text("Before ".into()),
                ChangelogSpan::Text("(".into()),
                ChangelogSpan::Issue {
                    label: None,
                    number: "6481".into(),
                    url: format!("{ISSUE_BASE}/6481")
                },
                ChangelogSpan::Text(", ".into()),
                ChangelogSpan::Issue {
                    label: None,
                    number: "6482".into(),
                    url: format!("{ISSUE_BASE}/6482")
                },
                ChangelogSpan::Text(")".into()),
                ChangelogSpan::Text(" after".into()),
            ]
        );
        for source in [
            "(#6481, javascript:alert(1))",
            "(#6481, #42/../../other)",
            "(#6481, #１２３)",
            "(#6481, #)",
            "(#6481, #123456789012345678901)",
            "(#6481,, #6482)",
            "(#6481, #6482,)",
            "(#6481 #6482oops)",
        ] {
            assert!(
                !parse_spans(source)
                    .iter()
                    .any(|span| matches!(span, ChangelogSpan::Issue { .. })),
                "{source}"
            );
        }
        let oversized = format!("({})", vec!["#1"; 129].join(", "));
        assert!(!parse_spans(&oversized)
            .iter()
            .any(|span| matches!(span, ChangelogSpan::Issue { .. })));
        assert!(matches!(
            &parse_spans("`(#6481, #6482)`")[0],
            ChangelogSpan::Code(_)
        ));
        assert!(matches!(
            &parse_blocks("```\n(#6481, #6482)\n```")[0],
            ChangelogBlock::CodeBlock { .. }
        ));
    }

    #[test]
    fn grouped_references_work_in_rendered_notes_and_keep_the_client_repository() {
        let html = parse_html_spans("Change (#6481, #6482).");
        assert_eq!(
            html.iter()
                .filter(|span| matches!(span, ChangelogSpan::Issue { .. }))
                .count(),
            2
        );
        let blocks = parse_release_notes("- Change (#12, #34).", CLIENT_ISSUES);
        let ChangelogBlock::List { items } = &blocks[0] else {
            panic!("missing release list");
        };
        assert!(items[0].spans.iter().any(
            |span| matches!(span, ChangelogSpan::Issue { number, url, .. }
            if number == "34" && url == &format!("{CLIENT_ISSUES}/34"))
        ));
        let blocks = parse_release_notes("- Change (#12#34, 56).", CLIENT_ISSUES);
        let ChangelogBlock::List { items } = &blocks[0] else {
            panic!("missing release list");
        };
        assert!(items[0].spans.iter().any(|span| matches!(span, ChangelogSpan::Issue { number, url, label }
            if number == "56" && label.as_deref() == Some("56") && url == &format!("{CLIENT_ISSUES}/56"))));
        assert!(parse_html_spans("Change (#12#34, 56).").iter().any(|span| matches!(span,
            ChangelogSpan::Issue { number, label, .. } if number == "56" && label.as_deref() == Some("56"))));
    }

    #[test]
    fn numeric_citation_labels_are_backward_compatible_and_reject_malformed_tokens() {
        let legacy: ChangelogSpan = serde_json::from_str(r##"{"type":"issue","payload":{"number":"12","url":"https://github.com/FAForever/fa/issues/12"}}"##).unwrap();
        assert!(matches!(&legacy, ChangelogSpan::Issue { label: None, .. }));
        assert_eq!(
            serde_json::from_str::<ChangelogSpan>(&serde_json::to_string(&legacy).unwrap())
                .unwrap(),
            legacy
        );
        for text in [
            "(#12#34oops, 56)",
            "(#12, 56/../../other)",
            "(#12, javascript:56)",
            "(#12, 56.7)",
            "(#12, -56)",
            "(#12, １２３)",
            "(#12, 123456789012345678901)",
        ] {
            assert!(
                !parse_spans(text)
                    .iter()
                    .any(|span| matches!(span, ChangelogSpan::Issue { .. })),
                "{text}"
            );
        }
        let source = "`(#12#34, 56)`";
        assert_eq!(
            parse_spans(source),
            vec![ChangelogSpan::Code("(#12#34, 56)".into())]
        );
    }

    #[test]
    fn fenced_blocks_preserve_blank_lines_and_relative_indentation_as_literal_text() {
        let blocks = parse_blocks("Before\n\n    ```lua\n    if enabled then\n      -- (#123) **literal**\n\n      speed = 2 -> 3\n    end\n    ```\n\n## After");
        assert_eq!(
            blocks[1],
            ChangelogBlock::CodeBlock {
                text: "if enabled then\n  -- (#123) **literal**\n\n  speed = 2 -> 3\nend".into()
            }
        );
        assert!(matches!(&blocks[2], ChangelogBlock::Heading { text, .. } if text == "After"));
        assert_eq!(
            parse_blocks("````text\n```\ncontents\n````"),
            vec![ChangelogBlock::CodeBlock {
                text: "```\ncontents".into()
            }]
        );
        assert_eq!(
            parse_blocks("~~~text\n  indented\n~~~"),
            vec![ChangelogBlock::CodeBlock {
                text: "  indented".into()
            }]
        );
        assert_eq!(
            parse_blocks("```\nunclosed\n  still literal"),
            vec![ChangelogBlock::CodeBlock {
                text: "unclosed\n  still literal".into()
            }]
        );
    }

    #[test]
    fn client_release_code_keeps_bullet_markers_and_issue_syntax_literal() {
        let blocks = parse_release_notes(
            "* An ordinary bullet\n\n```\n* literal star\n+ literal plus\n(#42)\n```",
            CLIENT_ISSUES,
        );
        assert!(matches!(&blocks[0], ChangelogBlock::List { .. }));
        assert_eq!(
            blocks[1],
            ChangelogBlock::CodeBlock {
                text: "* literal star\n+ literal plus\n(#42)".into()
            }
        );
    }

    #[test]
    fn rendered_code_preserves_whitespace_without_site_controls_or_executing_markup() {
        assert_eq!(parse_html_blocks("<pre><button>Copy</button><code>if a &lt; b then\n  <span>print</span>(&quot;safe&quot;)\nend</code></pre>"),
            vec![ChangelogBlock::CodeBlock { text: "if a < b then\n  print(\"safe\")\nend".into() }]);
    }

    #[test]
    fn the_release_workflow_writes_the_required_update_line_the_client_reads() {
        let workflow = include_str!("../../../../.github/workflows/release.yml");
        assert!(workflow.contains(REQUIRED_UPDATE_LINE));
        assert!(marks_required_update(&format!(
            "{REQUIRED_UPDATE_LINE}\n\n### Bug fixes\n- Fixed it\n"
        )));
        assert!(!marks_required_update("### Bug fixes\n- Fixed it\n"));
        // Mentioned inside a sentence is not the mark.
        assert!(!marks_required_update(&format!(
            "- Explains {REQUIRED_UPDATE_LINE}"
        )));
    }

    const INDEX: &str = r#"
      <h2 id="past-game-patches">Past game patches</h2>
      <ul>
      <li> <a class="preview-title" href="/fa/changelog/fafbeta">FAF Beta Balance</a> </li>
      <h2 id="2026">Year 2026</h2>
      <li> <a class="preview-title" href="/fa/changelog/3837">3837 - Game Patch</a> <span>(Aug 14)</span> </li>
      <li> <a class="preview-title" href="/fa/changelog/3835">3835 - Hotfix</a> <span>(Apr 07)</span> </li>
      <h2 id="2025">Year 2025</h2>
      <li> <a class="preview-title" href="/fa/changelog/3829">3829 - Game Patch</a> <span>(Nov 22)</span> </li>
      </ul>
    "#;

    #[test]
    fn the_index_yields_patch_kind_and_a_reconstructed_source_path() {
        let releases = parse_index(INDEX);
        assert_eq!(releases.len(), 4);

        let branch = &releases[0];
        assert_eq!(branch.id, "fafbeta");
        assert_eq!(branch.kind, "FAF Beta Balance");
        assert!(branch.date.is_empty(), "a rolling branch has no date");
        // The built page, not `docs/changelog/fafbeta.md`: the Markdown holds
        // only the template the Pages build appends the snippets to.
        assert_eq!(
            branch.source_url,
            "https://faforever.github.io/fa/changelog/fafbeta"
        );
        assert_eq!(branch.source_url, branch.web_url);
        assert!(branch.is_rolling());

        let latest = &releases[1];
        assert_eq!(latest.id, "3837");
        assert_eq!(latest.kind, "Game Patch");
        assert_eq!(latest.year, "2026");
        // Jekyll prints the date its filename declares, so this is the exact path.
        assert_eq!(latest.date, "2026-08-14");
        assert_eq!(
            latest.source_url,
            "https://raw.githubusercontent.com/FAForever/fa/master/docs/_posts/2026-08-14-3837.md"
        );
        assert_eq!(
            latest.web_url,
            "https://faforever.github.io/fa/changelog/3837"
        );

        assert_eq!(releases[2].kind, "Hotfix");
        assert_eq!(releases[2].date, "2026-04-07");
        assert_eq!(releases[3].year, "2025", "the year heading carries forward");
    }

    #[test]
    fn a_heading_that_is_not_a_year_never_becomes_one() {
        let releases = parse_index(
            r#"<h2 id="deployment-branches">x</h2>
               <li> <a class="preview-title" href="/fa/changelog/3837">3837 - Game Patch</a> <span>(Aug 14)</span> </li>"#,
        );
        assert_eq!(releases.len(), 1);
        assert!(releases[0].year.is_empty());
        assert!(releases[0].date.is_empty());
        assert!(releases[0].source_url.is_empty());
    }

    #[test]
    fn front_matter_supplies_the_title_and_is_kept_out_of_the_body() {
        let entry = parse_entry(
            "3837",
            "---\nlayout: post\ntitle: 3837 - Game Patch\npermalink: changelog/3837\n---\n\n# Game version 3837\n",
        );
        assert_eq!(entry.title, "3837 - Game Patch");
        assert_eq!(
            entry.blocks,
            vec![ChangelogBlock::Heading {
                level: 1,
                text: "Game version 3837".into()
            }]
        );
    }

    #[test]
    fn a_unit_block_becomes_an_icon_and_a_caption() {
        let entry = parse_entry(
            "x",
            "{% unit URL0303 %}\nLoyalist: T3 Siege Assault Bot\n{% endunit %}\nSome prose.\n",
        );
        assert_eq!(
            entry.blocks[0],
            ChangelogBlock::Unit {
                units: vec![ChangelogUnit {
                    unit_id: Some("URL0303".into()),
                    icon_url: "https://faforever.github.io/fa/assets/icons/URL0303_icon.png".into(),
                }],
                name: "Loyalist: T3 Siege Assault Bot".into(),
            }
        );
        assert!(matches!(entry.blocks[1], ChangelogBlock::Paragraph { .. }));
    }

    #[test]
    fn enhancement_icons_keep_their_path_and_case() {
        assert_eq!(
            unit_icon_url("enhancements/ual0001/ResourceAllocation"),
            "https://faforever.github.io/fa/assets/icons/enhancements/ual0001/ResourceAllocation.png"
        );
    }

    #[test]
    fn nested_list_items_keep_their_depth_and_split_value_changes() {
        let entry = parse_entry(
            "x",
            "- Disintegrator Pulse Laser:\n  - Stun Duration: 1.5s -> 0.4s\n  - Range: 41 -> 30\n",
        );
        let ChangelogBlock::List { items } = &entry.blocks[0] else {
            panic!("expected a list, got {:?}", entry.blocks);
        };
        assert_eq!(items.len(), 1, "the two changes nest under the category");
        assert!(items[0].change.is_none(), "a category is not a change");
        assert_eq!(items[0].children.len(), 2);
        assert_eq!(
            items[0].children[0].change,
            Some(ChangelogChange {
                label: "Stun Duration".into(),
                old: "1.5s".into(),
                new: "0.4s".into(),
            })
        );
        assert_eq!(items[0].children[1].change.as_ref().unwrap().new, "30");
    }

    #[test]
    fn unmarked_stat_lines_are_changes_of_their_bullet_and_keep_the_list_whole() {
        // 3718's Mech Marine: the stats are written without their own markers.
        let blocks = parse_blocks(
            "- Land\n  - Mech Marine\n    Mass Cost: 35 → 30\n    Power Cost: 120 → 100\n  - Tech 2 Land\n    - Mongoose\n",
        );
        let [ChangelogBlock::List { items }] = blocks.as_slice() else {
            panic!("expected one list, got {blocks:?}");
        };
        let land = &items[0].children;
        assert_eq!(land.len(), 2, "Tech 2 Land stays beside the Mech Marine");
        assert_eq!(land[0].children.len(), 2);
        assert_eq!(
            land[0].children[0].change.as_ref().unwrap().label,
            "Mass Cost"
        );
        assert_eq!(land[0].children[1].change.as_ref().unwrap().new, "100");
        assert_eq!(land[1].children.len(), 1);
        // Prose continuing a bullet is still joined into it.
        let ChangelogBlock::List { items } =
            &parse_blocks("- Overcharge\n  now drains a fixed share")[0]
        else {
            panic!("expected a list");
        };
        assert!(items[0].children.is_empty());
    }

    #[test]
    fn balance_captions_without_a_trailing_id_become_unit_headers() {
        let entry = parse_entry("3822", include_str!("fixtures/changelog-3822.md"));
        let unit = |wanted: &str| {
            entry
                .blocks
                .iter()
                .find_map(|block| match block {
                    ChangelogBlock::Unit { name, units } if name == wanted => Some(
                        units
                            .iter()
                            .filter_map(|unit| unit.unit_id.clone())
                            .collect::<Vec<_>>(),
                    ),
                    _ => None,
                })
                .unwrap_or_else(|| panic!("{wanted} is not a unit header"))
        };
        assert_eq!(
            unit("All ACUs, as well as Aeon and Seraphim SACUs"),
            ["UEL0001", "UAL0001", "URL0001", "XSL0001", "UAL0301", "XSL0301"]
        );
        assert_eq!(
            unit("Tactical Missile Launchers (TMLs)"),
            ["UEB2108", "UAB2108", "URB2108", "XSB2108"]
        );
        assert_eq!(
            unit("Tactical Missile Defenses (TMDs)"),
            ["UEB4201", "UAB4201", "URB4201", "XSB4201"]
        );
        // Ids inside the caption, not only at its end.
        assert_eq!(
            unit("Cybran cruiser and carrier Missile Deflectors"),
            ["URS0202", "URS0303"]
        );
        assert_eq!(unit("Aeon ACU Sensor System"), ["UAL0001"]);

        // A faction label stays a label, and a caption outside a balance
        // section stays bold text.
        let blocks = |markdown: &str| parse_entry("x", markdown).blocks;
        for markdown in [
            "## Balance\n\n**Aeon, UEF**\n- HP: 550 -> 775\n",
            "## Bug fixes\n\n**Ialla: T1 Anti-Air Defense**\n- Range: 40 -> 44\n",
            "## Balance\n\n**A caption with nothing after it**\n",
        ] {
            assert!(
                matches!(blocks(markdown)[1], ChangelogBlock::Paragraph { .. }),
                "{markdown}"
            );
        }
        // A caption naming no known class still becomes a header, without
        // an icon rather than a guessed one.
        let parsed = blocks("## Balance\n\n**Naval factories**\n- Build time: 1 -> 2\n");
        let [_, ChangelogBlock::Unit { name, units }, _] = parsed.as_slice() else {
            panic!("expected a unit header");
        };
        assert_eq!(name, "Naval factories");
        assert!(units.is_empty());
    }

    #[test]
    fn nested_balance_captions_restore_3810_and_3813_units_without_changing_stats_or_links() {
        fn facts(blocks: &[ChangelogBlock]) -> (Vec<ChangelogChange>, Vec<String>) {
            fn items(
                list: &[ChangelogListItem],
                changes: &mut Vec<ChangelogChange>,
                links: &mut Vec<String>,
            ) {
                for item in list {
                    if let Some(change) = &item.change {
                        changes.push(change.clone());
                    }
                    for span in &item.spans {
                        if let ChangelogSpan::Link { url, .. } | ChangelogSpan::Issue { url, .. } =
                            span
                        {
                            links.push(url.clone());
                        }
                    }
                    items(&item.children, changes, links);
                }
            }
            let (mut changes, mut links) = (Vec::new(), Vec::new());
            for block in blocks {
                if let ChangelogBlock::List { items: list } = block {
                    items(list, &mut changes, &mut links);
                }
            }
            (changes, links)
        }
        for (id, markdown, expected) in [
            (
                "3810",
                include_str!("fixtures/changelog-3810.md"),
                vec![
                    "XSS0304", "DELK002", "DALK003", "XSL0303", "UAL0104", "XSA0203", "DRL0204",
                    "XSS0201", "URS0201", "XES0102", "UAS0401", "UES0401", "XRA0305",
                ],
            ),
            (
                "3813",
                include_str!("fixtures/changelog-3813.md"),
                vec!["URA0401", "SRL0310", "UAS0202", "XRL0302", "URL0001"],
            ),
        ] {
            let original = parse_blocks(split_front_matter(markdown).1);
            let entry = parse_entry(id, markdown);
            assert_eq!(
                facts(&original),
                facts(&entry.blocks),
                "{id}: stat and reference order must survive"
            );
            let units: Vec<_> = entry
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ChangelogBlock::Unit { units, .. } => Some(units),
                    _ => None,
                })
                .flatten()
                .collect();
            assert_eq!(
                units
                    .iter()
                    .filter_map(|unit| unit.unit_id.as_deref())
                    .collect::<Vec<_>>(),
                expected
            );
            assert!(units
                .iter()
                .all(|unit| unit.icon_url == unit_icon_url(unit.unit_id.as_deref().unwrap())));
            for (at, block) in entry.blocks.iter().enumerate() {
                if let ChangelogBlock::Unit { .. } = block {
                    assert!(
                        matches!(entry.blocks.get(at + 1), Some(ChangelogBlock::List { items }) if !items.is_empty()),
                        "{id}: unit stats must follow their caption"
                    );
                }
            }
        }
        let entry = parse_entry("3813", include_str!("fixtures/changelog-3813.md"));
        let soul_ripper = entry
            .blocks
            .iter()
            .position(|block| {
                matches!(block,
            ChangelogBlock::Unit { name, .. } if name == "Soul Ripper: Experimental Gunship")
            })
            .unwrap();
        let ChangelogBlock::List { items } = &entry.blocks[soul_ripper + 1] else {
            panic!("missing weapons");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].children.len(),
            3,
            "weapon stat nesting must survive"
        );
    }

    #[test]
    fn nested_unit_captions_leave_code_nonbalance_sections_and_ambiguous_prose_unchanged() {
        for markdown in [
            "## Bug fixes\n- Soul Ripper (URA0401):\n  - Health: 1 -> 2\n",
            "## Balance\n- `Soul Ripper (URA0401):`\n  - Health: 1 -> 2\n",
            "## Balance\n- Soul Ripper (not-an-id):\n  - Health: 1 -> 2\n",
            "## Balance\n- Soul Ripper (URA0401):\n",
            "## Balance\n```\n- Soul Ripper (URA0401):\n  - Health: 1 -> 2\n```\n",
        ] {
            assert_eq!(
                parse_entry("x", markdown).blocks,
                parse_blocks(markdown),
                "{markdown}"
            );
        }
        let mut item = ChangelogListItem {
            spans: vec![ChangelogSpan::Text("Soul Ripper (URA0401)".into())],
            change: None,
            children: vec![ChangelogListItem {
                spans: vec![ChangelogSpan::Text("Health: 1 -> 2".into())],
                change: parse_change("Health: 1 -> 2"),
                children: Vec::new(),
            }],
        };
        for _ in 0..40 {
            item = ChangelogListItem {
                spans: vec![ChangelogSpan::Text("Group".into())],
                change: None,
                children: vec![item],
            };
        }
        let mut blocks = vec![
            ChangelogBlock::Heading {
                level: 2,
                text: "Balance".into(),
            },
            ChangelogBlock::List { items: vec![item] },
        ];
        let original = blocks.clone();
        nested_balance_units(&mut blocks);
        assert_eq!(blocks, original, "extreme nesting must remain literal");
    }

    #[test]
    fn prose_with_a_colon_but_no_arrow_stays_prose() {
        assert!(parse_change("Note: this is not a balance change").is_none());
        assert!(parse_change("Health: 500").is_none());
    }

    #[test]
    fn inline_runs_cover_bold_code_links_and_issue_references() {
        assert_eq!(
            parse_spans("Fix **stun** in `Loyalist` per [docs](https://x.y) (#7121)."),
            vec![
                ChangelogSpan::Text("Fix ".into()),
                ChangelogSpan::Strong("stun".into()),
                ChangelogSpan::Text(" in ".into()),
                ChangelogSpan::Code("Loyalist".into()),
                ChangelogSpan::Text(" per ".into()),
                ChangelogSpan::Link {
                    text: "docs".into(),
                    url: "https://x.y".into()
                },
                ChangelogSpan::Text(" ".into()),
                ChangelogSpan::Issue {
                    label: None,
                    number: "7121".into(),
                    url: "https://github.com/FAForever/fa/issues/7121".into()
                },
                ChangelogSpan::Text(".".into()),
            ]
        );
    }

    const CLIENT_ISSUES: &str = "https://github.com/Org/Repo/issues";

    #[test]
    fn a_client_release_body_reads_as_its_categories_without_the_installer_line() {
        // What `scripts/changelog.mjs combine` writes, plus the sentence the
        // Release workflow appends after it.
        let body = "### Features\n\n\
                    - Replays can be filtered by map.\n\
                    - The Links tab fits on one screen (#507).\n\n\
                    ### Bug fixes\n\n\
                    - Chat: tabs -> a sidebar, as before.\n\n\
                    Download the installer for your platform from the assets below.\n";
        let blocks = parse_release_notes(body, CLIENT_ISSUES);

        assert_eq!(blocks.len(), 4, "{blocks:#?}");
        assert_eq!(
            blocks[0],
            ChangelogBlock::Heading {
                level: 3,
                text: "Features".into()
            }
        );
        let ChangelogBlock::List { items } = &blocks[1] else {
            panic!("expected the features list, got {:?}", blocks[1]);
        };
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].spans,
            vec![ChangelogSpan::Text(
                "Replays can be filtered by map.".into()
            )]
        );
        // This repository's pull request, not FAForever/fa's.
        assert!(items[1].spans.contains(&ChangelogSpan::Issue {
            label: None,
            number: "507".into(),
            url: "https://github.com/Org/Repo/issues/507".into(),
        }));
        assert_eq!(
            blocks[2],
            ChangelogBlock::Heading {
                level: 3,
                text: "Bug fixes".into()
            }
        );
        let ChangelogBlock::List { items } = &blocks[3] else {
            panic!("expected the fixes list, got {:?}", blocks[3]);
        };
        // An arrow in a client note is prose, not a balance diff.
        assert_eq!(items[0].change, None);
        assert_eq!(
            items[0].spans,
            vec![ChangelogSpan::Text(
                "Chat: tabs -> a sidebar, as before.".into()
            )]
        );
    }

    #[test]
    fn an_older_free_form_release_body_still_parses() {
        // The shape of GitHub's generated notes, which list with `*`, and a
        // few constructs this dialect has no block for.
        let body = "## What's Changed\r\n\
                    * Add the replay filters by @someone in https://github.com/Org/Repo/pull/12\r\n\
                    * Fix the login\r\n\
                    \x20 * with a nested detail\r\n\
                    \r\n\
                    **Full Changelog**: https://github.com/Org/Repo/compare/v0.1.0...v0.2.0\r\n\
                    \r\n\
                    ```\r\n\
                    some code\r\n\
                    ```\r\n";
        let blocks = parse_release_notes(body, CLIENT_ISSUES);

        assert_eq!(
            blocks[0],
            ChangelogBlock::Heading {
                level: 2,
                text: "What's Changed".into()
            }
        );
        let ChangelogBlock::List { items } = &blocks[1] else {
            panic!(
                "expected the starred bullets as a list, got {:?}",
                blocks[1]
            );
        };
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].children.len(), 1, "the nested bullet nests");
        let ChangelogBlock::Paragraph { spans } = &blocks[2] else {
            panic!("expected the trailing line as prose, got {:?}", blocks[2]);
        };
        assert_eq!(spans[0], ChangelogSpan::Strong("Full Changelog".into()));
        assert_eq!(
            blocks[3],
            ChangelogBlock::CodeBlock {
                text: "some code".into()
            }
        );
    }

    #[test]
    fn an_empty_release_body_has_no_blocks() {
        assert_eq!(parse_release_notes("", CLIENT_ISSUES), vec![]);
        assert_eq!(parse_release_notes(" \r\n\n\t\n", CLIENT_ISSUES), vec![]);
        // Every release before the snippets existed said only this.
        assert_eq!(
            parse_release_notes(
                "Download the installer for your platform from the assets below.",
                CLIENT_ISSUES
            ),
            vec![]
        );
    }

    #[test]
    fn malformed_release_markdown_never_panics() {
        for body in [
            "#",
            "########",
            "-",
            "- ",
            "* ",
            "+",
            "  - indented first\n- then a root",
            "[unclosed](",
            "(#",
            "(#)",
            "**",
            "`",
            "{% unit %}",
            "{% unit XRL0302 %}",
            "**Name (ABC1234):**",
            "Größe: 1 -> 2\n- Größe: 1 --> 2",
            "\u{feff}---\ntitle: x\n---",
        ] {
            let _ = parse_release_notes(body, CLIENT_ISSUES);
        }
    }

    #[test]
    fn a_parenthesised_non_issue_is_left_alone() {
        assert_eq!(
            parse_spans("(#not-a-number)"),
            vec![ChangelogSpan::Text("(#not-a-number)".into())]
        );
    }

    #[test]
    fn both_arrow_spellings_split_the_same_way() {
        // The archive is inconsistent about this, and matching only the short
        // form left the old value as a trailing dash on most of the corpus.
        for text in [
            "MaxSpeed: 4.6 --> 4.8",
            "MaxSpeed: 4.6 -> 4.8",
            "MaxSpeed: 4.6 \u{2192} 4.8",
        ] {
            assert_eq!(
                parse_change(text),
                Some(ChangelogChange {
                    label: "MaxSpeed".into(),
                    old: "4.6".into(),
                    new: "4.8".into(),
                }),
                "failed on {text}"
            );
        }
    }

    #[test]
    fn the_prose_unit_header_used_before_the_liquid_tag_still_yields_icons() {
        let entry = parse_entry(
            "3836",
            "**Yathsou: T3 Submarine Hunter (XSS0304):**\n\n- Health: 4000 --> 3600\n",
        );
        assert_eq!(
            entry.blocks[0],
            ChangelogBlock::Unit {
                units: vec![ChangelogUnit {
                    unit_id: Some("XSS0304".into()),
                    icon_url: "https://faforever.github.io/fa/assets/icons/XSS0304_icon.png".into(),
                }],
                name: "Yathsou: T3 Submarine Hunter".into(),
            }
        );
    }

    #[test]
    fn a_header_naming_a_family_yields_one_icon_per_unit() {
        let entry = parse_entry(
            "x",
            "**T3 Mass Fabricators (UEB1303, URB1303, UAB1303, XSB1303):**\n",
        );
        let ChangelogBlock::Unit { units, name } = &entry.blocks[0] else {
            panic!("expected a unit header, got {:?}", entry.blocks);
        };
        assert_eq!(name, "T3 Mass Fabricators");
        assert_eq!(units.len(), 4);
        assert!(units[3].icon_url.ends_with("XSB1303_icon.png"));
    }

    #[test]
    fn a_bold_sentence_that_merely_ends_in_a_bracket_stays_a_sentence() {
        // The id shape is the whole guard here: without it every bold line
        // ending in brackets would ask the site for an icon that does not exist.
        for text in [
            "**Note (see below):**",
            "**Reworked the chat window (finally)**",
            "**Fixes (#7121)**",
        ] {
            assert!(unit_header(text).is_none(), "wrongly matched {text}");
        }
    }

    #[test]
    fn legacy_unit_header_variants_validate_ids_and_preserve_names() {
        let cases: [(&str, &str, &[&str]); 6] = [
            (
                "**Aeon and Seraphim snipers (XAL0305 & XSL0305):**",
                "Aeon and Seraphim snipers",
                &["XAL0305", "XSL0305"],
            ),
            (
                "**Snipers (XAL0305 and XSL0305):**",
                "Snipers",
                &["XAL0305", "XSL0305"],
            ),
            (
                "**Barracuda (XRS0204) and Megalith (XRL0403):**",
                "Barracuda and Megalith",
                &["XRS0204", "XRL0403"],
            ),
            (
                "**Engineers (all factions) (UEL0105, UAL0105, URL0105, XSL0105):**",
                "Engineers (all factions)",
                &["UEL0105", "UAL0105", "URL0105", "XSL0105"],
            ),
            (
                "**UEF Engineers (uel0105, UEL0105):**",
                "UEF Engineers",
                &["uel0105"],
            ),
            (
                "**Uyanah: T3 Lightning Tank (DSLK004):**",
                "Uyanah: T3 Lightning Tank",
                &["DSLK004"],
            ),
        ];
        for (text, expected_name, expected_ids) in cases {
            let (name, ids) = unit_header(text).unwrap_or_else(|| panic!("missed {text}"));
            assert_eq!(name, expected_name);
            assert_eq!(ids, expected_ids, "wrong unit icons for {text}");
        }

        for text in [
            "**Snipers (XAL0305 & finally):**",
            "**Snipers (XAL0305,):**",
            "**Snipers (& XAL0305):**",
            "**Snipers (XAL0305 and):**",
            "**Snipers (XAL0305 and and XSL0305):**",
            "**Snipers (XAL0305 XSL0305):**",
            "**Snipers (XAL0305), changed:**",
            "**Engineers (all factions):**",
            "**Factory (UEB12345):**",
            "**Factory (UE12345):**",
        ] {
            assert!(unit_header(text).is_none(), "wrongly matched {text}");
        }
    }

    #[test]
    fn a_rendered_balance_row_reads_as_the_change_it_is() {
        let entry = parse_rendered_entry(
            "fafbeta",
            concat!(
                "<title>FAF Beta Balance | FAForever Game Repo</title>",
                "<main>",
                "<h2 id=\"balance\"><a href=\"#balance\" class=\"anchor-heading\">",
                "<svg><use xlink:href=\"#svg-link\"></use></svg></a> Balance </h2>",
                "<div class=\"unit-header\">",
                "<img class=\"unit-icon\" src=\"../assets/icons/UAB0304_icon.png\" />",
                "<span class=\"unit-name\">Quantum Gateways</span></div>",
                "<ul>",
                "<li><span class=\"change\">Mass cost: </span>",
                "<span class=\"old\">3000</span> \u{2192} <span class=\"new\">2550</span></li>",
                "<li><span class=\"change-category\">Adjacency: </span><ul>",
                "<li><span class=\"change\">Energy discount: </span>",
                "<span class=\"old\">0.25%</span> \u{2192} <span class=\"new\">1.563%</span></li>",
                "</ul></li>",
                "</ul>",
                "</main>",
            ),
        );

        assert_eq!(entry.title, "FAF Beta Balance", "the site name is dropped");
        assert_eq!(
            entry.blocks[0],
            ChangelogBlock::Heading {
                level: 2,
                text: "Balance".into()
            },
            "the theme's anchor icon is not part of the heading"
        );
        assert_eq!(
            entry.blocks[1],
            ChangelogBlock::Unit {
                units: vec![ChangelogUnit {
                    unit_id: Some("UAB0304".into()),
                    icon_url: unit_icon_url("UAB0304"),
                }],
                name: "Quantum Gateways".into(),
            },
            "the icon resolves to the same absolute URL the archive uses"
        );

        let ChangelogBlock::List { items } = &entry.blocks[2] else {
            panic!("expected the change list, got {:?}", entry.blocks[2]);
        };
        assert_eq!(
            items[0].change,
            Some(ChangelogChange {
                label: "Mass cost".into(),
                old: "3000".into(),
                new: "2550".into(),
            })
        );
        assert_eq!(
            items[0].spans,
            vec![ChangelogSpan::Text("Mass cost: 3000 \u{2192} 2550".into())],
            "the runs the tags split are rejoined"
        );

        // A category owns no values: reading its subtree would hand it the
        // first pair belonging to the row underneath it.
        assert_eq!(items[1].change, None);
        assert_eq!(
            items[1].spans,
            vec![ChangelogSpan::Text("Adjacency:".into())]
        );
        assert_eq!(items[1].children.len(), 1);
        assert_eq!(
            items[1].children[0].change,
            Some(ChangelogChange {
                label: "Energy discount".into(),
                old: "0.25%".into(),
                new: "1.563%".into(),
            })
        );
    }

    #[test]
    fn a_rendered_citation_becomes_the_same_issue_span_the_markdown_gives() {
        // `changelog-links.sh` links these during the build, so they arrive as
        // anchors rather than as the `(#7141)` the Markdown path sees. Both
        // halves of the tab should render one the same way.
        let entry = parse_rendered_entry(
            "fafbeta",
            concat!(
                "<main><ul><li><p>Fix <code>ACUUnit.lua</code> ",
                "(<a href=\"https://github.com/FAForever/fa/pull/7215\">#7215</a>).</p>",
                "</li></ul></main>",
            ),
        );

        let ChangelogBlock::List { items } = &entry.blocks[0] else {
            panic!("expected a list, got {:?}", entry.blocks[0]);
        };
        assert_eq!(
            items[0].spans,
            vec![
                ChangelogSpan::Text("Fix ".into()),
                ChangelogSpan::Code("ACUUnit.lua".into()),
                ChangelogSpan::Text(" (".into()),
                ChangelogSpan::Issue {
                    label: None,
                    number: "7215".into(),
                    url: "https://github.com/FAForever/fa/pull/7215".into(),
                },
                ChangelogSpan::Text(").".into()),
            ],
            "the loose list's paragraph wrapper is transparent"
        );
    }

    #[test]
    fn the_template_comment_is_not_part_of_the_notes() {
        // The branch template ends with an HTML comment explaining that the
        // build appends the content below it. It is not a patch note.
        let entry = parse_rendered_entry(
            "fafbeta",
            "<main><!-- This is a template, content is appended --><p>Real.</p></main>",
        );
        assert_eq!(
            entry.blocks,
            vec![ChangelogBlock::Paragraph {
                spans: vec![ChangelogSpan::Text("Real.".into())],
            }]
        );
    }

    #[test]
    fn a_page_without_front_matter_is_all_body() {
        let entry = parse_entry("fafdevelop", "## Balance\n\nSome text.\n");
        assert_eq!(entry.title, "fafdevelop");
        assert_eq!(entry.blocks.len(), 2);
    }
}

/// Checked against the real documents rather than only hand-written snippets:
/// this codec's whole job is to survive what FAForever/fa actually publishes,
/// and a dialect this specific is easy to get subtly wrong against a mock.
#[cfg(test)]
mod real_document_tests {
    use super::*;

    const INDEX_HTML: &str = include_str!("fixtures/changelog-index.html");
    const POST_3818: &str = include_str!("fixtures/changelog-3818.md");
    const POST_3728: &str = include_str!("fixtures/changelog-3728.md");
    const POST_3822: &str = include_str!("fixtures/changelog-3822.md");
    const POST_3745: &str = include_str!("fixtures/changelog-3745.md");
    const POST_3837: &str = include_str!("fixtures/changelog-3837.md");
    const POST_3836: &str = include_str!("fixtures/changelog-3836.md");

    #[test]
    fn published_3745_contributor_citations_recover_missing_separators_and_hashes() {
        let entry = parse_entry("3745", POST_3745);
        let contributors = entry
            .blocks
            .iter()
            .position(|block| {
                matches!(block,
            ChangelogBlock::Heading { text, .. } if text == "Contributors")
            })
            .unwrap();
        let ChangelogBlock::List { items } = &entry.blocks[contributors + 1] else {
            panic!("missing contributors");
        };
        let jip = items.iter().find(|item| matches!(item.spans.first(), Some(ChangelogSpan::Text(text)) if text.starts_with("Jip "))).unwrap();
        let references: Vec<_> = jip
            .spans
            .iter()
            .filter_map(|span| match span {
                ChangelogSpan::Issue { number, url, label } => {
                    assert_eq!(url, &format!("{ISSUE_BASE}/{number}"));
                    if label.is_some() {
                        assert_eq!(label.as_deref(), Some("4230"));
                    }
                    Some(number.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(references.len(), 48);
        assert_eq!(&references[..3], ["4119", "4124", "4188"]);
        assert_eq!(references.last(), Some(&"4230"));
        let rendered: String = jip
            .spans
            .iter()
            .map(|span| match span {
                ChangelogSpan::Text(text) => text.clone(),
                ChangelogSpan::Issue { number, label, .. } => {
                    label.clone().unwrap_or_else(|| format!("#{number}"))
                }
                _ => panic!("unexpected contributor formatting"),
            })
            .collect();
        let source = POST_3745
            .split_once("- Jip ")
            .unwrap()
            .1
            .split_once("\n- iczero")
            .unwrap()
            .0;
        assert_eq!(
            rendered,
            format!(
                "Jip {}",
                source.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        );
        assert!(rendered.contains("#4124#4188"));
        assert!(rendered.ends_with(", 4230)"));
    }

    #[test]
    fn published_3728_wrapped_contributor_references_are_links_in_one_bullet() {
        let entry = parse_entry("3728", POST_3728);
        let headings: Vec<_> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::Heading { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(headings.contains(&"Contributors"));
        assert!(headings.contains(&"Reviewers"));
        assert!(headings.contains(&"Translators"));
        assert!(
            headings
                .iter()
                .all(|text| !text.starts_with(|character: char| character.is_ascii_digit())),
            "{headings:?}"
        );
        let contributors = entry.blocks.iter().position(|block| matches!(block, ChangelogBlock::Heading { text, .. } if text == "Contributors")).unwrap();
        let ChangelogBlock::List { items } = &entry.blocks[contributors + 1] else {
            panic!("missing contributors");
        };
        assert_eq!(items.len(), 13);
        let jip = &items[4];
        assert!(matches!(&jip.spans[0], ChangelogSpan::Text(text) if text == "Jip "));
        let references: Vec<_> = jip
            .spans
            .iter()
            .filter_map(|span| match span {
                ChangelogSpan::Issue { number, url, .. } => {
                    assert_eq!(url, &format!("{ISSUE_BASE}/{number}"));
                    Some(number.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(references.len(), 45);
        assert_eq!(references.first(), Some(&"3443"));
        assert_eq!(references.last(), Some(&"3617"));
        let rendered: String = jip
            .spans
            .iter()
            .map(|span| match span {
                ChangelogSpan::Text(text) => text.clone(),
                ChangelogSpan::Issue { number, .. } => format!("#{number}"),
                _ => panic!("unexpected contributor formatting"),
            })
            .collect();
        let source = POST_3728
            .split_once("- Jip ")
            .unwrap()
            .1
            .split_once("\n- KionX")
            .unwrap()
            .0;
        assert_eq!(
            rendered,
            format!(
                "Jip {}",
                source.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        );
    }

    #[test]
    fn published_3836_stat_descriptions_do_not_extend_the_new_value() {
        let entry = parse_entry("3836", POST_3836);
        for (label, value, description) in [
            (
                "AA Damage Radius",
                "1.5",
                "The Cybran carrier has a bit more splash",
            ),
            (
                "Torpedoes per volley",
                "5",
                "Damage per volley is kept the same (750).",
            ),
            (
                "Torpedoes per volley",
                "6x2",
                "Damage per volley is kept the same (5000 --> 5004).",
            ),
        ] {
            let index = entry.blocks.iter().position(|block| matches!(block,
                ChangelogBlock::List { items } if items.iter().any(|item|
                    item.change.as_ref().is_some_and(|change| change.label == label && change.new == value)))).unwrap();
            assert!(
                matches!(&entry.blocks[index + 1], ChangelogBlock::Paragraph { spans }
                if spans.iter().any(|span| matches!(span, ChangelogSpan::Text(text) if text.starts_with(description))))
            );
        }
    }

    #[test]
    fn published_3822_unit_rosters_keep_all_fifteen_units_on_separate_lines() {
        let entry = parse_entry("3822", POST_3822);
        let code: Vec<&str> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::CodeBlock { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(code.len(), 2);
        assert_eq!(code[0].lines().count(), 6);
        assert_eq!(code[1].lines().count(), 9);
        assert!(code[0].starts_with("Jester: T1 Light Gunship (XRA0105)\nStinger:"));
        assert!(code[0].ends_with("Dragon Fly: T2 Air Transport (URA0104)"));
        assert!(code[1].contains("Cougar: T3 Mobile Rapid-fire AA Cannon (DELK002)\n"));
        assert!(code[1].ends_with("Sinnatha: T2 Anti-Air Flak Artillery (XSB2204)"));
        assert!(code.iter().all(|code| !code.contains("```")));
        assert!(entry.blocks.iter().any(
            |block| matches!(block, ChangelogBlock::Heading { text, .. } if text == "Features")
        ));
    }

    #[test]
    fn published_3822_artillery_intro_starts_after_the_cooper_stat_list() {
        let entry = parse_entry("3822", POST_3822);
        let cooper = entry
            .blocks
            .iter()
            .position(|block| {
                matches!(block,
            ChangelogBlock::Unit { name, .. } if name.contains("Cooper"))
            })
            .unwrap();
        let ChangelogBlock::List { items } = &entry.blocks[cooper + 1] else {
            panic!("missing Cooper stats");
        };
        assert_eq!(
            items.last().unwrap().change.as_ref().unwrap().label,
            "SelectionSizeZ"
        );
        assert!(items
            .iter()
            .all(|item| !format!("{:?}", item.spans).contains("6481")));
        let ChangelogBlock::List { items } = &entry.blocks[cooper + 2] else {
            panic!("missing separate artillery introduction");
        };
        assert_eq!(items.len(), 1);
        assert!(format!("{:?}", items[0].spans).contains("T3 static artillery"));
        let references: Vec<_> = items[0]
            .spans
            .iter()
            .filter_map(|span| match span {
                ChangelogSpan::Issue { number, url, .. } => Some((number.as_str(), url.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            references,
            [
                ("6481", "https://github.com/FAForever/fa/issues/6481"),
                ("6482", "https://github.com/FAForever/fa/issues/6482"),
            ]
        );
        assert!(matches!(
            &entry.blocks[cooper + 3],
            ChangelogBlock::Paragraph { .. }
        ));
    }

    #[test]
    fn published_3745_lua_example_keeps_its_comments_strings_and_blank_lines() {
        let entry = parse_entry("3745", POST_3745);
        let code: Vec<&str> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::CodeBlock { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(code.len(), 1);
        let source = POST_3745.replace("\r\n", "\n");
        let expected = source
            .split_once("```lua\n")
            .unwrap()
            .1
            .split_once("\n```")
            .unwrap()
            .0;
        assert_eq!(code[0], expected);
    }
    /// The built page for the rolling beta branch, which is where its notes
    /// exist: `docs/changelog/fafbeta.md` is the template alone.
    const PAGE_FAFBETA: &str = include_str!("fixtures/changelog-fafbeta.html");

    #[test]
    fn the_published_index_parses_into_every_release() {
        let releases = parse_index(INDEX_HTML);

        assert!(
            releases.len() > 150,
            "the site lists well over 150 releases, got {}",
            releases.len()
        );

        let branches: Vec<&str> = releases
            .iter()
            .filter(|release| release.date.is_empty())
            .map(|release| release.id.as_str())
            .collect();
        assert_eq!(branches, ["fafbeta", "fafdevelop"]);

        let dated: Vec<&ChangelogRelease> = releases
            .iter()
            .filter(|release| !release.date.is_empty())
            .collect();
        assert!(dated
            .iter()
            .all(|release| release.date.len() == 10 && release.year.len() == 4));
        assert!(dated
            .iter()
            .all(|release| release.kind == "Game Patch" || release.kind == "Hotfix"));
        assert!(dated
            .iter()
            .all(|release| release.source_url.ends_with(".md")));

        let latest = dated.first().expect("at least one dated release");
        assert_eq!(latest.id, "3837");
        assert_eq!(latest.date, "2026-08-14");
    }

    #[test]
    fn the_published_branch_page_parses_into_the_same_shape_as_a_patch_note() {
        let entry = parse_rendered_entry("fafbeta", PAGE_FAFBETA);
        assert_eq!(entry.title, "FAF Beta Balance");

        let units = entry
            .blocks
            .iter()
            .filter(|block| matches!(block, ChangelogBlock::Unit { .. }))
            .count();
        let lists: Vec<&ChangelogListItem> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::List { items } => Some(items),
                _ => None,
            })
            .flatten()
            .collect();

        assert!(units >= 5, "expected unit headers, got {units}");
        assert!(
            lists.iter().filter(|item| item.change.is_some()).count() >= 15,
            "expected the balance rows to read as changes"
        );

        // The regression itself: reading the Markdown source gave the preamble
        // and nothing else, so the tab showed a branch with no changes in it.
        assert!(
            entry.blocks.len() > 20,
            "expected the deployed changes, got {} blocks",
            entry.blocks.len()
        );
        assert!(
            entry.blocks.iter().any(|block| matches!(
                block,
                ChangelogBlock::Heading { text, .. } if text == "Balance"
            )),
            "the Balance section is the point of the page"
        );

        // Every icon must be an absolute URL: the page writes them relative to
        // itself, and the client is not serving from faforever.github.io.
        for block in &entry.blocks {
            if let ChangelogBlock::Unit { units, .. } = block {
                assert!(
                    units
                        .iter()
                        .all(|unit| unit.icon_url.starts_with("https://")),
                    "a relative icon reached the state: {units:?}"
                );
            }
        }

        // Nothing from the navigation, the breadcrumbs or the footer.
        assert!(
            !entry.blocks.iter().any(|block| matches!(
                block,
                ChangelogBlock::Paragraph { spans }
                    if spans.iter().any(|span| matches!(
                        span,
                        ChangelogSpan::Link { text, .. } if text == "Just the Docs"
                    ))
            )),
            "the theme's footer is not a patch note"
        );
    }

    #[test]
    fn a_published_patch_note_parses_into_headings_units_and_changes() {
        let entry = parse_entry("3837", POST_3837);
        assert_eq!(entry.title, "3837 - Game Patch");

        let headings = entry
            .blocks
            .iter()
            .filter(|block| matches!(block, ChangelogBlock::Heading { .. }))
            .count();
        let units: Vec<&ChangelogBlock> = entry
            .blocks
            .iter()
            .filter(|block| matches!(block, ChangelogBlock::Unit { .. }))
            .collect();
        let lists: Vec<&ChangelogBlock> = entry
            .blocks
            .iter()
            .filter(|block| matches!(block, ChangelogBlock::List { .. }))
            .collect();

        assert!(
            headings >= 3,
            "expected the section headings, got {headings}"
        );
        assert!(
            units.len() >= 5,
            "expected unit blocks, got {}",
            units.len()
        );
        assert!(
            lists.len() >= 5,
            "expected change lists, got {}",
            lists.len()
        );

        // Every unit block resolves to a caption and a fetchable-looking icon.
        for block in &units {
            let ChangelogBlock::Unit { name, units } = block else {
                unreachable!()
            };
            assert!(!name.is_empty(), "a unit block lost its caption");
            assert!(!units.is_empty(), "a unit block named no unit");
            assert!(units.iter().all(|unit| unit
                .icon_url
                .starts_with("https://faforever.github.io/fa/assets/icons/")));
        }

        // The Liquid tags are consumed, never left as literal text.
        assert!(!format!("{:?}", entry.blocks).contains("{%"));

        // Balance lines are split into old and new rather than left as prose.
        let changes = count_changes(&entry.blocks);
        assert!(changes >= 20, "expected many value changes, got {changes}");
    }

    #[test]
    fn the_older_prose_format_gets_the_same_icons_and_diffs() {
        // 3836 predates the `{% unit %}` tag: it names units in bold with their
        // ids, and spells the arrow `-->`. Both are handled, so the archive is
        // not a second-class citizen next to the newest patch.
        let entry = parse_entry("3836", POST_3836);

        let units: Vec<&ChangelogBlock> = entry
            .blocks
            .iter()
            .filter(|block| matches!(block, ChangelogBlock::Unit { .. }))
            .collect();
        assert!(
            units.len() >= 8,
            "expected the prose unit headers to be recognised, got {}",
            units.len()
        );

        // At least one of them names a whole family in one heading.
        assert!(units.iter().any(|block| matches!(
            block,
            ChangelogBlock::Unit { units, .. } if units.len() > 1
        )));

        let changes = count_changes(&entry.blocks);
        assert!(changes >= 20, "expected value changes, got {changes}");

        // The bug this pins: `-->` used to leave the old value as a dash.
        assert!(
            !change_values(&entry.blocks).any(|value| value.ends_with('-')),
            "an arrow was split in the wrong place"
        );
    }

    #[test]
    fn legacy_nested_unit_headings_preserve_the_published_3818_changes() {
        let entry = parse_entry("3818", POST_3818);
        let units: Vec<(&str, &[ChangelogUnit])> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::Unit { name, units } => Some((name.as_str(), units.as_slice())),
                _ => None,
            })
            .collect();

        assert_eq!(
            units.len(),
            17,
            "every published unit heading must be navigable"
        );
        let ids: Vec<Vec<&str>> = units
            .iter()
            .map(|(_, units)| {
                units
                    .iter()
                    .map(|unit| unit.unit_id.as_deref().unwrap())
                    .collect()
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                vec!["UAA0310"],
                vec!["XSA0203"],
                vec!["XSS0304"],
                vec!["XSS0201"],
                vec!["UEB4301"],
                vec!["UAB2301"],
                vec!["XSB2301"],
                vec!["UEA0001"],
                vec!["XSA0203"],
                vec!["XAL0305", "XSL0305"],
                vec!["XSL0305"],
                vec!["UAS0305"],
                vec!["XSS0203"],
                vec!["XSS0304"],
                vec!["XRS0204", "XRL0403"],
                vec!["XRL0305"],
                vec!["XSS0201"],
            ],
            "unit order and repeated changes to the same unit must be retained"
        );
        assert_eq!(units[9].0, "Aeon and Seraphim snipers");
        assert_eq!(units[14].0, "Barracuda and Megalith");
        for (_, units) in &units {
            for unit in *units {
                assert_eq!(
                    unit.icon_url,
                    unit_icon_url(unit.unit_id.as_deref().unwrap())
                );
            }
        }
        assert_eq!(
            count_changes(&entry.blocks),
            51,
            "no stat changes may disappear"
        );

        let czar = entry
            .blocks
            .iter()
            .position(|block| {
                matches!(block, ChangelogBlock::Unit { name, .. }
                if name == "CZAR: Experimental Aircraft Carrier")
            })
            .unwrap();
        let ChangelogBlock::List {
            items: descriptions,
        } = &entry.blocks[czar - 1]
        else {
            panic!("the Czar's description must remain before its heading");
        };
        assert!(descriptions
            .last()
            .unwrap()
            .spans
            .iter()
            .any(|span| matches!(
                span,
                ChangelogSpan::Issue { number, .. } if number == "6551"
            )));
        let ChangelogBlock::List { items: categories } = &entry.blocks[czar + 1] else {
            panic!("the Czar's stat groups must follow its heading");
        };
        assert_eq!(
            categories[0].spans,
            vec![ChangelogSpan::Text("Intel".into())]
        );
        assert_eq!(
            categories[0].children[0].change,
            Some(ChangelogChange {
                label: "VisionRadius".into(),
                old: "70".into(),
                new: "100".into(),
            })
        );
        assert!(entry.blocks.iter().any(|block| matches!(
            block,
            ChangelogBlock::Paragraph { spans } if spans.iter().any(|span| matches!(
                span,
                ChangelogSpan::Text(text) if text.contains("This fixes them consistently missing shots")
            ))
        )), "explanatory paragraphs between stat changes must survive");
        assert!(entry.blocks.iter().any(|block| matches!(
            block, ChangelogBlock::Heading { text, .. } if text == "Features"
        )));
    }

    fn change_values(blocks: &[ChangelogBlock]) -> impl Iterator<Item = String> + '_ {
        fn walk(items: &[ChangelogListItem], out: &mut Vec<String>) {
            for item in items {
                if let Some(change) = &item.change {
                    out.push(change.old.clone());
                    out.push(change.new.clone());
                }
                walk(&item.children, out);
            }
        }
        let mut out = Vec::new();
        for block in blocks {
            if let ChangelogBlock::List { items } = block {
                walk(items, &mut out);
            }
        }
        out.into_iter()
    }

    fn count_changes(blocks: &[ChangelogBlock]) -> usize {
        fn walk(items: &[ChangelogListItem]) -> usize {
            items
                .iter()
                .map(|item| usize::from(item.change.is_some()) + walk(&item.children))
                .sum()
        }
        blocks
            .iter()
            .map(|block| match block {
                ChangelogBlock::List { items } => walk(items),
                _ => 0,
            })
            .sum()
    }
}
