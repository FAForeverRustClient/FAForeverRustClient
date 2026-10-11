//! The game log excerpt a moderation report can carry.
//!
//! FAF's moderation API takes no attachments. A `moderationReport` holds a
//! description, an incident time code, a game and the reported players
//! (faf-java-api's `ModerationReport` entity); the `moderation_report` table
//! behind it has no file column (faf-db `V52__moderation_report.sql`); and the
//! only uploads the API accepts are maps, mods and game executables. The Java
//! client's own report form asks players to link a screenshot hosted elsewhere
//! for the same reason. A log therefore reaches a moderator as text in the
//! description or not at all.
//!
//! The description is a MySQL `TEXT` column of 65,535 bytes, and the API puts
//! no length check of its own in front of it, so there is room for a useful
//! excerpt beside the reporter's own words. This module builds that excerpt:
//! the end of one game log plus its error, desync and disconnect lines, with
//! this machine taken out of them, in a block a moderator can tell apart from
//! what the reporter wrote. The dialog shows the block before it is sent and
//! the submission appends exactly that block, so nothing reaches the
//! moderators that the user was not shown.
//!
//! Pure on purpose: the adapter that reads the file calls [`build_excerpt`],
//! and every rule about what is kept and what is removed is tested here
//! without a file in sight.

use std::collections::HashMap;

use crate::state::ReportLogExcerpt;

/// The reporter's own words. The dialog has always stopped here; the column
/// would hold more, but a report is read by a person, and this keeps the
/// report the user wrote the same size it always was.
pub const MAX_REPORT_TEXT_CHARS: usize = 4_000;

/// The whole attached block, its header and footer included. About a hundred
/// lines of engine trace: the end of the game and the errors before it, which
/// is what a moderator checks a report against, while still small enough to
/// read beside the report rather than instead of it.
pub const MAX_LOG_BLOCK_CHARS: usize = 8_000;

/// `report_description` is a MySQL `TEXT` column, which holds 65,535 bytes.
pub const MAX_DESCRIPTION_BYTES: usize = 65_535;

/// What separates the reporter's words from the block.
const SEPARATOR: &str = "\n\n";

// Both limits are in characters and a character is at most four bytes, so a
// report at both limits still fits the column whatever language it is in.
// Checked when the crate compiles, so raising either limit past the column
// cannot go unnoticed.
const _: () = assert!(
    MAX_REPORT_TEXT_CHARS * 4 + SEPARATOR.len() + MAX_LOG_BLOCK_CHARS * 4 <= MAX_DESCRIPTION_BYTES
);

/// The first words of the block's first line. [`split_description`] finds a
/// block by them, so the history can fold an attached log away.
pub const BLOCK_START: &str = "===== GAME LOG EXCERPT";
const BLOCK_HEADER: &str = "===== GAME LOG EXCERPT (attached by the reporter's client) =====";
const BLOCK_END: &str = "===== END OF GAME LOG EXCERPT =====";

/// One line of the excerpt. Engine lines are short; a longer one is a dumped
/// table or a list of paths, and cutting it keeps one line from taking the
/// whole budget.
const MAX_LINE_CHARS: usize = 240;
/// How much of an over-long line is looked at before it is cut. Sanitising
/// has to see a little more than is kept, since a path shrinks to `<path>`.
const MAX_RAW_LINE_CHARS: usize = 2_000;
/// The log's last lines: the end of the game, which is where a disconnect, a
/// desync or the result is.
const TAIL_LINES: usize = 40;
/// Indented lines kept after an error line: the start of a Lua stack trace,
/// which says where the error came from.
const CONTINUATION_LINES: usize = 4;
/// How many distinct error lines are remembered. A log that repeats one
/// warning a million times collapses to one entry; a log with a million
/// different ones would otherwise hold them all in memory to keep forty.
const MAX_DISTINCT_NOTABLE: usize = 2_000;
/// A personal name shorter than this is not looked for outside a path. A
/// two-letter account name matched as a word would take "PC" or "AI" out of
/// every line, and inside a path it is gone anyway.
const MIN_NAME_CHARS: usize = 3;

/// Words that make a line worth keeping from before the tail, matched without
/// regard to case: errors and Lua stack traces, desyncs, and the ways a player
/// leaves a game early.
const NOTABLE: [&str; 15] = [
    "desync",
    "error",
    "exception",
    "stack traceback",
    "crash",
    "fatal",
    "assert",
    "disconnect",
    "connection lost",
    "lost connection",
    "timed out",
    "timeout",
    "eject",
    "kicked",
    "abort",
];

/// The log a report's excerpt is built from.
pub struct ReportLogSource<'a> {
    /// The file's name, never its path.
    pub file_name: &'a str,
    /// The game the log belongs to, read from its file name.
    pub log_game_id: Option<i32>,
    /// The log's text, decoded leniently.
    pub content: &'a str,
}

