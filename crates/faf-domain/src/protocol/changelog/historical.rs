//! Restore illustrations using metadata extracted from original balance pages.
//! Only known heading/context matches and unchanged prose are associated. The
//! current post's text, numeric changes and links remain the source of truth.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::Deserialize;

use super::{
    ChangelogBlock, ChangelogChange, ChangelogEntry, ChangelogListItem, ChangelogSpan,
    ChangelogUnit,
};

#[derive(Deserialize)]
struct Manifest {
    revision: String,
    patches: BTreeMap<String, Patch>,
}

#[derive(Deserialize)]
struct Patch {
    source: String,
    headings: Vec<Illustration>,
}

#[derive(Deserialize)]
struct Illustration {
    name: String,
    context: Vec<String>,
    aliases: Vec<String>,
    images: Vec<String>,
    paragraphs: Vec<String>,
    issues: Vec<String>,
    /// Fingerprints of the bold captions inside the heading's card, such as
    /// the three missiles under 3718's "Nukes". A post lists them as bullets
    /// without the heading they were grouped under on the original page.
    #[serde(default)]
    members: Vec<String>,
    /// The complete ordered stat sequence, used when captions were renamed.
    #[serde(default)]
    changes: Option<String>,
    /// A plain source caption whose picture may be verified in another page.
    #[serde(default)]
    unillustrated: bool,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../data/historical_changelog.json"))
            .expect("bundled historical changelog metadata must be valid")
    })
}

fn normalize(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn fingerprint(text: &str) -> String {
    let text = normalize(text);
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}:{}", text.len())
}

fn span_text(spans: &[ChangelogSpan]) -> String {
    spans
        .iter()
        .map(|span| match span {
            ChangelogSpan::Text(text) | ChangelogSpan::Strong(text) | ChangelogSpan::Code(text) => {
                text.clone()
            }
            ChangelogSpan::Link { text, .. } => text.clone(),
            ChangelogSpan::Issue { number, label, .. } => {
                label.clone().unwrap_or_else(|| format!("#{number}"))
            }
        })
        .collect()
}

fn caption(spans: &[ChangelogSpan]) -> Option<String> {
    if spans
        .iter()
        .all(|span| matches!(span, ChangelogSpan::Text(_) | ChangelogSpan::Strong(_)))
    {
        let text = span_text(spans);
        if !text.is_empty() && text.len() <= 256 {
            return Some(text);
        }
    }
    None
}

// The bool records an illustrated heading, which may trail a section context
// while prose or another faction's heading still belongs to that same section.
type Context = Vec<(u8, String, bool)>;

struct Matcher<'a> {
    associate_prose: bool,
    associate_changes: bool,
    headings: &'a [Illustration],
    aliases: HashMap<String, Vec<usize>>,
    paragraphs: HashMap<&'a str, Vec<usize>>,
    issues: HashMap<&'a str, Vec<usize>>,
    members: HashMap<&'a str, Vec<usize>>,
    changes: HashMap<&'a str, Vec<usize>>,
    contexts: Vec<Vec<String>>,
}

impl<'a> Matcher<'a> {
    fn new(headings: &'a [Illustration]) -> Self {
        let mut matcher = Self {
            associate_prose: true,
            associate_changes: true,
            headings,
            aliases: HashMap::new(),
            paragraphs: HashMap::new(),
            issues: HashMap::new(),
            members: HashMap::new(),
            changes: HashMap::new(),
            contexts: headings
                .iter()
                .map(|heading| heading.context.iter().map(|part| normalize(part)).collect())
                .collect(),
        };
        for (index, heading) in headings.iter().enumerate() {
            for alias in &heading.aliases {
                let candidates = matcher.aliases.entry(normalize(alias)).or_default();
                if !candidates.contains(&index) {
                    candidates.push(index);
                }
            }
            for paragraph in &heading.paragraphs {
                matcher.paragraphs.entry(paragraph).or_default().push(index);
            }
            for issue in &heading.issues {
                matcher.issues.entry(issue).or_default().push(index);
            }
            for member in &heading.members {
                let candidates = matcher.members.entry(member).or_default();
                if !candidates.contains(&index) {
                    candidates.push(index);
                }
            }
            if let Some(changes) = &heading.changes {
                matcher.changes.entry(changes).or_default().push(index);
            }
        }
        matcher
    }

    /// The heading whose card lists `caption` as one of its bold captions,
    /// when exactly one does. Only a bullet's caption is looked up here, never
    /// a stat line, which can repeat across units.
    fn member(&self, caption: &str) -> Option<usize> {
        if !self.associate_prose {
            return None;
        }
        let candidates = self.members.get(fingerprint(caption).as_str())?;
        (candidates.len() == 1).then(|| candidates[0])
    }

    fn score(&self, index: usize, context: &Context) -> usize {
        let source = &self.contexts[index];
        let Some(last) = source.last() else {
            return 0;
        };
        let Some(mut bound) = context.iter().rposition(|(_, name, _)| name == last) else {
            return 0;
        };
        if context[bound + 1..].iter().any(|(_, _, unit)| !unit) {
            return 0;
        }
        let mut score = 1;
        for parent in source[..source.len() - 1].iter().rev() {
            if let Some(position) = context[..bound]
                .iter()
                .rposition(|(_, name, _)| name == parent)
            {
                score += 1;
                bound = position;
            }
        }
        score
    }

    fn heading(&self, text: &str, context: &Context) -> Option<usize> {
        let key = normalize(text);
        let candidates = self.aliases.get(&key)?;
        let generic = matches!(
            key.as_str(),
            "uef" | "aeon" | "cybran" | "seraphim" | "all" | "allfactions"
        );
        let mut best = None;
        let mut best_score = 0;
        let mut tied = false;
        for &candidate in candidates {
            let score = self.score(candidate, context);
            if score == 0 && (generic || candidates.len() > 1) {
                continue;
            }
            if best.is_none() || score > best_score {
                best = Some(candidate);
                best_score = score;
                tied = false;
            } else if score == best_score {
                tied = true;
            }
        }
        if tied {
            None
        } else {
            best
        }
    }

