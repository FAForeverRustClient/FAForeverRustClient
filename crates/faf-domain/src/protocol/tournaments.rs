//! Tournament description handling.
//!
//! Challonge stores an organiser's description as HTML, and the Java client
//! substitutes it straight into a template it loads in a `WebView`. That is
//! safe there only because the pane is a browser they already treat as
//! untrusted; here the same content would land in the client's own document,
//! where a `<script>` or an `onerror=` from a third-party organiser would run
//! with the client's privileges.
//!
//! So descriptions are reduced to plain text before they ever reach the state.
//! Block-level tags become line breaks so a formatted announcement stays
//! readable, everything else is dropped, and the handful of entities that
//! survive escaping are decoded.

/// The first `https://` link in an HTML fragment, or empty when there is none.
///
/// [`to_plain_text`] discards tags wholesale, which is right for prose but
/// throws away the *only* content of an entry whose whole point is a link: a
/// tutorial that is a YouTube video or a wiki guide becomes a title and a
/// sentence pointing at nothing. This recovers the destination so the UI can
/// offer it as a button.
///
/// Deliberately `https` only. The value ends up in an `openUrl` call, and the
/// frontend's own allow-list would reject anything else anyway; refusing here
/// keeps a `javascript:` href from ever reaching the state.
pub fn first_link_url(html: &str) -> String {
    let mut rest = html;
    while let Some(open) = rest.find("href") {
        rest = &rest[open + 4..];
        let Some(quote) = rest.find(['"', '\'']) else {
            break;
        };
        // Only an `=` (and whitespace) may sit between the attribute name and
        // its value, otherwise this is some other attribute containing "href".
        if !rest[..quote].trim().starts_with('=') {
            continue;
        }
        let delimiter = rest.as_bytes()[quote] as char;
        let value = &rest[quote + 1..];
        let Some(end) = value.find(delimiter) else {
            break;
        };
        let url = value[..end].trim();
        if url.starts_with("https://") && !url.contains(['<', '>', '"', ' ']) {
            return url.to_string();
        }
        rest = &value[end + 1..];
    }
    String::new()
}

/// Tags after which a line break preserves the author's structure.
const BREAKS_AFTER: [&str; 12] = [
    "p",
    "br",
    "div",
    "li",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
];

/// Reduce an HTML fragment to plain text.
///
/// Not a parser and not a sanitiser: it never emits markup, so it has nothing
/// to sanitise. Anything between `<` and `>` is discarded, including the
/// contents of `<script>` and `<style>`, which would otherwise survive as
/// visible gibberish once their tags were stripped.
pub fn to_plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    // Set when a block-level tag asks for a break, so runs of `</p><p>` and
    // the like collapse into one.
    let mut pending_break = false;

    while let Some(open) = rest.find('<') {
        push_text(&mut out, &rest[..open], &mut pending_break);
        let after = &rest[open + 1..];
        let Some(close) = after.find('>') else {
            // An unclosed `<` is the author's typo, not markup. Keep it, so a
            // description ending in "score < 1500" doesn't lose its tail.
            push_text(&mut out, &rest[open..], &mut pending_break);
            rest = "";
            break;
        };
        let tag = &after[..close];
        rest = &after[close + 1..];

        if let Some(skipped) = skip_raw_text_element(tag, rest) {
            rest = skipped;
            continue;
        }
        if breaks_line(tag) {
            pending_break = true;
        }
    }
    push_text(&mut out, rest, &mut pending_break);

    out.trim().to_string()
}

/// Append decoded text, first honouring any break the previous tag asked for.
/// Whitespace-only runs never trigger the break on their own, so `</p>\n<p>`
/// produces one newline rather than a newline plus a stray space.
fn push_text(out: &mut String, raw: &str, pending_break: &mut bool) {
    let text = decode_entities(raw);
    if text.trim().is_empty() {
        return;
    }
    if *pending_break {
        if !out.is_empty() {
            out.push('\n');
        }
        *pending_break = false;
    } else if out.ends_with(char::is_alphanumeric) && text.starts_with(char::is_alphanumeric) {
        // Two runs separated only by an inline tag (`<b>`) were adjacent words
        // in the source and must not be glued together.
        out.push(' ');
    }
    out.push_str(&text);
}