/// The excerpt for a report about `requested_game_id`, taken from `source`.
///
/// `private_names` are the names this machine is known by (its user's
/// account and profile folder, the computer's name); they are replaced
/// wherever they appear as a word. Folder paths, IP addresses and e-mail
/// addresses are replaced whatever they contain.
pub fn build_excerpt(
    requested_game_id: Option<i32>,
    source: &ReportLogSource<'_>,
    private_names: &[String],
) -> ReportLogExcerpt {
    let names = usable_names(private_names);
    let lines: Vec<&str> = source.content.lines().collect();
    let total_lines = lines.len();

    // The tail first, so the error lines are only looked for before it: a
    // line in the tail is shown there and need not be shown twice.
    let mut tail_indices: Vec<usize> = lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, line)| !line.trim().is_empty())
        .take(TAIL_LINES)
        .map(|(index, _)| index)
        .collect();
    tail_indices.reverse();
    let tail_start = tail_indices.first().copied().unwrap_or(total_lines);

    let (raw_entries, more_distinct) = notable_entries(&lines[..tail_start]);
    let entries = sanitise_entries(raw_entries, &names);
    let tail: Vec<Sanitised> = tail_indices
        .iter()
        .map(|&index| sanitise_for_excerpt(lines[index], &names))
        .collect();

    let source_line = source_line(requested_game_id, source.log_game_id);
    // The frame's numbers are not known until the body is chosen, so the body
    // is chosen against the longest frame those numbers could make.
    let frame_bound = frame(&source_line, u32::MAX, u32::MAX, true, u32::MAX, u32::MAX)
        .iter()
        .map(|line| line.chars().count() + 1)
        .sum::<usize>();
    let budget = MAX_LOG_BLOCK_CHARS.saturating_sub(frame_bound);
    let (kept_entries, kept_tail) = fit(&entries, &tail, budget);

    let mut redactions = 0;
    let mut kept_lines = 0;
    let mut body_notable = Vec::new();
    for entry in kept_entries.iter().map(|&index| &entries[index]) {
        for (position, line) in entry.lines.iter().enumerate() {
            if position == 0 && entry.count > 1 {
                body_notable.push(format!("(x{}) {}", entry.count, line.text));
            } else {
                body_notable.push(line.text.clone());
            }
            redactions += line.redactions;
            kept_lines += 1;
        }
    }
    let mut body_tail = Vec::with_capacity(kept_tail);
    for line in &tail[tail.len() - kept_tail..] {
        body_tail.push(line.text.clone());
        redactions += line.redactions;
        kept_lines += 1;
    }

    let [header, provenance, notice, notable_title, tail_title, footer] = frame(
        &source_line,
        to_u32(kept_entries.len()),
        to_u32(entries.len()),
        more_distinct,
        to_u32(kept_tail),
        to_u32(total_lines),
    );
    let mut block_lines = vec![header, provenance, notice, notable_title];
    block_lines.extend(body_notable);
    block_lines.push(tail_title);
    block_lines.extend(body_tail);
    block_lines.push(footer);
    let block = block_lines.join("\n");
    debug_assert!(block.chars().count() <= MAX_LOG_BLOCK_CHARS);

    ReportLogExcerpt {
        requested_game_id,
        log_game_id: source.log_game_id,
        file_name: source.file_name.to_string(),
        block,
        total_lines: to_u32(total_lines),
        kept_lines,
        redactions,
    }
}

/// The description a report is submitted with: the reporter's words, then the
/// block when one is attached.
pub fn compose_description(text: &str, block: Option<&str>) -> String {
    match block {
        Some(block) => format!("{text}{SEPARATOR}{block}"),
        None => text.to_string(),
    }
}

/// The reporter's words and the attached block, from a description this
/// client composed. A description without a block comes back whole.
pub fn split_description(description: &str) -> (String, Option<String>) {
    let mut search_from = 0;
    while let Some(found) = description[search_from..].find(BLOCK_START) {
        let start = search_from + found;
        // Only at the start of a line after the reporter's words: the same
        // words typed into the middle of a sentence are not a block.
        if start > 0 && description[..start].ends_with('\n') {
            let text = description[..start].trim_end().to_string();
            return (text, Some(description[start..].to_string()));
        }
        search_from = start + BLOCK_START.len();
    }
    (description.to_string(), None)
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The frame around the body: what the block is, where it came from, what
/// was taken out, the two section titles, and its end.
fn frame(
    source_line: &str,
    kept_entries: u32,
    distinct_entries: u32,
    more_distinct: bool,
    kept_tail: u32,
    total_lines: u32,
) -> [String; 6] {
    let more = if more_distinct { "+" } else { "" };
    let notable_title = if distinct_entries == 0 {
        "-- Error, desync and disconnect lines before the end: none --".to_string()
    } else {
        format!(
            "-- Error, desync and disconnect lines before the end: {kept_entries} of \
             {distinct_entries}{more} distinct, oldest first; (xN) = repeated N times --"
        )
    };
    [
        BLOCK_HEADER.to_string(),
        format!("Source: {source_line}"),
        format!(
            "The client replaced folder paths, account and computer names, and IP and e-mail \
             addresses with <path>, <name>, <ip> and <email>, and cut lines longer than \
             {MAX_LINE_CHARS} characters. The reporter chose to attach this and was shown it \
             before sending."
        ),
        notable_title,
        format!("-- The last {kept_tail} of {total_lines} lines --"),
        BLOCK_END.to_string(),
    ]
}

/// Which log this is, said so a moderator cannot take the most recent game
/// for the reported one.
fn source_line(requested: Option<i32>, log: Option<i32>) -> String {
    match (requested, log) {
        (Some(requested), Some(log)) if requested == log => {
            format!("the reporter's log of game #{log}, the game this report names.")
        }
        (Some(requested), Some(log)) => format!(
            "the reporter's most recent game log, of game #{log}. No log of game \
             #{requested} was kept."
        ),
        (Some(requested), None) => format!(
            "the reporter's most recent game log, of an unknown game. No log of game \
             #{requested} was kept."
        ),
        (None, Some(log)) => format!("the reporter's most recent game log, of game #{log}."),
        (None, None) => "the reporter's most recent game log, of an unknown game.".to_string(),
    }
}

/// One error line and the indented lines after it, as read from the log.
struct RawEntry<'a> {
    lines: Vec<&'a str>,
    count: u32,
}

/// The distinct error entries before the tail, oldest first, and whether
/// there were more distinct ones than [`MAX_DISTINCT_NOTABLE`].
fn notable_entries<'a>(lines: &[&'a str]) -> (Vec<RawEntry<'a>>, bool) {
    let mut entries: Vec<RawEntry<'a>> = Vec::new();
    let mut seen: HashMap<Vec<&'a str>, usize> = HashMap::new();
    let mut more = false;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if !is_notable(line) {
            index += 1;
            continue;
        }
        let mut entry = vec![line];
        let mut next = index + 1;
        while next < lines.len()
            && entry.len() <= CONTINUATION_LINES
            && is_continuation(lines[next])
        {
            entry.push(lines[next]);
            next += 1;
        }
        index = next;
        if let Some(&position) = seen.get(&entry) {
            entries[position].count = entries[position].count.saturating_add(1);
        } else if entries.len() < MAX_DISTINCT_NOTABLE {
            seen.insert(entry.clone(), entries.len());
            entries.push(RawEntry {
                lines: entry,
                count: 1,
            });
        } else {
            more = true;
        }
    }
    (entries, more)
}

