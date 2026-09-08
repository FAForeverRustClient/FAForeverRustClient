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

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where a patch note's Markdown lives, and where its unit icons come from.
const RAW_POSTS_BASE: &str = "https://raw.githubusercontent.com/FAForever/fa/master/docs/_posts";
const PAGES_BASE: &str = "https://faforever.github.io/fa";
const ICON_BASE: &str = "https://faforever.github.io/fa/assets/icons";
const ISSUE_BASE: &str = "https://github.com/FAForever/fa/issues";

/// One release in the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogRelease {
    /// Game version, e.g. `"3837"`. Also the id the UI selects by, which is why
    /// the two rolling branches get the ids `"fafbeta"` and `"fafdevelop"`.
    pub id: String,
    /// `"Game Patch"`, `"Hotfix"`, or the branch name for a rolling entry.
    pub kind: String,
    /// ISO `YYYY-MM-DD`, or empty for the rolling branches, which have no date.
    pub date: String,
    /// Calendar year as printed on the index, for grouping. Empty for rolling.
    pub year: String,
    /// Absolute URL of the document this release's note is read from: the
    /// Markdown post for a dated release, the rendered page for a rolling one.
    pub source_url: String,
    /// The page a "view on the website" link should open.
    pub web_url: String,
}

impl ChangelogRelease {
    /// Whether this is one of the two rolling branch pages rather than a dated
    /// post.
    ///
    /// Worth a name because the answer decides three separate things: which
    /// codec reads the note, whether the note may be cached at all, and whether
    /// the release is a candidate for "open on the newest patch". A dated post
    /// is finished the day it is published; a branch page is rewritten every
    /// time something is deployed to that branch.
    pub fn is_rolling(&self) -> bool {
        self.date.is_empty()
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
    },
}

/// One unit named by a header, with the icon the site would show for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogUnit {
    pub unit_id: String,
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

    ChangelogEntry {
        id: id.to_string(),
        title,
        blocks: parse_blocks(body),
    }
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
                    unit_id: unit,
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
            let start = index;
            while index < lines.len()
                && (is_list_marker(lines[index]) || lines[index].trim().is_empty())
            {
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

fn flush_paragraph(paragraph: &mut Vec<String>, blocks: &mut Vec<ChangelogBlock>) {
    if paragraph.is_empty() {
        return;
    }
    let text = paragraph.join(" ");
    paragraph.clear();

    // Before the `{% unit %}` tag existed this bold line *was* the unit header,
    // so reading it gives the archive the same icons the newest patch has.
    if let Some((name, ids)) = unit_header(&text) {
        blocks.push(ChangelogBlock::Unit {
            units: ids
                .into_iter()
                .map(|unit_id| ChangelogUnit {
                    icon_url: unit_icon_url(&unit_id),
                    unit_id,
                })
                .collect(),
            name,
        });
        return;
    }

    blocks.push(ChangelogBlock::Paragraph {
        spans: parse_spans(&text),
    });
}

fn heading_level(trimmed: &str) -> Option<u8> {
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes).then_some(hashes as u8)
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

/// Build the item tree from indentation. The template indents nested changes by
/// two spaces per level, and the depth is what tells a category apart from the
/// values under it.
fn parse_list(lines: &[&str]) -> Vec<ChangelogListItem> {
    let mut roots: Vec<ChangelogListItem> = Vec::new();
    // Indentation of each open level, so a deeper line attaches to the right parent.
    let mut open: Vec<usize> = Vec::new();

    for line in lines {
        if !is_list_marker(line) {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let text = line.trim_start().trim_start_matches('-').trim();
        let item = build_item(text);

        while open.last().is_some_and(|last| indent <= *last) {
            open.pop();
        }

        let depth = open.len();
        open.push(indent);

        match append_at_depth(&mut roots, depth, item) {
            true => {}
            // A list that starts indented has no parent to attach to; keep the
            // content rather than dropping it.
            false => {
                open.clear();
                open.push(indent);
                roots.push(build_item(text));
            }
        }
    }

    roots
}

fn append_at_depth(
    items: &mut Vec<ChangelogListItem>,
    depth: usize,
    item: ChangelogListItem,
) -> bool {
    if depth == 0 {
        items.push(item);
        return true;
    }
    match items.last_mut() {
        Some(parent) => append_at_depth(&mut parent.children, depth - 1, item),
        None => false,
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
/// Shape: a line that is entirely bold and ends in a parenthesised list of
/// unit ids, e.g. `**Yathsou: T3 Submarine Hunter (XSS0304):**`. Every id
/// must look like one, so a bold sentence that merely ends in a bracket stays
/// a sentence.
fn unit_header(text: &str) -> Option<(String, Vec<String>)> {
    let inner = text.trim().strip_prefix("**")?.strip_suffix("**")?.trim();
    let inner = inner.strip_suffix(':').unwrap_or(inner).trim_end();
    let open = inner.rfind('(')?;
    let ids = inner[open + 1..].strip_suffix(')')?;

    let ids: Vec<String> = ids.split(',').map(|id| id.trim().to_string()).collect();
    if !ids.iter().all(|id| is_unit_id(id)) {
        return None;
    }

    let name = inner[..open]
        .trim()
        .trim_end_matches(':')
        .trim()
        .to_string();
    (!name.is_empty()).then_some((name, ids))
}

/// Blueprint ids are three letters then four digits (`XSS0304`, `UEB1303`).
///
/// The digits matter: allowing letters there made `finally` a unit id, because
/// it is also seven characters. A looser rule turns any bracketed word into a
/// unit and asks the site for an icon that does not exist.
fn is_unit_id(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    bytes.len() == 7
        && bytes[..3].iter().all(u8::is_ascii_alphabetic)
        && bytes[3..].iter().all(u8::is_ascii_digit)
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
    if !plain.is_empty() {
        spans.push(ChangelogSpan::Text(std::mem::take(plain)));
    }
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
        let Some(quote) = value.chars().next() else {
            return None;
        };
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
                    unit_id,
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
            "svg" | "img" | "button" | "use" | "path" => {}
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
                    unit_id: "URL0303".into(),
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
                    number: "7121".into(),
                    url: "https://github.com/FAForever/fa/issues/7121".into()
                },
                ChangelogSpan::Text(".".into()),
            ]
        );
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
                    unit_id: "XSS0304".into(),
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
                    unit_id: "UAB0304".into(),
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
    const POST_3837: &str = include_str!("fixtures/changelog-3837.md");
    const POST_3836: &str = include_str!("fixtures/changelog-3836.md");
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