/// The name of a tag, lowercased, ignoring `/` and any attributes.
fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('/')
        .split(|c: char| c.is_whitespace() || c == '/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn breaks_line(tag: &str) -> bool {
    BREAKS_AFTER.contains(&tag_name(tag).as_str())
}

/// For `<script>`/`<style>`, return the input positioned after the matching
/// closing tag: their bodies are code, not prose, and stripping only the tags
/// would leave the code on screen.
fn skip_raw_text_element<'a>(tag: &str, rest: &'a str) -> Option<&'a str> {
    let name = tag_name(tag);
    if tag.starts_with('/') || (name != "script" && name != "style") {
        return None;
    }
    let close = format!("</{name}");
    // No closing tag means the rest of the input is that element's body.
    // Discarding it is the safe reading: the alternative resumes treating code
    // as prose, which is exactly what this function exists to prevent.
    let Some(end) = rest
        .to_ascii_lowercase()
        .find(&close)
        .map(|at| at + close.len())
    else {
        return Some("");
    };
    // Step past the closing tag's own `>`.
    Some(match rest[end..].find('>') {
        Some(gt) => &rest[end + gt + 1..],
        None => "",
    })
}

/// Decode the entities that actually appear in escaped prose. A description is
/// text, not a document, so an unrecognised entity is left as written rather
/// than guessed at.
fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        match tail.find(';').filter(|end| *end <= 10) {
            Some(end) => {
                let entity = &tail[1..end];
                match named_entity(entity).or_else(|| numeric_entity(entity)) {
                    Some(decoded) => out.push(decoded),
                    None => out.push_str(&tail[..=end]),
                }
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn named_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        _ => None,
    }
}