fn is_notable(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    NOTABLE.iter().any(|word| lower.contains(word))
}

/// The engine indents the second and later lines of one message, a Lua stack
/// trace among them.
fn is_continuation(line: &str) -> bool {
    line.starts_with([' ', '\t']) && !line.trim().is_empty()
}

/// A line as it will be sent, and how many replacements it took.
struct Sanitised {
    text: String,
    redactions: u32,
}

struct Entry {
    lines: Vec<Sanitised>,
    count: u32,
}

impl Entry {
    /// What the entry costs in the block, the repeat mark and newlines
    /// included.
    fn cost(&self) -> usize {
        let mark = if self.count > 1 {
            format!("(x{}) ", self.count).chars().count()
        } else {
            0
        };
        mark + self
            .lines
            .iter()
            .map(|line| line.text.chars().count() + 1)
            .sum::<usize>()
    }
}

/// Sanitise the distinct entries, and merge those that only differed in what
/// was taken out (two lines naming different addresses, say).
fn sanitise_entries(raw: Vec<RawEntry<'_>>, names: &[Vec<char>]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut seen: HashMap<Vec<String>, usize> = HashMap::new();
    for raw_entry in raw {
        let lines: Vec<Sanitised> = raw_entry
            .lines
            .iter()
            .map(|line| sanitise_for_excerpt(line, names))
            .collect();
        let key: Vec<String> = lines.iter().map(|line| line.text.clone()).collect();
        if let Some(&position) = seen.get(&key) {
            entries[position].count = entries[position].count.saturating_add(raw_entry.count);
        } else {
            seen.insert(key, entries.len());
            entries.push(Entry {
                lines,
                count: raw_entry.count,
            });
        }
    }
    entries
}

/// Which entries and how many tail lines fit in `budget` characters.
///
/// The tail is guaranteed half the budget, since the end of the game is what
/// nearly every report is about, and it takes more when the error lines need
/// less. The error lines then fill what is left in log order, skipping one
/// that does not fit rather than stopping at it, so one long stack trace does
/// not keep out the short desync line after it.
fn fit(entries: &[Entry], tail: &[Sanitised], budget: usize) -> (Vec<usize>, usize) {
    let entry_costs: Vec<usize> = entries.iter().map(Entry::cost).collect();
    let tail_costs: Vec<usize> = tail
        .iter()
        .map(|line| line.text.chars().count() + 1)
        .collect();
    let entries_total: usize = entry_costs.iter().sum();
    let tail_total: usize = tail_costs.iter().sum();
    if entries_total + tail_total <= budget {
        return ((0..entries.len()).collect(), tail.len());
    }

    let tail_budget = (budget / 2).max(budget.saturating_sub(entries_total));
    let mut tail_used = 0;
    let mut kept_tail = 0;
    for cost in tail_costs.iter().rev() {
        if tail_used + cost > tail_budget {
            break;
        }
        tail_used += cost;
        kept_tail += 1;
    }

    let mut remaining = budget - tail_used;
    let mut kept = Vec::new();
    for (index, cost) in entry_costs.iter().enumerate() {
        if *cost <= remaining {
            remaining -= cost;
            kept.push(index);
        }
    }
    (kept, kept_tail)
}

/// The names worth looking for, longest first so "alice.smith" is taken out
/// whole before "alice" could take out half of it.
fn usable_names(names: &[String]) -> Vec<Vec<char>> {
    let mut usable: Vec<Vec<char>> = names
        .iter()
        .map(|name| name.trim())
        .filter(|name| name.chars().count() >= MIN_NAME_CHARS)
        .map(|name| name.chars().collect())
        .collect();
    usable.sort_by_key(|name: &Vec<char>| std::cmp::Reverse(name.len()));
    usable.dedup_by(|a, b| chars_equal_ignore_case(a, b));
    usable
}

/// A raw log line as the excerpt keeps it: looked at in full up to a limit,
/// sanitised, then cut to [`MAX_LINE_CHARS`].
fn sanitise_for_excerpt(line: &str, names: &[Vec<char>]) -> Sanitised {
    let looked_at = cut_at_word(line, MAX_RAW_LINE_CHARS);
    let (text, redactions) = sanitise(looked_at, names);
    let text = if text.chars().count() > MAX_LINE_CHARS {
        let mut cut: String = text.chars().take(MAX_LINE_CHARS - 6).collect();
        cut.push_str(" [...]");
        cut
    } else {
        text
    };
    Sanitised { text, redactions }
}

/// `line`, cut to at most `limit` characters without ending inside a word: a
/// name cut in half is no longer the name the redaction looks for, and its
/// first half would go out as it is.
fn cut_at_word(line: &str, limit: usize) -> &str {
    let Some((end, _)) = line.char_indices().nth(limit) else {
        return line;
    };
    let head = &line[..end];
    match head.rfind(|c: char| !is_word_char(c)) {
        Some(boundary) => &line[..boundary],
        None => "",
    }
}

/// One line with this machine taken out of it, and how many replacements
/// that took. Public for the adapter's own use and for the tests.
pub fn sanitise_line(line: &str, private_names: &[String]) -> (String, u32) {
    sanitise(line, &usable_names(private_names))
}