    fn reference(&self, spans: &[ChangelogSpan]) -> Option<usize> {
        if !self.associate_prose {
            return None;
        }
        let text = span_text(spans);
        let mut candidates = if text.len() <= 16 * 1024 {
            self.paragraphs
                .get(fingerprint(&text).as_str())
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        for span in spans {
            if let ChangelogSpan::Issue { number, .. } = span {
                if let Some(matches) = self.issues.get(number.as_str()) {
                    candidates.extend(matches);
                }
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        (candidates.len() == 1).then(|| candidates[0])
    }

    fn has_illustrated_children(&self, index: usize) -> bool {
        let name = normalize(&self.headings[index].name);
        self.contexts.iter().any(|context| context.contains(&name))
    }

    fn changed_caption(&self, items: &[ChangelogListItem]) -> Option<usize> {
        if !self.associate_changes {
            return None;
        }
        fn collect(items: &[ChangelogListItem], atoms: &mut Vec<String>, depth: u8) -> Option<()> {
            if depth >= 32 {
                return None;
            }
            for item in items {
                if let Some(change) = &item.change {
                    if change.label.len() + change.old.len() + change.new.len() > 16 * 1024 {
                        return None;
                    }
                    atoms.push(normalize(&change.label));
                    for value in [&change.old, &change.new] {
                        atoms.push(
                            value
                                .chars()
                                .filter(|c| !c.is_whitespace())
                                .flat_map(char::to_lowercase)
                                .collect(),
                        );
                    }
                    if atoms.len() > 128 * 3 {
                        return None;
                    }
                }
                collect(&item.children, atoms, depth + 1)?;
            }
            Some(())
        }
        let mut atoms = Vec::new();
        collect(items, &mut atoms, 0)?;
        if atoms.is_empty() {
            return None;
        }
        let encoded: String = atoms
            .iter()
            .map(|value| format!("{}:{value};", value.len()))
            .collect();
        if encoded.len() > 16 * 1024 {
            return None;
        }
        let candidates = self.changes.get(fingerprint(&encoded).as_str())?;
        (candidates.len() == 1).then(|| candidates[0])
    }

    fn caption(&self, name: &str, items: &[ChangelogListItem], context: &Context) -> Option<usize> {
        let faction = matches!(
            normalize(name).as_str(),
            "aeon" | "uef" | "cybran" | "seraphim" | "sera" | "all" | "allfactions"
        );
        (!faction)
            .then(|| self.changed_caption(items))
            .flatten()
            .or_else(|| self.heading(name, context))
    }

    fn existing(&self, name: &str, context: &Context) -> Option<usize> {
        self.heading(name, context).or_else(|| {
            let mut candidates = self
                .headings
                .iter()
                .enumerate()
                .filter(|(_, heading)| heading.name == name);
            let first = candidates.next()?.0;
            candidates.next().is_none().then_some(first)
        })
    }

    fn contains(&self, items: &[ChangelogListItem], context: &Context, depth: u8) -> bool {
        if depth >= 32 {
            return false;
        }
        items.iter().any(|item| {
            let name = item
                .change
                .is_none()
                .then(|| caption(&item.spans))
                .flatten();
            if name
                .as_ref()
                .is_some_and(|name| self.caption(name, &item.children, context).is_some())
                || self.reference(&item.spans).is_some()
            {
                return true;
            }
            let mut child_context = context.clone();
            if let Some(name) = name {
                push_context(
                    &mut child_context,
                    depth.saturating_add(2).min(6),
                    &name,
                    false,
                );
            }
            self.contains(&item.children, &child_context, depth.saturating_add(1))
        })
    }
}

/// `(#5737) ...` or `(#5812, #5823) ...`: a bullet opening with its references.
fn starts_with_reference(spans: &[ChangelogSpan]) -> bool {
    match spans {
        [ChangelogSpan::Issue { .. }, ..] => true,
        [ChangelogSpan::Text(open), ChangelogSpan::Issue { .. }, ..] => open.trim() == "(",
        _ => false,
    }
}

fn push_context(context: &mut Context, level: u8, name: &str, unit: bool) {
    while context
        .last()
        .is_some_and(|(previous, _, _)| *previous >= level)
    {
        context.pop();
    }
    if level > 1 {
        context.push((level, normalize(name), unit));
    }
}

fn safe_image(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    path.starts_with("images/")
        && path.is_ascii()
        && !path.contains(['\\', '?', '#', ':'])
        && !["%2e", "%2f", "%5c", "%00"]
            .iter()
            .any(|encoded| lower.contains(encoded))
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && [".png", ".jpg", ".jpeg", ".gif", ".webp"]
            .iter()
            .any(|extension| lower.ends_with(extension))
}

fn image_aliases(heading: &Illustration) -> Vec<String> {
    let mut names: Vec<String> = heading.aliases.iter().map(|name| normalize(name)).collect();
    if heading.images.len() == 1 {
        if let Some(file) = heading.images[0].rsplit('/').next() {
            if let Some((stem, _)) = file.rsplit_once('.') {
                names.push(normalize(stem));
            }
        }
    }
    names
}

fn verified_images(name: &str, local: &[Illustration]) -> Vec<String> {
    fn insert(map: &mut HashMap<String, Option<Vec<String>>>, heading: &Illustration) {
        if heading.images.is_empty() || heading.unillustrated {
            return;
        }
        for alias in image_aliases(heading) {
            map.entry(alias)
                .and_modify(|images| {
                    if images
                        .as_ref()
                        .is_some_and(|images| images != &heading.images)
                    {
                        *images = None;
                    }
                })
                .or_insert_with(|| Some(heading.images.clone()));
        }
    }
    // Prefer a picture explicitly verified in this patch. Otherwise an exact,
    // unambiguous caption or asset name from the same pinned tree may supply
    // it. Never guess blueprint IDs or resolve conflicting illustrations.
    let key = normalize(name);
    let mut candidates = local.iter().filter(|heading| {
        !heading.unillustrated
            && !heading.images.is_empty()
            && image_aliases(heading).contains(&key)
    });
    if let Some(first) = candidates.next() {
        return if candidates.all(|heading| heading.images == first.images) {
            first.images.clone()
        } else {
            Vec::new()
        };
    }
    static IMAGES: OnceLock<HashMap<String, Option<Vec<String>>>> = OnceLock::new();
    IMAGES
        .get_or_init(|| {
            let mut images = HashMap::new();
            for patch in manifest().patches.values() {
                for heading in &patch.headings {
                    insert(&mut images, heading);
                }
            }
            images
        })
        .get(&key)
        .and_then(Clone::clone)
        .unwrap_or_default()
}

struct Enricher<'a> {
    matcher: Matcher<'a>,
    revision: &'a str,
    context: Context,
    active: Option<usize>,
    blocks: Vec<ChangelogBlock>,
}

impl Enricher<'_> {
    fn unit(&mut self, index: usize, name: String) {
        let heading = &self.matcher.headings[index];
        let images = if heading.unillustrated {
            verified_images(&name, self.matcher.headings)
        } else {
            heading.images.clone()
        };
        self.blocks.push(ChangelogBlock::Unit {
            name,
            units: images
                .iter()
                .filter(|path| safe_image(path))
                .map(|path| ChangelogUnit {
                    unit_id: None,
                    icon_url: format!(
                        "https://raw.githubusercontent.com/FAForever/patchnotes/{}/{path}",
                        self.revision
                    ),
                })
                .collect(),
        });
        self.active = Some(index);
    }

    fn reference(&mut self, spans: &[ChangelogSpan]) {
        if let Some(index) = self
            .matcher
            .reference(spans)
            .filter(|index| Some(*index) != self.active)
        {
            // Newer notes title each change with a bullet naming its pull
            // request, "(#5737) The Bulwark now has ...", and describe it in
            // the paragraph below. The paragraph is what identifies the unit,
            // but the header belongs above the title: below it, every title
            // read as part of the unit before (3777, 3778, 3779, 3801).
            let title = self.take_title();
            self.unit(index, self.matcher.headings[index].name.clone());
            if let Some(title) = title {
                self.blocks
                    .push(ChangelogBlock::List { items: vec![title] });
            }
        }
    }

    /// The bullet directly above, when it titles a change by its pull request.
    /// A stat line or plain bullet there belongs to the unit before and stays.
    fn take_title(&mut self) -> Option<ChangelogListItem> {
        let Some(ChangelogBlock::List { items }) = self.blocks.last_mut() else {
            return None;
        };
        let last = items.last()?;
        if last.change.is_some() || !starts_with_reference(&last.spans) {
            return None;
        }
        let title = items.pop();
        if items.is_empty() {
            self.blocks.pop();
        }
        title
    }

    fn flush(&mut self, pending: &mut Vec<ChangelogListItem>) {
        if !pending.is_empty() {
            self.blocks.push(ChangelogBlock::List {
                items: std::mem::take(pending),
            });
        }
    }

    fn items(&mut self, items: Vec<ChangelogListItem>, depth: u8) {
        if depth >= 32 {
            if !items.is_empty() {
                self.blocks.push(ChangelogBlock::List { items });
            }
            return;
        }
        let mut pending = Vec::new();
        // The level of a sibling already promoted to a section heading. A
        // later category among the same siblings is promoted as well, or its
        // bullets render inside the last section before it (3718's "Game
        // Patch" read as part of "Vision Fix").
        let mut category_level = None;
        for item in items {
            let name = item
                .change
                .is_none()
                .then(|| caption(&item.spans))
                .flatten();
            if let Some(index) = name
                .as_ref()
                .and_then(|name| self.matcher.caption(name, &item.children, &self.context))
            {
                self.flush(&mut pending);
                self.unit(index, name.unwrap());
                if self.matcher.has_illustrated_children(index) {
                    self.items(item.children, depth.saturating_add(1));
                } else if !item.children.is_empty() {
                    self.blocks.push(ChangelogBlock::List {
                        items: item.children,
                    });
                }
                continue;
            }
            let mut child_context = self.context.clone();
            if let Some(name) = &name {
                push_context(
                    &mut child_context,
                    depth.saturating_add(2).min(6),
                    name,
                    false,
                );
            }
            let nested =
                self.matcher
                    .contains(&item.children, &child_context, depth.saturating_add(1));
            let reference = self
                .matcher
                .reference(&item.spans)
                .or_else(|| name.as_deref().and_then(|name| self.matcher.member(name)))
                .filter(|index| Some(*index) != self.active);
            if !nested && reference.is_none() {
                if let (Some(level), Some(name)) = (category_level, &name) {
                    if !item.children.is_empty() {
                        self.flush(&mut pending);
                        push_context(&mut self.context, level, name, false);
                        self.blocks.push(ChangelogBlock::Heading {
                            level,
                            text: name.clone(),
                        });
                        self.active = None;
                        self.items(item.children, depth.saturating_add(1));
                        continue;
                    }
                }
                pending.push(item);
                continue;
            }
            self.flush(&mut pending);
            if let Some(index) = reference {
                self.unit(index, self.matcher.headings[index].name.clone());
            }
            if nested {
                if let Some(name) = name {
                    // Preserve the list hierarchy: a tier and its unit groups
                    // are different levels (3714's Tech 3 Land / Tanks/Bots).
                    let level = depth.saturating_add(2).min(6);
                    push_context(&mut self.context, level, &name, false);
                    self.blocks
                        .push(ChangelogBlock::Heading { level, text: name });
                    self.active = None;
                    category_level = Some(level);
                } else {
                    self.blocks.push(ChangelogBlock::List {
                        items: vec![ChangelogListItem {
                            spans: item.spans,
                            change: item.change,
                            children: Vec::new(),
                        }],
                    });
                }
                self.items(item.children, depth.saturating_add(1));
            } else {
                pending.push(item);
            }
        }
        self.flush(&mut pending);
    }
}

pub(super) fn enrich(entry: &mut ChangelogEntry) {
    enrich_with_associations(entry, true);
}

fn enrich_with_associations(entry: &mut ChangelogEntry, associate_prose: bool) {
    let source = manifest();
    let Some(patch) = source.patches.get(&entry.id) else {
        return;
    };
    if patch.source != format!("balance/{}.html", entry.id)
        || source.revision.len() != 40
        || !source.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return;
    }
    let mut enricher = Enricher {
        matcher: Matcher::new(&patch.headings),
        revision: &source.revision,
        context: Vec::new(),
        active: None,
        blocks: Vec::new(),
    };
    enricher.matcher.associate_prose = associate_prose;
    enricher.matcher.associate_changes = associate_prose;
    for block in std::mem::take(&mut entry.blocks) {
        match block {
            ChangelogBlock::Heading { level, text } => {
                while enricher
                    .context
                    .last()
                    .is_some_and(|(previous, _, _)| *previous >= level)
                {
                    enricher.context.pop();
                }
                let matched = enricher.matcher.heading(&text, &enricher.context);
                push_context(&mut enricher.context, level, &text, matched.is_some());
                if let Some(index) = matched {
                    enricher.unit(index, text);
                } else {
                    enricher
                        .blocks
                        .push(ChangelogBlock::Heading { level, text });
                    enricher.active = None;
                }
            }
            ChangelogBlock::Paragraph { spans } => {
                if let Some(index) = caption(&spans)
                    .and_then(|name| enricher.matcher.heading(&name, &enricher.context))
                {
                    enricher.unit(index, span_text(&spans));
                } else {
                    enricher.reference(&spans);
                    enricher.blocks.push(ChangelogBlock::Paragraph { spans });
                }
            }
            ChangelogBlock::List { items } => {
                // A rendered unit's list already belongs to that unit. Its
                // internal labels must not become new upgrade headings on a
                // later enrichment pass just because some stats coincide.
                if matches!(enricher.blocks.last(), Some(ChangelogBlock::Unit { .. }))
                    && !enricher
                        .active
                        .is_some_and(|index| enricher.matcher.has_illustrated_children(index))
                {
                    enricher.blocks.push(ChangelogBlock::List { items });
                } else {
                    enricher.items(items, 0);
                }
            }
            ChangelogBlock::Unit { name, units } => {
                enricher.active = enricher.matcher.existing(&name, &enricher.context);
                enricher.blocks.push(ChangelogBlock::Unit { name, units });
            }
            block @ (ChangelogBlock::HistoricalBalance { .. }
            | ChangelogBlock::CodeBlock { .. }
            | ChangelogBlock::Provenance { .. }) => enricher.blocks.push(block),
        }
    }
    entry.blocks = enricher.blocks;
}

