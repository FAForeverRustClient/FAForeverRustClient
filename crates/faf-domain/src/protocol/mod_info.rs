//! Rewriting a mod's `mod_info.lua` so it can be published under a new name.
//!
//! FAF has no rename. A mod's identity in the vault is its `uid`, and the vault
//! will not take a second upload carrying one it already has, so an author who
//! wants a different name has to edit `mod_info.lua`, invent a fresh uid, zip
//! the folder again and upload it as a new mod. That is the whole of the
//! procedure, and it is entirely mechanical, which is why it is done here
//! instead of in a forum post explaining it.
//!
//! What this is not: a Lua parser. `mod_info.lua` is a flat table of
//! assignments written from the same handful of templates, so the two lines
//! that matter are found by their key and their value is replaced. A file that
//! does something cleverer keeps whatever this did not recognise, and gains the
//! assignment it was missing rather than being published without one.

/// The keys this rewrites. Everything else in the file is carried through
/// untouched, including comments and formatting.
const NAME_KEY: &str = "name";
const UID_KEY: &str = "uid";

/// Rewrite `source` to declare `new_name` and `new_uid`.
///
/// `new_uid` is a parameter rather than generated here because generating one
/// is a side effect and this module is pure. The caller supplies a fresh one:
/// reusing the old uid is exactly what the vault refuses.
pub fn rename_mod_info(source: &str, new_name: &str, new_uid: &str) -> String {
    let name_value = lua_string(new_name);
    let uid_value = lua_string(new_uid);

    let mut lines: Vec<String> = Vec::new();
    let mut replaced_name = false;
    let mut replaced_uid = false;

    for line in source.lines() {
        match assignment_key(line) {
            Some(key) if key == NAME_KEY && !replaced_name => {
                replaced_name = true;
                lines.push(rewritten(line, NAME_KEY, &name_value));
            }
            Some(key) if key == UID_KEY && !replaced_uid => {
                replaced_uid = true;
                lines.push(rewritten(line, UID_KEY, &uid_value));
            }
            _ => lines.push(line.to_string()),
        }
    }

    // A file that declared neither still has to come out declaring both: the
    // upload would otherwise succeed and leave an entry the vault cannot name.
    if !replaced_name {
        lines.push(format!("{NAME_KEY} = {name_value}"));
    }
    if !replaced_uid {
        lines.push(format!("{UID_KEY} = {uid_value}"));
    }

    let mut out = lines.join("\n");
    // Keep the trailing newline the original had, so a file that was
    // well-formed stays byte-identical apart from the two values.
    if source.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// The key of a top-level assignment, if this line is one.
///
/// Deliberately narrow: the key must be the first thing on the line and the
/// next non-space character must be `=`. That leaves `description = "the name
/// = x thing"` and any commented-out line alone.
fn assignment_key(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("--") {
        return None;
    }
    let (key, rest) = trimmed.split_once('=')?;
    // `==`, `<=` and friends are comparisons, not assignments.
    if rest.starts_with('=') {
        return None;
    }
    let key = key.trim_end();
    let valid = !key.is_empty()
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !key.starts_with(|c: char| c.is_ascii_digit());
    valid.then_some(key)
}

/// Replace the value of an assignment, keeping the line's own indentation and
/// whatever trailed it, which in these files is usually a comment.
fn rewritten(line: &str, key: &str, value: &str) -> String {
    let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
    let trailing = trailing_comment(line);
    format!("{indent}{key} = {value}{trailing}")
}

/// The `-- ...` a line ends with, if any, so a note beside the name survives.
///
/// Only a comment that starts outside a quoted string: an author who wrote
/// `name = "a -- b"` has not written a comment.
fn trailing_comment(line: &str) -> String {
    let mut quote: Option<char> = None;
    let bytes: Vec<char> = line.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        let current = bytes[index];
        match quote {
            Some(open) => {
                if current == '\\' {
                    index += 2;
                    continue;
                }
                if current == open {
                    quote = None;
                }
            }
            None => {
                if current == '"' || current == '\'' {
                    quote = Some(current);
                } else if current == '-' && bytes.get(index + 1) == Some(&'-') {
                    let comment: String = bytes[index..].iter().collect();
                    return format!("  {}", comment.trim_end());
                }
            }
        }
        index += 1;
    }
    String::new()
}

/// A Lua double-quoted string literal for `value`.
///
/// Escaped rather than stripped, because a mod called `He said "no"` is a name
/// somebody may genuinely want, and a quote that got through unescaped would
/// end the string and break the file the game has to load.
fn lua_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            // A literal newline inside a quoted Lua string is a syntax error.
            '\n' | '\r' => out.push(' '),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = concat!(
        "name = \"Old Name\"\n",
        "uid = \"1111-2222\"\n",
        "version = 3\n",
        "copyright = \"\"\n",
        "description = \"Does a thing. name = not this one.\"\n",
        "author = \"Somebody\"\n",
        "icon = \"\"\n",
        "selectable = true\n",
        "enabled = true\n",
        "ui_only = true\n",
    );

    #[test]
    fn only_the_name_and_the_uid_move() {
        let out = rename_mod_info(TEMPLATE, "New Name", "3333-4444");
        assert!(out.contains(r#"name = "New Name""#), "{out}");
        assert!(out.contains(r#"uid = "3333-4444""#), "{out}");
        assert!(!out.contains("Old Name"), "{out}");
        assert!(!out.contains("1111-2222"), "{out}");
        // Everything else is carried through, including the line whose *value*
        // happens to contain an assignment.
        assert!(out.contains("version = 3"), "{out}");
        assert!(
            out.contains(r#"description = "Does a thing. name = not this one.""#),
            "{out}"
        );
        assert!(out.contains("ui_only = true"), "{out}");
        assert!(out.ends_with('\n'), "the trailing newline is kept");
    }

    #[test]
    fn indentation_and_a_note_beside_the_name_survive() {
        let out = rename_mod_info(
            "    name = \"Old\"   -- shown in the mod manager\n    uid = 'x'\n",
            "New",
            "y",
        );
        assert!(
            out.contains(r#"    name = "New"  -- shown in the mod manager"#),
            "{out}"
        );
        // A single-quoted value is replaced like any other.
        assert!(out.contains(r#"    uid = "y""#), "{out}");
    }

    #[test]
    fn a_quote_in_the_new_name_cannot_end_the_string() {
        // Unescaped, this is a Lua syntax error and the game refuses the mod.
        let out = rename_mod_info(TEMPLATE, r#"He said "no""#, "u");
        assert!(out.contains(r#"name = "He said \"no\"""#), "{out}");
    }

    #[test]
    fn a_file_missing_the_keys_comes_out_declaring_them() {
        let out = rename_mod_info("version = 1\n", "Named", "uid-1");
        assert!(out.contains(r#"name = "Named""#), "{out}");
        assert!(out.contains(r#"uid = "uid-1""#), "{out}");
        assert!(out.contains("version = 1"), "{out}");
    }

    #[test]
    fn a_commented_out_declaration_is_not_the_declaration() {
        let out = rename_mod_info("-- name = \"Draft\"\nname = \"Real\"\n", "New", "u");
        assert!(out.contains("-- name = \"Draft\""), "{out}");
        assert!(out.contains(r#"name = "New""#), "{out}");
        assert_eq!(out.matches("name = \"New\"").count(), 1, "{out}");
    }
}