fn sanitise(line: &str, names: &[Vec<char>]) -> (String, u32) {
    // Control characters would garble the moderators' view, and a tab is
    // shown as the indentation it stands for.
    let mut chars: Vec<char> = Vec::with_capacity(line.len());
    for c in line.chars() {
        if c == '\t' {
            chars.extend([' ', ' ']);
        } else if !c.is_control() {
            chars.push(c);
        }
    }
    // Paths first: a user name inside a path goes with the path. Then the
    // addresses, then whatever names are left in the words.
    let (next, mut redactions) = redact_paths(&chars, names);
    chars = next;
    for pass in [redact_emails, redact_ip_addresses] {
        let (next, count) = pass(&chars);
        chars = next;
        redactions += count;
    }
    let (chars, count) = redact_names(&chars, names);
    redactions += count;
    (chars.into_iter().collect(), redactions)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_separator(c: char) -> bool {
    c == '\\' || c == '/'
}

/// Where a path that starts at `index` begins its first segment, or `None`
/// when no path starts there.
///
/// Recognised: a Windows drive (`C:\`, `C:/`, which also covers a `file:`
/// URL), a network or device path (`\\server`, `\\?\C:\`), and the Unix
/// directories a user's files live under. The game's own virtual paths
/// (`/lua/...`, `/maps/...`) are not among them: they are the same on every
/// machine and are what says where a Lua error came from.
fn path_root(chars: &[char], index: usize) -> Option<usize> {
    if index > 0 && chars[index - 1].is_alphanumeric() {
        return None;
    }
    let at = |offset: usize| chars.get(index + offset).copied();
    let drive = |offset: usize| {
        at(offset).is_some_and(|c| c.is_ascii_alphabetic())
            && at(offset + 1) == Some(':')
            && at(offset + 2).is_some_and(is_separator)
    };
    if drive(0) {
        return Some(3);
    }
    if at(0) == Some('\\') && at(1) == Some('\\') {
        if index > 0 && chars[index - 1] == '\\' {
            return None;
        }
        if matches!(at(2), Some('?' | '.')) && at(3) == Some('\\') {
            return Some(if drive(4) { 7 } else { 4 });
        }
        if at(2).is_some_and(char::is_alphanumeric) {
            return Some(2);
        }
        return None;
    }
    if at(0) == Some('~') && at(1) == Some('/') {
        return Some(2);
    }
    const UNIX_ROOTS: [&str; 10] = [
        "/home/",
        "/Users/",
        "/root/",
        "/var/home/",
        "/run/media/",
        "/media/",
        "/mnt/",
        "/tmp/",
        "/private/",
        "/Volumes/",
    ];
    UNIX_ROOTS.iter().find_map(|root| {
        let matches = root
            .chars()
            .enumerate()
            .all(|(offset, c)| at(offset) == Some(c));
        // The roots are ASCII, so their length in bytes is their length in
        // characters.
        matches.then_some(root.len())
    })
}

/// The last folder named in a path's root: `home` in `/home/`, so a user's
/// folder right after it is recognised as one.
fn last_root_segment(root: &[char]) -> &[char] {
    let trimmed = match root.iter().rposition(|&c| !is_separator(c)) {
        Some(last) => &root[..=last],
        None => &root[..0],
    };
    match trimmed.iter().rposition(|&c| is_separator(c)) {
        Some(separator) => &trimmed[separator + 1..],
        None => trimmed,
    }
}

/// Characters no path segment contains, so they end one. The colon matters
/// most: Windows allows none in a name, and it is what ends a path written
/// before `: error ...` or before a second drive letter.
fn ends_path(c: char) -> bool {
    matches!(
        c,
        '"' | '\'' | '`' | '<' | '>' | '|' | '*' | '?' | ':' | ',' | ';'
    )
}

/// Replace each path with `<path>`, keeping its file name when it has one.
///
/// A folder name may hold spaces (`Program Files (x86)`), so text is part of
/// the path while a separator still follows it. Text that only ends the path
/// at the first space: the file name, then the rest of the line. A separator
/// straight after a space is a command-line switch (`game.exe /log`), not
/// another folder.
///
/// The one exception is a private name: a profile folder called
/// `Example User` that ends a path is taken whole, where the first space
/// used to end it and leave `User` behind as a word of the line.
fn redact_paths(chars: &[char], names: &[Vec<char>]) -> (Vec<char>, u32) {
    let mut out = Vec::with_capacity(chars.len());
    let mut count = 0;
    let mut index = 0;
    while index < chars.len() {
        let Some(root) = path_root(chars, index) else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        let mut separator = chars[index..index + root]
            .iter()
            .rev()
            .copied()
            .find(|&c| is_separator(c))
            .unwrap_or('\\');
        let mut segment_start = index + root;
        let mut previous_segment = last_root_segment(&chars[index..segment_start]);
        let mut cursor = segment_start;
        let segment_end = loop {
            let Some(&c) = chars.get(cursor) else {
                break cursor;
            };
            let after_space = cursor > segment_start && chars[cursor - 1].is_whitespace();
            if is_separator(c) && !after_space {
                previous_segment = &chars[segment_start..cursor];
                separator = c;
                segment_start = cursor + 1;
                cursor += 1;
                continue;
            }
            // A second path starting inside this one ends it, so the words
            // between the two survive.
            let next_path = cursor > segment_start && path_root(chars, cursor).is_some();
            if ends_path(c) || is_separator(c) || next_path {
                break cursor;
            }
            cursor += 1;
        };
        // The last segment is the file name, up to the first space, unless a
        // private name with a space in it starts there.
        let first_space = chars[segment_start..segment_end]
            .iter()
            .position(|c| c.is_whitespace())
            .map_or(segment_end, |offset| segment_start + offset);
        let name_end = match name_at(chars, segment_start, names) {
            Some(end) if end > first_space && end <= segment_end => end,
            _ => first_space,
        };
        let name = &chars[segment_start..name_end];
        out.extend("<path>".chars());
        if is_file_name(name) && !is_profile_parent(previous_segment) {
            out.push(separator);
            out.extend_from_slice(name);
        }
        count += 1;
        index = name_end;
    }
    (out, count)
}

/// A name with an extension: worth keeping, since `scenario.lua` or `fa.exe`
/// says what the line is about. A folder name is not kept, which is what
/// keeps a profile folder out when nothing follows it.
fn is_file_name(name: &[char]) -> bool {
    name.len() <= 120
        && name
            .iter()
            .rposition(|&c| c == '.')
            .is_some_and(|dot| dot > 0 && dot + 1 < name.len())
}

/// Whether a segment is the folder user profiles live in, so whatever follows
/// it is a user's own name even when it looks like a file name
/// (`C:\Users\john.smith`, `/home/john.smith`, `/media/john.smith`).
fn is_profile_parent(segment: &[char]) -> bool {
    let segment: String = segment.iter().collect::<String>().to_lowercase();
    matches!(
        segment.as_str(),
        "users" | "home" | "media" | "documents and settings"
    )
}

fn redact_emails(chars: &[char]) -> (Vec<char>, u32) {
    let local = |c: char| c.is_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-');
    let domain = |c: char| c.is_alphanumeric() || matches!(c, '.' | '-');
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '@' {
            index += 1;
            continue;
        }
        let mut start = index;
        while start > 0 && local(chars[start - 1]) {
            start -= 1;
        }
        let mut end = index + 1;
        while end < chars.len() && domain(chars[end]) {
            end += 1;
        }
        // Trailing dots belong to the sentence, not the address.
        while end > index + 1 && chars[end - 1] == '.' {
            end -= 1;
        }
        let host: String = chars[index + 1..end].iter().collect();
        let tld_ok = host.rsplit_once('.').is_some_and(|(name, tld)| {
            !name.is_empty() && tld.len() >= 2 && tld.chars().all(char::is_alphabetic)
        });
        if start < index && tld_ok {
            ranges.push((start, end));
            index = end;
        } else {
            index += 1;
        }
    }
    replace_ranges(chars, &ranges, "<email>")
}