fn supplement_patch(entry: &ChangelogEntry) -> Option<&'static Patch> {
    if entry.blocks.iter().any(|block| {
        matches!(
            block,
            ChangelogBlock::Unit { .. } | ChangelogBlock::HistoricalBalance { .. }
        )
    }) {
        return None;
    }
    let source = manifest();
    let patch = source.patches.get(&entry.id)?;
    (patch.source == format!("balance/{}.html", entry.id)
        && source.revision.len() == 40
        && source.revision.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(patch)
}

/// Pinned original source, only for posts whose balance detail cannot be matched.
pub fn historical_balance_source(entry: &ChangelogEntry) -> Option<String> {
    let patch = supplement_patch(entry)?;
    Some(format!(
        "https://raw.githubusercontent.com/FAForever/patchnotes/{}/{}",
        manifest().revision,
        patch.source
    ))
}

/// Keep an optional original document separate from the current published post.
/// Missing or invalid documents leave a retryable section, not a failed note.
pub fn parse_historical_balance(
    entry: &ChangelogEntry,
    html: Option<&str>,
) -> Option<ChangelogBlock> {
    let patch = supplement_patch(entry)?;
    let mut blocks = Vec::new();
    if let Some(html) = html.filter(|html| html.len() <= 4 * 1024 * 1024) {
        let html = super::strip_comments(html);
        if let Some(content) = content_element(&html, 0) {
            let parsed = original_blocks(content, 0);
            let title = parsed.iter().find_map(|block| match block {
                ChangelogBlock::Heading { level: 1, text } => Some(text),
                _ => None,
            });
            if title.is_some_and(|title| normalize(title) == format!("patch{}", entry.id)) {
                let mut original = ChangelogEntry {
                    id: entry.id.clone(),
                    title: entry.title.clone(),
                    blocks: parsed
                        .into_iter()
                        .filter(|block| !matches!(block, ChangelogBlock::Heading { level: 1, .. }))
                        .collect(),
                };
                enrich_with_associations(&mut original, false);
                blocks = original.blocks;
            }
        }
    }
    Some(ChangelogBlock::HistoricalBalance {
        patch_id: entry.id.clone(),
        source_url: format!(
            "https://github.com/FAForever/patchnotes/blob/{}/{}",
            manifest().revision,
            patch.source
        ),
        unavailable: blocks.is_empty(),
        blocks,
    })
}