fn numeric_entity(entity: &str) -> Option<char> {
    let digits = entity.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse().ok()?,
    };
    char::from_u32(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_links_destination_survives_the_plain_text_reduction() {
        // The case this exists for: a "video tutorial" entry whose entire
        // content is the link. `to_plain_text` keeps "Watch on YouTube" and
        // drops the URL, leaving a row that does nothing.
        let html = r#"<p>Watch <a href="https://www.youtube.com/watch?v=abc">on YouTube</a>.</p>"#;
        assert_eq!(to_plain_text(html), "Watch on YouTube.");
        assert_eq!(first_link_url(html), "https://www.youtube.com/watch?v=abc");
    }

    #[test]
    fn single_quoted_and_spaced_hrefs_are_read() {
        assert_eq!(
            first_link_url("<a href = 'https://wiki.faforever.com/en/Guide'>Guide</a>"),
            "https://wiki.faforever.com/en/Guide"
        );
    }

    #[test]
    fn the_first_usable_link_wins_and_the_rest_are_ignored() {
        let html =
            r#"<a href="https://one.invalid/a">1</a> and <a href="https://two.invalid/b">2</a>"#;
        assert_eq!(first_link_url(html), "https://one.invalid/a");
    }

    #[test]
    fn only_https_destinations_are_accepted() {
        // The value is handed to the OS browser, so anything that is not a
        // plain https URL must never reach the state.
        for html in [
            r#"<a href="javascript:alert(1)">x</a>"#,
            r#"<a href="http://insecure.invalid">x</a>"#,
            r#"<a href="/relative/path">x</a>"#,
            r#"<a href="data:text/html,<script>">x</a>"#,
            "<p>No links here at all.</p>",
            "",
        ] {
            assert_eq!(first_link_url(html), "", "{html} must yield no link");
        }
    }

    #[test]
    fn an_https_link_after_a_rejected_one_is_still_found() {
        let html =
            r#"<a href="http://old.invalid">old</a> <a href="https://new.invalid/x">new</a>"#;
        assert_eq!(first_link_url(html), "https://new.invalid/x");
    }

    #[test]
    fn an_attribute_merely_containing_href_is_not_mistaken_for_one() {
        assert_eq!(
            first_link_url(r#"<div data-hrefs="https://x.invalid">x</div>"#),
            ""
        );
    }

    #[test]
    fn plain_text_passes_through_untouched() {
        assert_eq!(
            to_plain_text("A 16-player swiss event."),
            "A 16-player swiss event."
        );
    }

    #[test]
    fn paragraphs_become_line_breaks() {
        assert_eq!(
            to_plain_text("<p>Round one at 18:00.</p><p>Round two follows.</p>"),
            "Round one at 18:00.\nRound two follows."
        );
    }

    #[test]
    fn a_run_of_block_tags_collapses_into_one_break() {
        // `</p>\n  <p>` is what a real description looks like; without
        // collapsing, every paragraph would gain a blank line and a stray
        // leading space.
        assert_eq!(
            to_plain_text("<div><p>First</p>\n  <p>Second</p></div>"),
            "First\nSecond"
        );
    }

    #[test]
    fn list_items_stay_on_their_own_lines() {
        assert_eq!(
            to_plain_text("<ul><li>Best of three</li><li>No mods</li></ul>"),
            "Best of three\nNo mods"
        );
    }

    #[test]
    fn inline_tags_do_not_glue_words_together() {
        assert_eq!(
            to_plain_text("Prize pool: <b>500</b> coins"),
            "Prize pool: 500 coins"
        );
        assert_eq!(to_plain_text("re<b>al</b>ly"), "re al ly");
    }

    #[test]
    fn script_bodies_are_dropped_not_merely_unwrapped() {
        // The whole point: stripping only the tags would leave the code
        // sitting in the description as visible text, and any client that
        // later rendered it as markup would execute it.
        assert_eq!(
            to_plain_text("Rules<script>alert('xss')</script>apply"),
            "Rules apply"
        );
        assert_eq!(
            to_plain_text("<style>body{display:none}</style>Welcome"),
            "Welcome"
        );
    }

    #[test]
    fn an_unclosed_script_swallows_the_rest_rather_than_leaking_code() {
        assert_eq!(to_plain_text("Hi<script>alert(1)"), "Hi");
    }

    #[test]
    fn attributes_and_self_closing_tags_are_ignored() {
        assert_eq!(
            to_plain_text(r#"<a href="https://example.invalid">Sign up</a><br/>Today"#),
            "Sign up\nToday"
        );
    }

    #[test]
    fn an_image_with_an_onerror_handler_leaves_nothing_behind() {
        assert_eq!(
            to_plain_text(r#"<img src=x onerror="alert(1)">Bracket"#),
            "Bracket"
        );
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(
            to_plain_text("Ratings &lt; 1500 &amp; &gt; 800"),
            "Ratings < 1500 & > 800"
        );
        assert_eq!(to_plain_text("Rock&#39;s Cup"), "Rock's Cup");
        assert_eq!(to_plain_text("caf&#xe9;"), "café");
    }

    #[test]
    fn a_decoded_entity_is_never_re_read_as_markup() {
        // `&lt;script&gt;` decodes to text that *looks* like a tag. Decoding
        // after stripping: not before: is what keeps it inert.
        assert_eq!(
            to_plain_text("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "<script>alert(1)</script>"
        );
    }

    #[test]
    fn an_unknown_or_unterminated_entity_is_left_alone() {
        assert_eq!(to_plain_text("&unknown; &amp"), "&unknown; &amp");
    }

    #[test]
    fn a_stray_angle_bracket_keeps_the_text_after_it() {
        assert_eq!(to_plain_text("Rating < 1500 only"), "Rating < 1500 only");
    }

    #[test]
    fn an_empty_description_stays_empty() {
        assert_eq!(to_plain_text(""), "");
        assert_eq!(to_plain_text("<p></p>"), "");
    }
}