fn redact_ip_addresses(chars: &[char]) -> (Vec<char>, u32) {
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let boundary = index == 0 || {
            let before = chars[index - 1];
            if before == ':' {
                // After a label (`IP:203.0.113.7`) an address starts, and it
                // used to go out whole. Inside a `::` what follows is the rest
                // of one name (`Moho::CUnit`) or address, never a new one.
                index < 2 || chars[index - 2] != ':'
            } else {
                !(before.is_alphanumeric() || before == '.')
            }
        };
        if boundary {
            if let Some(end) = ipv4_at(chars, index) {
                ranges.push((index, end));
                index = end;
                continue;
            }
            if let Some(end) = ipv6_at(chars, index) {
                ranges.push((index, end));
                index = end;
                continue;
            }
        }
        index += 1;
    }
    replace_ranges(chars, &ranges, "<ip>")
}

/// The end of an IPv4 address starting at `index`, unless it is loopback or
/// unspecified: `127.0.0.1` is the game talking to its own adapter, which is
/// the same on every machine and says something about the connection.
fn ipv4_at(chars: &[char], index: usize) -> Option<usize> {
    let (end, octets) = ipv4_shape_at(chars, index)?;
    (!is_local_ipv4(octets)).then_some(end)
}

fn is_local_ipv4(octets: [u32; 4]) -> bool {
    octets[0] == 127 || octets == [0, 0, 0, 0]
}

/// The end and the octets of four dotted numbers starting at `index`, each
/// at most 255, that are not the start of something longer.
fn ipv4_shape_at(chars: &[char], index: usize) -> Option<(usize, [u32; 4])> {
    let mut octets = [0u32; 4];
    let mut cursor = index;
    for (position, octet) in octets.iter_mut().enumerate() {
        if position > 0 {
            if chars.get(cursor) != Some(&'.') {
                return None;
            }
            cursor += 1;
        }
        let start = cursor;
        while cursor < chars.len() && cursor - start < 4 && chars[cursor].is_ascii_digit() {
            cursor += 1;
        }
        let digits = cursor - start;
        if digits == 0 || digits > 3 {
            return None;
        }
        *octet = chars[start..cursor]
            .iter()
            .fold(0, |value, c| value * 10 + c.to_digit(10).unwrap_or(0));
        if *octet > 255 {
            return None;
        }
    }
    // Not the start of something longer, such as a five-part version number.
    match chars.get(cursor) {
        Some(c) if c.is_alphanumeric() => return None,
        Some('.') if chars.get(cursor + 1).is_some_and(char::is_ascii_digit) => return None,
        _ => {}
    }
    Some((cursor, octets))
}

/// The end of an IPv6 address starting at `index`. Strict enough to leave a
/// clock time (`12:34:56`) and a C++ name (`Moho::CUnit`) alone: it needs a
/// `::` or all eight groups, at most one `::`, and a digit somewhere.
///
/// An address may end in IPv4 form (`::ffff:203.0.113.7`, how a dual-stack
/// socket writes an IPv4 peer), and is then taken to its end: it used to stop
/// at the first dot and leave three of the four octets behind.
fn ipv6_at(chars: &[char], index: usize) -> Option<usize> {
    let mut end = index;
    while end < chars.len() && (chars[end].is_ascii_hexdigit() || chars[end] == ':') {
        end += 1;
    }
    if end == index {
        return None;
    }
    let mut head_end = end;
    let mut embedded = None;
    if chars.get(end) == Some(&'.') {
        let tail = chars[index..end]
            .iter()
            .rposition(|&c| c == ':')
            .map(|colon| index + colon + 1);
        if let Some(tail) = tail {
            if let Some((v4_end, octets)) = ipv4_shape_at(chars, tail) {
                head_end = tail;
                end = v4_end;
                embedded = Some(octets);
            }
        }
    }
    if chars.get(end).is_some_and(|c| is_word_char(*c)) {
        return None;
    }
    let head: String = chars[index..head_end].iter().collect();
    let mut text = head.clone();
    if embedded.is_some() {
        // The last 32 bits stand for two groups.
        text.push_str("0:0");
    }
    let colons = text.matches(':').count();
    let double = text.matches("::").count();
    let groups_ok = text.split(':').all(|group| group.len() <= 4);
    // A single colon cannot open or close an address; only `::` can.
    let ends_ok = (!text.starts_with(':') || text.starts_with("::"))
        && (!text.ends_with(':') || text.ends_with("::"));
    let shaped = colons >= 2
        && !text.contains(":::")
        && match double {
            0 => colons == 7,
            1 => colons <= 7,
            _ => false,
        };
    let has_digit = embedded.is_some() || text.chars().any(|c| c.is_ascii_digit());
    if !(shaped && groups_ok && ends_ok && has_digit) || text == "::1" {
        return None;
    }
    // Only the IPv4-mapped form of loopback is this machine. Any other prefix
    // makes the address a different one, whatever its last 32 bits say: the
    // exception used to keep `2001:db8::127.0.0.1` whole, prefix and all.
    if embedded.is_some_and(is_local_ipv4) && is_ipv4_mapped(&head) {
        return None;
    }
    Some(end)
}