fn content_element(html: &str, depth: u8) -> Option<&str> {
    if depth >= 32 {
        return None;
    }
    let mut rest = html;
    while let Some(element) = super::next_element(rest) {
        if element.has_class("content") {
            return Some(element.inner);
        }
        if matches!(
            element.name.as_str(),
            "html" | "body" | "main" | "div" | "section"
        ) {
            if let Some(content) = content_element(element.inner, depth + 1) {
                return Some(content);
            }
        }
        rest = element.after;
    }
    None
}

fn original_blocks(html: &str, depth: u8) -> Vec<ChangelogBlock> {
    if depth >= 32 {
        return Vec::new();
    }
    let mut blocks = Vec::new();
    let mut rest = html;
    loop {
        let Some(element) = super::next_element(rest) else {
            original_prose(rest, &mut blocks);
            break;
        };
        original_prose(element.before, &mut blocks);
        match element.name.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "ul" | "ol" | "pre" => {
                let length = rest.len() - element.after.len();
                blocks.extend(super::parse_html_blocks(&rest[..length]));
            }
            "b" | "strong" | "u" | "em" | "i" | "span" | "a" | "code" => {
                let length = rest.len() - element.after.len();
                let spans = super::parse_html_spans(&rest[element.before.len()..length]);
                if !spans.is_empty() {
                    blocks.push(ChangelogBlock::Paragraph { spans });
                }
            }
            "div" | "section" | "article" | "main" => {
                blocks.extend(original_blocks(element.inner, depth + 1));
            }
            _ => {}
        }
        rest = element.after;
    }
    blocks
}