/// Whether `head`, the groups written before an embedded IPv4 address (with
/// the colon that ends them), are `::ffff:` in any spelling: the form a
/// dual-stack socket writes an IPv4 peer in.
fn is_ipv4_mapped(head: &str) -> bool {
    six_groups(head).is_some_and(|groups| groups == [0, 0, 0, 0, 0, 0xffff])
}

/// The six groups `head` spells out, a `::` filled with zeros.
fn six_groups(head: &str) -> Option<Vec<u16>> {
    // The colon before the IPv4 part ends the head, unless it is half of
    // the head's own `::`.
    let head = if head.ends_with("::") {
        head
    } else {
        head.strip_suffix(':')?
    };
    let parse = |part: &str| -> Option<Vec<u16>> {
        if part.is_empty() {
            return Some(Vec::new());
        }
        part.split(':')
            .map(|group| u16::from_str_radix(group, 16).ok())
            .collect()
    };
    match head.split_once("::") {
        Some((left, right)) => {
            let (mut groups, right) = (parse(left)?, parse(right)?);
            // A `::` stands for at least one group.
            if groups.len() + right.len() > 5 {
                return None;
            }
            groups.resize(6 - right.len(), 0);
            groups.extend(right);
            Some(groups)
        }
        None => parse(head).filter(|groups| groups.len() == 6),
    }
}

/// Replace each private name where it stands as a word, regardless of case.
fn redact_names(chars: &[char], names: &[Vec<char>]) -> (Vec<char>, u32) {
    if names.is_empty() {
        return (chars.to_vec(), 0);
    }
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let starts_word = index == 0 || {
            let before = chars[index - 1];
            // Not inside a marker an earlier pass wrote: an account called
            // "path" must not turn `<path>` into `<<name>>`.
            !is_word_char(before) && before != '<'
        };
        let matched = if starts_word {
            name_at(chars, index, names)
        } else {
            None
        };
        match matched {
            Some(end) => {
                ranges.push((index, end));
                index = end;
            }
            None => index += 1,
        }
    }
    replace_ranges(chars, &ranges, "<name>")
}

/// The end of a private name written at `index`, in any case, when nothing
/// of the same word follows it. The longest name wins, since `names` comes
/// longest first.
fn name_at(chars: &[char], index: usize, names: &[Vec<char>]) -> Option<usize> {
    names.iter().find_map(|name| {
        let end = index + name.len();
        let fits = end <= chars.len()
            && chars_equal_ignore_case(&chars[index..end], name)
            && chars.get(end).is_none_or(|c| !is_word_char(*c));
        fits.then_some(end)
    })
}

fn chars_equal_ignore_case(a: &[char], b: &[char]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x == y || x.to_lowercase().eq(y.to_lowercase()))
}

/// `chars` with each of the sorted, disjoint `ranges` replaced by `marker`.
fn replace_ranges(chars: &[char], ranges: &[(usize, usize)], marker: &str) -> (Vec<char>, u32) {
    if ranges.is_empty() {
        return (chars.to_vec(), 0);
    }
    let mut out = Vec::with_capacity(chars.len());
    let mut cursor = 0;
    for &(start, end) in ranges {
        out.extend_from_slice(&chars[cursor..start]);
        out.extend(marker.chars());
        cursor = end;
    }
    out.extend_from_slice(&chars[cursor..]);
    (out, to_u32(ranges.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["ExampleUser".into(), "EXAMPLE-PC".into()]
    }

    fn clean(line: &str) -> String {
        sanitise_line(line, &names()).0
    }

    fn source(content: &str) -> ReportLogSource<'_> {
        ReportLogSource {
            file_name: "game-42-1-1.log",
            log_game_id: Some(42),
            content,
        }
    }

    #[test]
    fn a_windows_path_loses_its_folders_and_keeps_its_file_name() {
        assert_eq!(
            clean(
                r"info: Loading C:\Users\ExampleUser\Documents\My Games\maps\scmp_009\scmp_009_scenario.lua"
            ),
            r"info: Loading <path>\scmp_009_scenario.lua"
        );
        assert_eq!(
            clean(
                r#"warning: could not open "C:/ProgramData/FAForever/bin/init_faf.lua": missing"#
            ),
            r#"warning: could not open "<path>/init_faf.lua": missing"#
        );
    }

    #[test]
    fn a_profile_folder_is_removed_even_when_it_looks_like_a_file_name() {
        // `john.smith` has a dot, so on its own it would pass for a file.
        assert_eq!(clean(r"home is C:\Users\john.smith"), "home is <path>");
        assert_eq!(clean("home is /home/john.smith"), "home is <path>");
    }

    #[test]
    fn folder_names_with_spaces_and_a_command_line_after_the_path() {
        assert_eq!(
            clean(
                r"info: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\bin\SupremeCommander.exe /init init_faf.lua /nobugreport"
            ),
            r"info: <path>\SupremeCommander.exe /init init_faf.lua /nobugreport"
        );
    }

    #[test]
    fn two_paths_in_one_line_are_both_removed_and_the_words_between_kept() {
        assert_eq!(
            clean(r"copied C:\Users\ExampleUser\a.txt to D:\Backup\ExampleUser\b.txt today"),
            r"copied <path>\a.txt to <path>\b.txt today"
        );
    }

    #[test]
    fn network_device_and_unix_paths_are_removed() {
        assert_eq!(clean(r"\\EXAMPLE-NAS\share\fa\log.txt"), r"<path>\log.txt");
        assert_eq!(
            clean(r"\\?\C:\Users\ExampleUser\AppData\game.log"),
            r"<path>\game.log"
        );
        assert_eq!(
            clean("wine: /home/exampleuser/.wine/drive_c/fa/game.log ok"),
            "wine: <path>/game.log ok"
        );
        assert_eq!(clean("~/games/fa/run.sh"), "<path>/run.sh");
    }

    #[test]
    fn the_games_own_virtual_paths_are_kept() {
        // Where a Lua error came from, and the same on every machine.
        let line = "warning: /lua/sim/Unit.lua(1234): attempt to index a nil value";
        assert_eq!(clean(line), line);
        let line = "info: mounting /maps/scmp_009/";
        assert_eq!(clean(line), line);
    }

    #[test]
    fn the_user_and_computer_names_are_removed_as_words_regardless_of_case() {
        assert_eq!(
            clean("info: Computer name EXAMPLE-pc, user exampleuser"),
            "info: Computer name <name>, user <name>"
        );
        // Part of a longer word is someone else's name, not this one.
        assert_eq!(
            clean("chat: ExampleUserFan says hi"),
            "chat: ExampleUserFan says hi"
        );
    }

    #[test]
    fn a_profile_folder_with_a_space_is_removed_whole() {
        // The first space used to end the path, and `User` went out as a
        // word of the line.
        let names = ["Example User".to_string()];
        for (line, expected) in [
            (r"home is C:\Users\Example User", "home is <path>"),
            (
                r"C:\Users\Example User: access denied",
                "<path>: access denied",
            ),
            ("home is /home/example user", "home is <path>"),
            (
                r"C:\Users\Example User\Documents\game.log opened",
                r"<path>\game.log opened",
            ),
        ] {
            let (cleaned, _) = sanitise_line(line, &names);
            assert_eq!(cleaned, expected, "{line}");
            assert!(!cleaned.contains("User"), "{cleaned}");
        }
        // A file name with a space is still cut at it: only a private name
        // is taken past one.
        assert_eq!(
            clean(r"opened C:\Games\fa\read me.txt"),
            r"opened <path> me.txt"
        );
    }

    #[test]
    fn a_short_name_is_left_to_the_path_rule() {
        let (line, redactions) = sanitise_line(r"PC AI C:\Users\al\x.lua", &["al".into()]);
        assert_eq!(line, r"PC AI <path>\x.lua");
        assert_eq!(redactions, 1);
    }

    #[test]
    fn ip_and_email_addresses_are_removed_and_loopback_kept() {
        assert_eq!(
            clean("info: peer 203.0.113.7:6112 via 192.168.1.20, adapter at 127.0.0.1:7237"),
            "info: peer <ip>:6112 via <ip>, adapter at 127.0.0.1:7237"
        );
        assert_eq!(clean("relay [2001:db8::42]:3478"), "relay [<ip>]:3478");
        assert_eq!(clean("mail example.user@example.org."), "mail <email>.");
    }

    #[test]
    fn an_address_after_a_label_colon_is_removed() {
        // The colon before the address used to hide it from the rule.
        assert_eq!(clean("info: IP:203.0.113.7:6112"), "info: IP:<ip>:6112");
        assert_eq!(clean("peer=ip:2001:db8::42 up"), "peer=ip:<ip> up");
        assert_eq!(clean("host:192.168.1.20"), "host:<ip>");
    }

    #[test]
    fn an_ipv4_mapped_ipv6_address_is_removed_whole() {
        // It used to stop at the first dot and leave `.0.113.7` behind.
        assert_eq!(
            clean("info: peer ::ffff:203.0.113.7 joined"),
            "info: peer <ip> joined"
        );
        assert_eq!(
            clean("relay [::FFFF:198.51.100.9]:3478"),
            "relay [<ip>]:3478"
        );
        assert_eq!(clean("nat64 64:ff9b::203.0.113.7."), "nat64 <ip>.");
        assert_eq!(clean("full 0:0:0:0:0:ffff:203.0.113.7"), "full <ip>");
        // The adapter on this machine stays, as in IPv4.
        let line = "info: adapter at ::ffff:127.0.0.1:7237";
        assert_eq!(clean(line), line);
    }

    #[test]
    fn only_the_mapped_form_of_loopback_is_kept() {
        // A prefix makes it another machine's address, whatever its last 32
        // bits say. The first used to go out whole.
        for (line, expected) in [
            ("peer 2001:db8::127.0.0.1 up", "peer <ip> up"),
            ("peer 2001:db8::0.0.0.0 up", "peer <ip> up"),
            ("nat64 64:ff9b::127.0.0.1", "nat64 <ip>"),
            ("compatible ::127.0.0.1", "compatible <ip>"),
            ("translated ::ffff:0:127.0.0.1", "translated <ip>"),
        ] {
            assert_eq!(clean(line), expected, "{line}");
        }
        // The adapter on this machine, however the mapped form is spelled.
        for line in [
            "adapter ::ffff:127.0.0.1:7237",
            "adapter ::FFFF:127.0.0.1",
            "adapter ::0:ffff:127.0.0.1",
            "adapter 0000::ffff:127.0.0.1",
            "adapter 0:0:0:0:0:ffff:127.0.0.1",
        ] {
            assert_eq!(clean(line), line);
        }
    }

    #[test]
    fn version_numbers_times_and_cpp_names_are_not_addresses() {
        for line in [
            "info: version 1.5.3780",
            "info: build 10.0.19045.3803",
            "info: at 12:34:56",
            "info: game time 00:12:34.567",
            "warning: Moho::CUnit::Kill failed",
            "warning: Moho::Add::Face1 failed",
            "info: 1.2.3.4.5 is a version",
        ] {
            assert_eq!(clean(line), line, "{line}");
        }
    }

    #[test]
    fn control_characters_go_and_tabs_become_spaces() {
        assert_eq!(clean("a\tb\u{7}c\r"), "a  bc");
    }

    #[test]
    fn the_excerpt_keeps_the_tail_and_the_error_lines_before_it() {
        let mut log = String::new();
        log.push_str("info: loading\n");
        log.push_str("warning: Desync detected at beat 1200\n");
        for index in 0..500 {
            log.push_str(&format!("debug: tick {index}\n"));
        }
        log.push_str("warning: Error running lua script: oops\n");
        log.push_str("         stack traceback:\n");
        log.push_str("         [C]: in function `error'\n");
        for index in 0..100 {
            log.push_str(&format!("info: late {index}\n"));
        }
        log.push_str("info: Player Bob disconnected\n");

        let excerpt = build_excerpt(Some(42), &source(&log), &names());

        assert!(excerpt.block.starts_with(BLOCK_START));
        assert!(excerpt.block.ends_with(BLOCK_END));
        assert!(excerpt
            .block
            .contains("warning: Desync detected at beat 1200"));
        assert!(excerpt
            .block
            .contains("warning: Error running lua script: oops"));
        assert!(excerpt.block.contains("         stack traceback:"));
        assert!(excerpt.block.contains("info: Player Bob disconnected"));
        assert!(
            !excerpt.block.contains("debug: tick 7\n"),
            "ordinary lines before the tail are dropped"
        );
        assert!(excerpt
            .block
            .contains("game #42, the game this report names"));
        assert_eq!(excerpt.total_lines, 606);
        // Two error entries (one line, three lines) and the forty-line tail.
        assert_eq!(excerpt.kept_lines, 1 + 3 + 40);
    }

    #[test]
    fn a_repeated_error_line_is_kept_once_with_its_count() {
        let mut log = "warning: SND Error: XACT failed\n".repeat(25);
        log.push_str(&"info: filler\n".repeat(50));
        let excerpt = build_excerpt(None, &source(&log), &[]);
        assert_eq!(excerpt.block.matches("XACT failed").count(), 1);
        assert!(excerpt
            .block
            .contains("(x25) warning: SND Error: XACT failed"));
    }

    #[test]
    fn lines_that_differ_only_in_what_was_removed_are_one_entry() {
        let log = format!(
            "{}{}",
            "error: lost connection to 203.0.113.7\nerror: lost connection to 198.51.100.9\n",
            "info: filler\n".repeat(50)
        );
        let excerpt = build_excerpt(None, &source(&log), &[]);
        assert!(excerpt
            .block
            .contains("(x2) error: lost connection to <ip>"));
    }

    #[test]
    fn the_excerpt_is_sanitised() {
        let log = format!(
            "error: cannot read C:\\Users\\ExampleUser\\Documents\\notes.txt on EXAMPLE-PC\n{}",
            "info: filler from 203.0.113.7\n".repeat(10)
        );
        let excerpt = build_excerpt(None, &source(&log), &names());
        assert!(!excerpt.block.contains("ExampleUser"));
        assert!(!excerpt.block.contains("EXAMPLE-PC"));
        assert!(!excerpt.block.contains("203.0.113.7"));
        assert!(!excerpt.block.contains("Users"));
        assert!(excerpt.block.contains(r"<path>\notes.txt on <name>"));
        assert_eq!(excerpt.redactions, 2 + 10);
    }

    #[test]
    fn a_huge_log_stays_within_the_block_limit() {
        // Everything at once: thousands of distinct error lines with long
        // stack traces, enormous lines, multi-byte text and a long tail.
        let mut log = String::new();
        for index in 0..5_000 {
            log.push_str(&format!("warning: Error {index}: {}\n", "ü".repeat(500)));
            log.push_str(&format!("    stack {}\n", "x".repeat(3_000)));
        }
        for index in 0..10_000 {
            log.push_str(&format!("info: tail {index} {}\n", "ж".repeat(400)));
        }
        let excerpt = build_excerpt(Some(1), &source(&log), &names());
        assert!(
            excerpt.block.chars().count() <= MAX_LOG_BLOCK_CHARS,
            "{} characters",
            excerpt.block.chars().count()
        );
        assert!(
            excerpt.block.contains("+ distinct"),
            "the distinct cap is said"
        );
        assert!(
            excerpt.block.contains("info: tail 9999"),
            "the very end is kept"
        );
        assert!(
            excerpt.block.contains("warning: Error 0:"),
            "so are the first errors"
        );
        assert!(excerpt.kept_lines > 0);
    }

    #[test]
    fn every_kept_line_is_cut_to_the_line_limit() {
        let log = format!("info: {}\n", "a ".repeat(2_000));
        let excerpt = build_excerpt(None, &source(&log), &[]);
        let body_line = excerpt
            .block
            .lines()
            .find(|line| line.starts_with("info: "))
            .unwrap();
        assert_eq!(body_line.chars().count(), MAX_LINE_CHARS);
        assert!(body_line.ends_with(" [...]"));
    }

    #[test]
    fn a_name_at_the_look_limit_is_not_cut_in_half() {
        // The name straddles the point where an over-long line stops being
        // read; half of it must not survive as plain text.
        let padding = "a".repeat(MAX_RAW_LINE_CHARS - 4);
        let line = format!("{padding} ExampleUser rest");
        let looked_at = cut_at_word(&line, MAX_RAW_LINE_CHARS);
        assert!(!looked_at.contains("Exam"));
    }

    #[test]
    fn the_source_line_says_when_the_log_is_not_the_reported_game() {
        let excerpt = build_excerpt(
            Some(7),
            &ReportLogSource {
                file_name: "game-42-1-1.log",
                log_game_id: Some(42),
                content: "info: x\n",
            },
            &[],
        );
        assert!(excerpt
            .block
            .contains("most recent game log, of game #42. No log of game #7 was kept."));
        assert_eq!(excerpt.requested_game_id, Some(7));
        assert_eq!(excerpt.log_game_id, Some(42));
    }

    #[test]
    fn an_empty_log_still_makes_a_well_formed_block() {
        let excerpt = build_excerpt(None, &source(""), &[]);
        assert!(excerpt.block.contains("none --"));
        assert!(excerpt.block.contains("The last 0 of 0 lines"));
        assert_eq!(excerpt.kept_lines, 0);
    }

    #[test]
    fn a_composed_description_splits_back_into_words_and_block() {
        let excerpt = build_excerpt(Some(42), &source("info: x\n"), &[]);
        let description = compose_description("He team-killed me twice.", Some(&excerpt.block));
        assert_eq!(
            split_description(&description),
            ("He team-killed me twice.".to_string(), Some(excerpt.block))
        );
        assert_eq!(
            split_description("No log here."),
            ("No log here.".to_string(), None)
        );
        // The marker typed mid-sentence is not a block.
        let typed = format!("I saw {BLOCK_START} in chat");
        assert_eq!(split_description(&typed), (typed.clone(), None));
    }

    #[test]
    fn a_report_at_both_limits_fits_the_column() {
        let text = "ж".repeat(MAX_REPORT_TEXT_CHARS);
        let block = "€".repeat(MAX_LOG_BLOCK_CHARS);
        assert!(compose_description(&text, Some(&block)).len() <= MAX_DESCRIPTION_BYTES);
    }
}