fn original_prose(html: &str, blocks: &mut Vec<ChangelogBlock>) {
    let spans = super::parse_html_spans(html);
    if !spans.is_empty() {
        blocks.push(ChangelogBlock::Paragraph { spans });
    }
}

/// The original site wrote values with strike tags and a decorative arrow.
pub(super) fn strike_change(html: &str) -> Option<ChangelogChange> {
    let mut rest = html;
    while let Some(element) = super::next_element(rest) {
        if matches!(element.name.as_str(), "s" | "del") {
            // A row with multiple independent changes needs to remain prose.
            if element.after.contains("<s>") || element.after.contains("<del") {
                return None;
            }
            let prefix_length = html.len() - rest.len() + element.before.len();
            let label = super::html_text(&html[..prefix_length]);
            let label = label.trim().trim_end_matches(':').trim();
            let old = super::html_text(element.inner);
            let new = super::html_text(element.after);
            let mut new = new.trim();
            for arrow in ["-->", "->", "→", ">"] {
                if let Some(after) = new.strip_prefix(arrow) {
                    new = after.trim();
                    break;
                }
            }
            return (!label.is_empty() && !old.is_empty() && !new.is_empty()).then(|| {
                ChangelogChange {
                    label: label.into(),
                    old,
                    new: new.into(),
                }
            });
        }
        rest = element.after;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_3714_keeps_tiers_and_unit_groups_at_distinct_heading_levels() {
        let entry =
            super::super::parse_entry("3714", include_str!("../fixtures/changelog-3714.md"));
        let headings: Vec<_> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::Heading { level, text } => Some((*level, text.as_str())),
                _ => None,
            })
            .collect();
        for (level, name) in [
            (2, "Land"),
            (3, "Tech 1 Land"),
            (3, "Tech 2 Land"),
            (3, "Tech 3 Land"),
            (4, "Tanks/Bots"),
            (4, "Snipers"),
            (4, "Mobile Artillery"),
            (4, "Tech 3 Engineer"),
            (3, "Experimentals"),
            (2, "Air"),
        ] {
            assert!(headings.contains(&(level, name)), "{name}: {headings:?}");
        }
        let tanks = entry.blocks.iter().position(|block| matches!(block, ChangelogBlock::Heading { text, .. } if text == "Tanks/Bots")).unwrap();
        let snipers = entry
            .blocks
            .iter()
            .position(
                |block| matches!(block, ChangelogBlock::Heading { text, .. } if text == "Snipers"),
            )
            .unwrap();
        let names: Vec<_> = entry.blocks[tanks + 1..snipers]
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::Unit { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            names,
            [
                "Harbinger",
                "Titan",
                "Loyalist",
                "Percival",
                "Brick",
                "Othuum"
            ]
        );
    }

    #[test]
    fn original_balance_supplements_restore_all_four_summary_posts() {
        for (id, html, expected_unit, expected_changes) in [
            (
                "3761",
                include_str!("../fixtures/changelog-balance-3761.html"),
                "Riptide",
                250,
            ),
            (
                "3774",
                include_str!("../fixtures/changelog-balance-3774.html"),
                "Ythotha",
                8,
            ),
            (
                "3775",
                include_str!("../fixtures/changelog-balance-3775.html"),
                "Janus",
                152,
            ),
            (
                "3776",
                include_str!("../fixtures/changelog-balance-3776.html"),
                "T2 Radar",
                45,
            ),
        ] {
            let mut entry = super::super::parse_entry(
                id,
                "## Balance\n\nSee the original balance notes for details.",
            );
            let before = entry.blocks.clone();
            assert!(historical_balance_source(&entry)
                .unwrap()
                .contains(&manifest().revision));
            let supplement = parse_historical_balance(&entry, Some(html)).unwrap();
            let ChangelogBlock::HistoricalBalance {
                blocks,
                unavailable,
                source_url,
                ..
            } = &supplement
            else {
                panic!("missing original section");
            };
            assert!(!unavailable, "{id}");
            assert!(source_url.ends_with(&format!("balance/{id}.html")));
            assert!(
                blocks
                    .iter()
                    .any(|block| matches!(block, ChangelogBlock::Unit { name, units }
                if name.trim() == expected_unit && !units.is_empty())),
                "{id}: {expected_unit}"
            );
            let (text, values, _) = atoms(blocks);
            assert!(!text
                .iter()
                .any(|text| text.contains("iconSidebar") || text.contains("Back to Top")));
            assert_eq!(
                values.len(),
                expected_changes,
                "all original numeric changes are retained for {id}"
            );
            if id == "3761" {
                assert!(
                    values
                        .iter()
                        .any(|value| value == "Rate of Fire (RoF)\t0.5\t0.25"),
                    "cruiser stats survive sibling sublists in malformed historical HTML"
                );
            }
            if id == "3775" {
                assert_eq!(
                    text.iter().filter(|text| text.as_str() == "HQs").count(),
                    3,
                    "unwrapped factory category labels stay visible"
                );
                assert!(
                    text.iter().any(|text| text.contains("This is a Hotkey")),
                    "standalone italic instructions stay visible"
                );
            }
            entry.blocks.push(supplement);
            assert_eq!(&entry.blocks[..before.len()], before);
            assert!(
                historical_balance_source(&entry).is_none(),
                "never append a second copy"
            );
        }
    }

    #[test]
    fn original_balance_failure_keeps_a_retryable_section_and_rejects_wrong_versions() {
        let entry = super::super::parse_entry("3776", "## Balance\n\nA short summary.");
        for source in [
            None,
            Some("<div class=\"content\"><h1>Patch 3775</h1><p>Wrong version</p></div>"),
            Some("<h1>Patch 3776</h1><p>No content wrapper</p>"),
        ] {
            assert!(matches!(parse_historical_balance(&entry, source), Some(
                ChangelogBlock::HistoricalBalance { unavailable: true, blocks, .. }) if blocks.is_empty()));
        }
        assert!(historical_balance_source(&super::super::parse_entry(
            "3689",
            "Unclear source identity"
        ))
        .is_none());
        let illustrated =
            super::super::parse_entry("3750", include_str!("../fixtures/changelog-3750.md"));
        assert!(historical_balance_source(&illustrated).is_none());
    }

    #[test]
    fn original_strike_values_keep_negative_signs_and_leave_ambiguous_rows_as_prose() {
        let change =
            strike_change("<b>Regen:</b> <s>-1</s> <i class=\"fa-arrow-right\"></i> -2").unwrap();
        assert_eq!(
            (
                change.label.as_str(),
                change.old.as_str(),
                change.new.as_str()
            ),
            ("Regen", "-1", "-2")
        );
        assert_eq!(
            strike_change("Speed: <del>2</del> -&gt; 3").unwrap().new,
            "3"
        );
        assert!(strike_change("Values: <s>1</s> 2 and <s>3</s> 4").is_none());
    }

    fn raw(id: &str, markdown: &str) -> ChangelogEntry {
        ChangelogEntry {
            id: id.into(),
            title: id.into(),
            blocks: super::super::parse_blocks(super::super::split_front_matter(markdown).1),
        }
    }

    fn atoms(blocks: &[ChangelogBlock]) -> (Vec<String>, Vec<String>, Vec<String>) {
        fn spans(spans: &[ChangelogSpan], links: &mut Vec<String>) -> String {
            for span in spans {
                if let ChangelogSpan::Issue { url, .. } | ChangelogSpan::Link { url, .. } = span {
                    links.push(url.clone());
                }
            }
            span_text(spans)
        }
        fn items(
            items: &[ChangelogListItem],
            text: &mut Vec<String>,
            values: &mut Vec<String>,
            links: &mut Vec<String>,
        ) {
            for item in items {
                text.push(spans(&item.spans, links));
                if let Some(change) = &item.change {
                    values.push(format!("{}\t{}\t{}", change.label, change.old, change.new));
                }
                items_walk(&item.children, text, values, links);
            }
        }
        fn items_walk(
            children: &[ChangelogListItem],
            text: &mut Vec<String>,
            values: &mut Vec<String>,
            links: &mut Vec<String>,
        ) {
            items(children, text, values, links);
        }
        let (mut text, mut values, mut links) = (Vec::new(), Vec::new(), Vec::new());
        for block in blocks {
            match block {
                ChangelogBlock::Heading { text: name, .. } | ChangelogBlock::Unit { name, .. } => {
                    text.push(name.clone())
                }
                ChangelogBlock::Paragraph { spans: content } => {
                    text.push(spans(content, &mut links))
                }
                ChangelogBlock::List { items: content } => {
                    items(content, &mut text, &mut values, &mut links)
                }
                ChangelogBlock::HistoricalBalance { .. } | ChangelogBlock::Provenance { .. } => {}
                ChangelogBlock::CodeBlock { text: code } => text.push(code.clone()),
            }
        }
        (text, values, links)
    }

    fn preserved(before: &[ChangelogBlock], after: &[ChangelogBlock]) {
        let (text, values, links) = atoms(before);
        let (enriched_text, enriched_values, enriched_links) = atoms(after);
        let mut next = enriched_text.iter();
        for original in &text {
            assert!(
                next.any(|candidate| candidate == original),
                "published text disappeared or moved: {original}"
            );
        }
        assert_eq!(values, enriched_values, "stat values must not change");
        assert_eq!(
            links, enriched_links,
            "issue and external links must not change"
        );
    }

    fn check(id: &str, markdown: &str, required: &[&str]) -> ChangelogEntry {
        let mut entry = raw(id, markdown);
        let before = entry.blocks.clone();
        enrich(&mut entry);
        preserved(&before, &entry.blocks);
        for required in required {
            assert!(
                entry
                    .blocks
                    .iter()
                    .any(|block| matches!(block, ChangelogBlock::Unit { name, .. }
                if name == required)),
                "missing illustrated heading {required}"
            );
        }
        let once = entry.clone();
        enrich(&mut entry);
        assert!(
            entry == once,
            "enrichment must be idempotent; first different block: {:?}",
            entry
                .blocks
                .iter()
                .zip(&once.blocks)
                .enumerate()
                .find(|(_, (after, before))| after != before)
        );
        entry
    }

    #[test]
    fn historical_3750_restores_illustrations_and_preserves_the_published_content() {
        let entry = check(
            "3750",
            include_str!("../fixtures/changelog-3750.md"),
            &["Titan", "Loyalist"],
        );
        let titan = entry
            .blocks
            .iter()
            .find_map(|block| match block {
                ChangelogBlock::Unit { name, units } if name == "Titan" => Some(units),
                _ => None,
            })
            .unwrap();
        assert_eq!(titan[0].unit_id, None);
        assert!(titan[0].icon_url.ends_with("/images/titan.png"));
    }

    #[test]
    fn historical_3696_restores_experimentals_and_renamed_acu_upgrades() {
        let experimentals = [
            "Monkeylord",
            "Megalith",
            "Soul Ripper",
            "Scathis",
            "Fatboy",
            "Atlantis",
            "Novax Center",
            "Galactic Colossus",
            "Czar",
            "Tempest",
            "Ythotha",
            "Ahwassa",
        ];
        let entry = check(
            "3696",
            include_str!("../fixtures/changelog-3696.md"),
            &experimentals,
        );
        let at = |name: &str| {
            entry
                .blocks
                .iter()
                .position(|block| {
                    matches!(block,
            ChangelogBlock::Heading { text, .. } if text == name)
                })
                .unwrap()
        };
        let units = |blocks: &[ChangelogBlock]| {
            blocks
                .iter()
                .filter_map(|block| match block {
                    ChangelogBlock::Unit { name, units } => {
                        Some((name.clone(), units[0].icon_url.clone()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let experimental_blocks = &entry.blocks[at("Experimental Units") + 1..at("Navy")];
        let restored = units(experimental_blocks);
        assert_eq!(
            restored
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            experimentals
        );
        for ((_, image), file) in restored.iter().zip([
            "monkeylord",
            "megalith",
            "soulripper",
            "scathis",
            "fatboy",
            "atlantis",
            "novaxcenter",
            "galacticcolossus",
            "czar",
            "tempest",
            "ythotha",
            "ahwassa",
        ]) {
            assert!(
                image.ends_with(&format!("/images/{file}.png")),
                "wrong experimental image: {image}"
            );
        }
        assert_eq!(
            experimental_blocks
                .iter()
                .filter_map(|block| match block {
                    ChangelogBlock::Heading { level, text } => Some((*level, text.as_str())),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            [(3, "Cybran"), (3, "UEF"), (3, "Aeon"), (3, "Seraphim")]
        );
        assert!(matches!(
            entry.blocks[at("T3 Land Combat")],
            ChangelogBlock::Heading { level: 2, .. }
        ));
        let upgrades = units(&entry.blocks[..at("T3 Land Combat")]);
        assert_eq!(upgrades.len(), 8);
        for ((name, image), (caption, file)) in upgrades.iter().zip([
            ("Personal Shield Generator", "aeon/shield"),
            ("Heavy Personal Shield Generator", "aeon/heavyshield"),
            ("Nano-Repair System", "uef/nano"),
            ("Personal Shield Generator", "uef/personalsheild"),
            ("Shield Generator Field", "uef/bubbleshield"),
            ("Refracting Chronotron Amplifier", "sera/aoe"),
            ("Nano-Repair System", "sera/nano"),
            ("Enhanced Nano-Repair System", "sera/nano"),
        ]) {
            assert_eq!(name, caption);
            assert!(
                image.ends_with(&format!("/images/Enhancements/{file}.png")),
                "wrong upgrade image: {image}"
            );
        }
    }

    #[test]
    fn historical_stat_associations_reject_ambiguous_or_different_changes() {
        let item = ChangelogListItem {
            spans: Vec::new(),
            children: Vec::new(),
            change: Some(ChangelogChange {
                label: "BuildTime".into(),
                old: "100".into(),
                new: "200".into(),
            }),
        };
        let signature = fingerprint("9:buildtime;3:100;3:200;");
        let mut headings: Vec<Illustration> = serde_json::from_value(serde_json::json!([
            {"name":"First", "context":[], "aliases":["First"], "images":[], "paragraphs":[], "issues":[], "changes":signature},
            {"name":"Second", "context":[], "aliases":["Second"], "images":[], "paragraphs":[], "issues":[], "changes":signature}
        ])).unwrap();
        assert_eq!(
            Matcher::new(&headings).changed_caption(std::slice::from_ref(&item)),
            None
        );
        headings.pop();
        assert_eq!(
            Matcher::new(&headings).caption("Seraphim", std::slice::from_ref(&item), &Vec::new()),
            None
        );
        assert_eq!(
            Matcher::new(&headings).changed_caption(std::slice::from_ref(&item)),
            Some(0)
        );
        let different = ChangelogListItem {
            change: Some(ChangelogChange {
                new: "201".into(),
                ..item.change.unwrap()
            }),
            ..item
        };
        assert_eq!(Matcher::new(&headings).changed_caption(&[different]), None);
    }

    #[test]
    fn historical_existing_unit_lists_stay_with_their_parent_when_reenriched() {
        let parsed = raw("3704", "- Tempest\n  - Mass cost: 24000 → 22000\n");
        let mut entry = ChangelogEntry {
            blocks: vec![ChangelogBlock::Unit {
                name: "Battleships".into(),
                units: Vec::new(),
            }],
            ..parsed.clone()
        };
        entry.blocks.extend(parsed.blocks);
        let before = entry.clone();
        enrich(&mut entry);
        assert_eq!(
            entry, before,
            "a unit inside a rendered family must not escape its parent's stat list"
        );
    }

    #[test]
    fn historical_3718_keeps_overcharge_and_the_original_values() {
        let entry = check(
            "3718",
            include_str!("../fixtures/changelog-3718.md"),
            &["Aurora", "Mantis", "Hunter", "Mech Marine", "Nukes"],
        );
        assert!(atoms(&entry.blocks)
            .0
            .iter()
            .any(|text| text.contains("Overcharge will drain a maximum of 90%")));
        let at = |wanted: &str| {
            entry
                .blocks
                .iter()
                .position(|block| match block {
                    ChangelogBlock::Unit { name, .. }
                    | ChangelogBlock::Heading { text: name, .. } => name == wanted,
                    _ => false,
                })
                .unwrap_or_else(|| panic!("missing {wanted}"))
        };
        // The Mech Marine's unmarked stat lines are its changes, so the list
        // carries on and "Tech 2 Land" stays a part of "Land".
        let ChangelogBlock::List { items } = &entry.blocks[at("Mech Marine") + 1] else {
            panic!("the Mech Marine's stats are not a list");
        };
        assert_eq!(items.len(), 7);
        assert!(items.iter().all(|item| item.change.is_some()));
        assert!(matches!(
            &entry.blocks[at("Tech 2 Land")],
            ChangelogBlock::Heading { level: 3, .. }
        ));
        // The original page groups the three missiles under "Nukes", not
        // under "Target Priorities" before them.
        let ChangelogBlock::List { items } = &entry.blocks[at("Nukes") + 1] else {
            panic!("no missiles under Nukes");
        };
        assert_eq!(span_text(&items[0].spans), "Experimental Nuclear Missile");
        assert_eq!(items.len(), 3);
        // "Game Patch" is a section beside "Miscellaneous", not part of the
        // last unit in it.
        assert!(at("Game Patch") > at("Vision Fix"));
        assert!(matches!(
            &entry.blocks[at("Game Patch")],
            ChangelogBlock::Heading { level: 2, .. }
        ));
        let images: Vec<&str> = entry
            .blocks
            .iter()
            .filter_map(|block| match block {
                ChangelogBlock::Unit { name, units } if name == "Mantis" || name == "Hunter" => {
                    Some(units[0].icon_url.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(images.len(), 2);
        assert_ne!(
            images[0], images[1],
            "source unit-code errors must not conflate images"
        );
    }

    #[test]
    fn historical_3777_associates_unchanged_prose_without_inventing_changes() {
        let entry = check(
            "3777",
            include_str!("../fixtures/changelog-3777.md"),
            &["Bulwark", "Scathis", "Deceiver"],
        );
        assert!(
            !atoms(&entry.blocks)
                .0
                .iter()
                .any(|text| text.contains("MaxSpeedReverse")),
            "unrelated details from the separate balance source must not be inserted"
        );
        // Each header stands above the bullet that titles its change, not
        // between that bullet and its description: there, every title read
        // as part of the unit before it.
        for (unit, issue) in [
            ("Bulwark", "5737"),
            ("Scathis", "5739"),
            ("Deceiver", "5715"),
        ] {
            let at = entry
                .blocks
                .iter()
                .position(
                    |block| matches!(block, ChangelogBlock::Unit { name, .. } if name == unit),
                )
                .unwrap();
            let ChangelogBlock::List { items } = &entry.blocks[at + 1] else {
                panic!("{unit}: its title does not follow its header");
            };
            assert!(
                matches!(items[0].spans.first(), Some(ChangelogSpan::Issue { number, .. }) if number == issue),
                "{unit}"
            );
            assert!(matches!(
                entry.blocks[at + 2],
                ChangelogBlock::Paragraph { .. }
            ));
        }
    }

    #[test]
    fn historical_ambiguous_faction_captions_require_the_right_section() {
        let headings: Vec<Illustration> = serde_json::from_str(r#"[
            {"name":"UEF","context":["Navy","Destroyers"],"aliases":["UEF"],"images":["images/destroyer.png"],"paragraphs":[],"issues":[]},
            {"name":"UEF","context":["Navy","Cruisers"],"aliases":["UEF"],"images":["images/cruiser.png"],"paragraphs":[],"issues":[]}
        ]"#).unwrap();
        let matcher = Matcher::new(&headings);
        assert_eq!(
            matcher.heading(
                "UEF",
                &vec![(2, "navy".into(), false), (3, "destroyers".into(), false)]
            ),
            Some(0)
        );
        assert_eq!(
            matcher.heading(
                "UEF",
                &vec![(2, "navy".into(), false), (3, "cruisers".into(), false)]
            ),
            Some(1)
        );
        assert_eq!(
            matcher.heading(
                "UEF",
                &vec![(2, "navy".into(), false), (3, "battleships".into(), false)]
            ),
            None
        );
    }

    #[test]
    fn historical_mentions_and_unsafe_asset_paths_remain_unmatched() {
        let mut entry = raw(
            "3750",
            "A new sentence mentioning Titan is not an original unit heading.\n",
        );
        let before = entry.clone();
        enrich(&mut entry);
        assert_eq!(entry, before);
        for path in [
            "images/../secret.png",
            "images/%2e%2e/secret.png",
            "https://other.example/a.png",
            "images/a.png?token=x",
        ] {
            assert!(!safe_image(path), "accepted {path}");
        }
        assert!(safe_image("images/titan.png"));
        assert!(manifest()
            .patches
            .values()
            .flat_map(|patch| &patch.headings)
            .flat_map(|heading| &heading.images)
            .all(|path| safe_image(path)));
    }

    #[test]
    fn historical_extreme_list_depth_is_left_as_written() {
        let mut item = ChangelogListItem {
            spans: vec![ChangelogSpan::Text("Titan".into())],
            change: None,
            children: Vec::new(),
        };
        for _ in 0..80 {
            item = ChangelogListItem {
                spans: vec![ChangelogSpan::Text("Nested category".into())],
                change: None,
                children: vec![item],
            };
        }
        let mut entry = ChangelogEntry {
            id: "3750".into(),
            title: "3750".into(),
            blocks: vec![ChangelogBlock::List { items: vec![item] }],
        };
        let before = entry.clone();
        enrich(&mut entry);
        assert_eq!(entry, before);
    }
}
