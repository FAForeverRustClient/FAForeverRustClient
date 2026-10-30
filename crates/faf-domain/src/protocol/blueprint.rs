//! Codec for Forged Alliance blueprints: the data-only Lua the game declares
//! its units and projectiles in.
//!
//! A blueprint file is one call, `UnitBlueprint { ... }`, whose argument is a
//! table constructor. What appears inside was surveyed over every unit
//! blueprint of the base game's `units.scd`, the installed `units.nx2`, and
//! fifteen releases of FAForever/fa between 3603 and 3840 (7082 files): nested
//! tables, named and positional fields, single- and double-quoted strings,
//! numbers, `true`/`false`/`nil`, constructor calls such as `Sound { ... }`,
//! unary minus, division (`RateOfFire = 10/10`), semicolons as separators, and
//! comments in both of the game's spellings, `--` and `#`. This parses that
//! subset, plus the rest of Lua's arithmetic and its long brackets so that a
//! file written a little differently tomorrow still reads. It is not a Lua
//! interpreter: nothing is executed, and a name that is not a constructor
//! reads as `nil`, which is what an unset global is in Lua.
//!
//! [`merged`] is the game's own `BlueprintMerged` (`lua/system/Blueprints.lua`):
//! a blueprint with `Merge = true` is laid over the one it replaces rather
//! than replacing it, which is how the oldest FAF releases changed units.

use std::fmt;

/// A blueprint value. Lua has one number type, so integers read as `f64` too.
#[derive(Debug, Clone, PartialEq)]
pub enum LuaValue {
    Bool(bool),
    Number(f64),
    String(String),
    Table(LuaTable),
}

/// A table key: a name (`Health = 300`) or a position (the second entry of a
/// list is index 2, as in Lua).
#[derive(Debug, Clone, PartialEq)]
pub enum LuaKey {
    Name(String),
    Index(i64),
}

/// A Lua table, in the order its fields were written. A key assigned twice
/// keeps the later value, and a key assigned `nil` is absent, as in Lua.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LuaTable {
    entries: Vec<(LuaKey, LuaValue)>,
}

impl LuaTable {
    pub fn get(&self, name: &str) -> Option<&LuaValue> {
        self.entries.iter().find_map(|(key, value)| match key {
            LuaKey::Name(own) if own == name => Some(value),
            _ => None,
        })
    }

    pub fn index(&self, position: i64) -> Option<&LuaValue> {
        self.entries.iter().find_map(|(key, value)| match key {
            LuaKey::Index(own) if *own == position => Some(value),
            _ => None,
        })
    }

    /// The list part: index 1, 2, ... up to the first gap, which is what
    /// Lua's `ipairs` walks.
    pub fn sequence(&self) -> impl Iterator<Item = &LuaValue> {
        (1..).map_while(move |position| self.index(position))
    }

    /// The value at a dotted path of names, `["Defense", "MaxHealth"]`.
    pub fn path(&self, names: &[&str]) -> Option<&LuaValue> {
        let (last, parents) = names.split_last()?;
        let mut table = self;
        for name in parents {
            table = table.get(name)?.as_table()?;
        }
        table.get(last)
    }

    pub fn number(&self, names: &[&str]) -> Option<f64> {
        self.path(names)?.as_number()
    }

    pub fn string(&self, names: &[&str]) -> Option<&str> {
        self.path(names)?.as_str()
    }

    pub fn table(&self, names: &[&str]) -> Option<&LuaTable> {
        self.path(names)?.as_table()
    }

    pub fn flag(&self, names: &[&str]) -> bool {
        matches!(self.path(names), Some(LuaValue::Bool(true)))
    }

    pub fn entries(&self) -> impl Iterator<Item = (&LuaKey, &LuaValue)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn set(&mut self, key: LuaKey, value: LuaValue) {
        match self.entries.iter_mut().find(|(own, _)| *own == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    pub fn remove(&mut self, key: &LuaKey) {
        self.entries.retain(|(own, _)| own != key);
    }
}

impl LuaValue {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            LuaValue::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            LuaValue::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_table(&self) -> Option<&LuaTable> {
        match self {
            LuaValue::Table(table) => Some(table),
            _ => None,
        }
    }
}

/// The value the game's merge reads as "remove this field".
const MERGE_NIL: &str = "__nil";

/// `overlay` laid over `base`, field by field and table by table, as the game
/// merges a `Merge = true` blueprint into the one it replaces. A field the
/// overlay sets to `"__nil"` is removed.
pub fn merged(base: &LuaTable, overlay: &LuaTable) -> LuaTable {
    let mut result = base.clone();
    for (key, value) in &overlay.entries {
        match value {
            LuaValue::String(text) if text == MERGE_NIL => result.remove(key),
            LuaValue::Table(table) => {
                let combined = match result
                    .entries
                    .iter()
                    .find(|(own, _)| own == key)
                    .and_then(|(_, existing)| existing.as_table())
                {
                    Some(existing) => merged(existing, table),
                    None => table.clone(),
                };
                result.set(key.clone(), LuaValue::Table(combined));
            }
            other => result.set(key.clone(), other.clone()),
        }
    }
    result
}

/// Why a blueprint could not be read, with the line it stopped on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlueprintError {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for BlueprintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

/// Read a blueprint file: the table passed to its first `...Blueprint` call.
/// The name of that call is not checked beyond its suffix, so the same reader
/// takes unit, projectile and prop blueprints.
pub fn parse_blueprint(source: &str) -> Result<LuaTable, BlueprintError> {
    let mut parser = Parser::new(source.strip_prefix('\u{feff}').unwrap_or(source));
    let head = parser.next_token()?;
    match head {
        Token::Name(name) if name.ends_with("Blueprint") => {}
        other => return Err(parser.error(format!("expected a blueprint, found {other}"))),
    }
    let call = parser.next_token()?;
    let table = match call {
        Token::Punct('{') => parser.table_body()?,
        Token::Punct('(') => {
            let value = parser.expression()?;
            parser.expect(')')?;
            match value {
                Value::Table(table) => table,
                _ => return Err(parser.error("the blueprint is not a table".into())),
            }
        }
        other => return Err(parser.error(format!("expected `{{`, found {other}"))),
    };
    Ok(table)
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Name(String),
    String(String),
    Number(f64),
    Punct(char),
    End,
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Token::Name(name) => write!(f, "`{name}`"),
            Token::String(_) => write!(f, "a string"),
            Token::Number(number) => write!(f, "`{number}`"),
            Token::Punct(c) => write!(f, "`{c}`"),
            Token::End => write!(f, "the end of the file"),
        }
    }
}

/// An expression's value while it is being read: `nil` is a value here,
/// though never one stored in a table.
enum Value {
    Nil,
    Lua(LuaValue),
    Table(LuaTable),
}

impl Value {
    fn into_lua(self) -> Option<LuaValue> {
        match self {
            Value::Nil => None,
            Value::Lua(value) => Some(value),
            Value::Table(table) => Some(LuaValue::Table(table)),
        }
    }
}

struct Parser<'a> {
    source: &'a [u8],
    text: &'a str,
    position: usize,
    line: usize,
    peeked: Option<(Token, usize)>,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            source: text.as_bytes(),
            text,
            position: 0,
            line: 1,
            peeked: None,
        }
    }

    fn error(&self, message: String) -> BlueprintError {
        BlueprintError {
            line: self.line,
            message,
        }
    }

    fn byte(&self, offset: usize) -> Option<u8> {
        self.source.get(self.position + offset).copied()
    }

    fn advance(&mut self, count: usize) {
        for _ in 0..count {
            if self.byte(0) == Some(b'\n') {
                self.line += 1;
            }
            self.position += 1;
        }
    }

    /// The level of a long bracket opening at the current position, `[[` or
    /// `[==[`, without consuming it.
    fn long_bracket_level(&self) -> Option<usize> {
        if self.byte(0) != Some(b'[') {
            return None;
        }
        let mut level = 0;
        while self.byte(1 + level) == Some(b'=') {
            level += 1;
        }
        (self.byte(1 + level) == Some(b'[')).then_some(level)
    }

    fn long_bracket(&mut self, level: usize) -> Result<String, BlueprintError> {
        self.advance(level + 2);
        let close = format!("]{}]", "=".repeat(level));
        let start = self.position;
        let Some(length) = self.text[start..].find(&close) else {
            return Err(self.error("unclosed long bracket".into()));
        };
        let content = self.text[start..start + length].to_owned();
        self.advance(length + close.len());
        // Lua drops a newline straight after the opening bracket.
        Ok(content
            .strip_prefix("\r\n")
            .or_else(|| content.strip_prefix('\n'))
            .unwrap_or(&content)
            .to_owned())
    }

    fn skip_space_and_comments(&mut self) -> Result<(), BlueprintError> {
        loop {
            match self.byte(0) {
                Some(c) if c.is_ascii_whitespace() => self.advance(1),
                Some(b'-') if self.byte(1) == Some(b'-') => {
                    self.advance(2);
                    if let Some(level) = self.long_bracket_level() {
                        self.long_bracket(level)?;
                    } else {
                        self.skip_line();
                    }
                }
                // The game's Lua also takes `#` as a line comment, and the
                // older blueprints use it throughout.
                Some(b'#') => self.skip_line(),
                _ => return Ok(()),
            }
        }
    }

    fn skip_line(&mut self) {
        while let Some(c) = self.byte(0) {
            if c == b'\n' {
                return;
            }
            self.advance(1);
        }
    }

    fn peek(&mut self) -> Result<&Token, BlueprintError> {
        if self.peeked.is_none() {
            let line = self.line;
            let token = self.scan()?;
            self.peeked = Some((token, line));
        }
        Ok(&self.peeked.as_ref().expect("just filled").0)
    }

    fn next_token(&mut self) -> Result<Token, BlueprintError> {
        match self.peeked.take() {
            Some((token, _)) => Ok(token),
            None => self.scan(),
        }
    }

    fn expect(&mut self, punct: char) -> Result<(), BlueprintError> {
        match self.next_token()? {
            Token::Punct(c) if c == punct => Ok(()),
            other => Err(self.error(format!("expected `{punct}`, found {other}"))),
        }
    }

    fn scan(&mut self) -> Result<Token, BlueprintError> {
        self.skip_space_and_comments()?;
        let Some(c) = self.byte(0) else {
            return Ok(Token::End);
        };
        match c {
            b'\'' | b'"' => self.quoted(c),
            b'[' => match self.long_bracket_level() {
                Some(level) => Ok(Token::String(self.long_bracket(level)?)),
                None => {
                    self.advance(1);
                    Ok(Token::Punct('['))
                }
            },
            b'0'..=b'9' => self.number(),
            b'.' if self.byte(1).is_some_and(|next| next.is_ascii_digit()) => self.number(),
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = self.position;
                while self
                    .byte(0)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
                {
                    self.advance(1);
                }
                Ok(Token::Name(self.text[start..self.position].to_owned()))
            }
            b'{' | b'}' | b']' | b'=' | b',' | b';' | b'(' | b')' | b'+' | b'-' | b'*' | b'/'
            | b'%' | b'^' => {
                self.advance(1);
                Ok(Token::Punct(c as char))
            }
            _ => {
                let shown = self.text[self.position..].chars().next().unwrap_or('?');
                Err(self.error(format!("unexpected `{shown}`")))
            }
        }
    }

    fn quoted(&mut self, quote: u8) -> Result<Token, BlueprintError> {
        self.advance(1);
        let mut bytes = Vec::new();
        loop {
            let Some(c) = self.byte(0) else {
                return Err(self.error("unclosed string".into()));
            };
            match c {
                b'\n' => return Err(self.error("unclosed string".into())),
                c if c == quote => {
                    self.advance(1);
                    break;
                }
                b'\\' => {
                    let escaped = self
                        .byte(1)
                        .ok_or_else(|| self.error("unclosed string".into()))?;
                    self.advance(2);
                    match escaped {
                        b'n' => bytes.push(b'\n'),
                        b't' => bytes.push(b'\t'),
                        b'r' => bytes.push(b'\r'),
                        b'a' => bytes.push(0x07),
                        b'b' => bytes.push(0x08),
                        b'f' => bytes.push(0x0c),
                        b'v' => bytes.push(0x0b),
                        b'0'..=b'9' => {
                            let mut code = u32::from(escaped - b'0');
                            for _ in 0..2 {
                                match self.byte(0) {
                                    Some(digit @ b'0'..=b'9') => {
                                        code = code * 10 + u32::from(digit - b'0');
                                        self.advance(1);
                                    }
                                    _ => break,
                                }
                            }
                            bytes.push(
                                u8::try_from(code).map_err(|_| {
                                    self.error("a character escape above 255".into())
                                })?,
                            );
                        }
                        other => bytes.push(other),
                    }
                }
                other => {
                    bytes.push(other);
                    self.advance(1);
                }
            }
        }
        Ok(Token::String(String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn number(&mut self) -> Result<Token, BlueprintError> {
        let start = self.position;
        if self.byte(0) == Some(b'0') && matches!(self.byte(1), Some(b'x' | b'X')) {
            self.advance(2);
            let digits = self.position;
            while self.byte(0).is_some_and(|c| c.is_ascii_hexdigit()) {
                self.advance(1);
            }
            return i64::from_str_radix(&self.text[digits..self.position], 16)
                .map(|value| Token::Number(value as f64))
                .map_err(|_| self.error("a malformed hexadecimal number".into()));
        }
        while self
            .byte(0)
            .is_some_and(|c| c.is_ascii_digit() || c == b'.')
        {
            self.advance(1);
        }
        if matches!(self.byte(0), Some(b'e' | b'E')) {
            self.advance(1);
            if matches!(self.byte(0), Some(b'+' | b'-')) {
                self.advance(1);
            }
            while self.byte(0).is_some_and(|c| c.is_ascii_digit()) {
                self.advance(1);
            }
        }
        let text = &self.text[start..self.position];
        text.parse::<f64>()
            .map(Token::Number)
            .map_err(|_| self.error(format!("a malformed number `{text}`")))
    }

    /// The fields of a table constructor whose `{` has been read.
    fn table_body(&mut self) -> Result<LuaTable, BlueprintError> {
        let mut table = LuaTable::default();
        let mut next_index = 1;
        loop {
            match self.peek()? {
                Token::Punct('}') => {
                    self.next_token()?;
                    return Ok(table);
                }
                Token::End => return Err(self.error("unclosed table".into())),
                _ => {}
            }
            let key_line = self.line;
            let (key, value) = match self.peek()?.clone() {
                Token::Name(name) => {
                    self.next_token()?;
                    if self.peek()? == &Token::Punct('=') {
                        self.next_token()?;
                        (Some(LuaKey::Name(name)), self.expression()?)
                    } else {
                        // A positional value that starts with a name, such as
                        // a constructor call or `true`.
                        (None, self.after_name(name)?)
                    }
                }
                Token::Punct('[') => {
                    self.next_token()?;
                    let key = self.expression()?;
                    self.expect(']')?;
                    self.expect('=')?;
                    let key = match key {
                        Value::Lua(LuaValue::String(name)) => LuaKey::Name(name),
                        Value::Lua(LuaValue::Number(number)) if number.fract() == 0.0 => {
                            LuaKey::Index(number as i64)
                        }
                        _ => {
                            return Err(BlueprintError {
                                line: key_line,
                                message: "a table key that is neither a name nor a whole number"
                                    .into(),
                            })
                        }
                    };
                    (Some(key), self.expression()?)
                }
                _ => (None, self.expression()?),
            };
            let key = key.unwrap_or_else(|| {
                let key = LuaKey::Index(next_index);
                next_index += 1;
                key
            });
            match value.into_lua() {
                Some(value) => table.set(key, value),
                None => table.remove(&key),
            }
            match self.next_token()? {
                Token::Punct(',' | ';') => {}
                Token::Punct('}') => return Ok(table),
                other => return Err(self.error(format!("expected `,` or `}}`, found {other}"))),
            }
        }
    }

    fn expression(&mut self) -> Result<Value, BlueprintError> {
        let mut left = self.term()?;
        while let Token::Punct(op @ ('+' | '-')) = *self.peek()? {
            self.next_token()?;
            let right = self.term()?;
            left = self.arithmetic(op, left, right)?;
        }
        Ok(left)
    }

    fn term(&mut self) -> Result<Value, BlueprintError> {
        let mut left = self.unary()?;
        while let Token::Punct(op @ ('*' | '/' | '%')) = *self.peek()? {
            self.next_token()?;
            let right = self.unary()?;
            left = self.arithmetic(op, left, right)?;
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Value, BlueprintError> {
        if self.peek()? == &Token::Punct('-') {
            self.next_token()?;
            let operand = self.unary()?;
            return self.arithmetic('-', Value::Lua(LuaValue::Number(0.0)), operand);
        }
        self.power()
    }

    /// Exponentiation binds tighter than unary minus on its left and looser on
    /// its right, as in Lua: `-2^2` is -4 and `2^-1` is 0.5.
    fn power(&mut self) -> Result<Value, BlueprintError> {
        let base = self.atom()?;
        if self.peek()? == &Token::Punct('^') {
            self.next_token()?;
            let exponent = self.unary()?;
            return self.arithmetic('^', base, exponent);
        }
        Ok(base)
    }

    fn arithmetic(&self, op: char, left: Value, right: Value) -> Result<Value, BlueprintError> {
        let (Value::Lua(LuaValue::Number(a)), Value::Lua(LuaValue::Number(b))) = (left, right)
        else {
            return Err(self.error(format!("`{op}` on something that is not a number")));
        };
        let result = match op {
            '+' => a + b,
            '-' => a - b,
            '*' => a * b,
            '/' => a / b,
            // Lua's modulo takes the sign of the divisor.
            '%' => a - (a / b).floor() * b,
            _ => a.powf(b),
        };
        Ok(Value::Lua(LuaValue::Number(result)))
    }

    fn atom(&mut self) -> Result<Value, BlueprintError> {
        match self.next_token()? {
            Token::Number(number) => Ok(Value::Lua(LuaValue::Number(number))),
            Token::String(text) => Ok(Value::Lua(LuaValue::String(text))),
            Token::Punct('{') => Ok(Value::Table(self.table_body()?)),
            Token::Punct('(') => {
                let value = self.expression()?;
                self.expect(')')?;
                Ok(value)
            }
            Token::Name(name) => self.after_name(name),
            other => Err(self.error(format!("expected a value, found {other}"))),
        }
    }

    /// What a name read as a value stands for: a literal, a constructor call
    /// (`Sound { ... }`, whose value is its table), or an unset global.
    fn after_name(&mut self, name: String) -> Result<Value, BlueprintError> {
        match name.as_str() {
            "true" => return Ok(Value::Lua(LuaValue::Bool(true))),
            "false" => return Ok(Value::Lua(LuaValue::Bool(false))),
            "nil" => return Ok(Value::Nil),
            _ => {}
        }
        match self.peek()?.clone() {
            Token::Punct('{') => {
                self.next_token()?;
                Ok(Value::Table(self.table_body()?))
            }
            Token::String(text) => {
                self.next_token()?;
                Ok(Value::Lua(LuaValue::String(text)))
            }
            Token::Punct('(') => {
                self.next_token()?;
                let mut first = Value::Nil;
                let mut position = 0;
                loop {
                    if self.peek()? == &Token::Punct(')') {
                        self.next_token()?;
                        break;
                    }
                    let argument = self.expression()?;
                    if position == 0 {
                        first = argument;
                    }
                    position += 1;
                    match self.next_token()? {
                        Token::Punct(',') => {}
                        Token::Punct(')') => break,
                        other => {
                            return Err(self.error(format!("expected `,` or `)`, found {other}")))
                        }
                    }
                }
                // Only the constructor shape is meaningful in a data file:
                // `Name({ ... })` stands for its table.
                Ok(first)
            }
            _ => Ok(Value::Nil),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(table: &LuaTable, path: &[&str]) -> f64 {
        table.number(path).expect("a number")
    }

    #[test]
    fn reads_the_shapes_the_game_files_use() {
        let source = "\u{feff}UnitBlueprint{
    # an old-style comment
    Description = \"<LOC uel0201_desc>Medium Tank\", -- a trailing comment
    Audio = {
        Fire = Sound { Bank = 'UELWeapon', Cue = 'UEL0201_Cannon_Sgl' },
    },
    Categories = { 'TECH1', \"LAND\"; 'UEF' },
    Defense = { Health = 300, MaxHealth = 300, RegenRate = .5 },
    Weapon = {
        { Label = 'MainGun', RateOfFire = 10/15, Offset = { 0, -0.25, 1e1 } },
    },
    Unused = nil,
    Merge = true,
}";
        let bp = parse_blueprint(source).unwrap();
        assert_eq!(
            bp.string(&["Description"]),
            Some("<LOC uel0201_desc>Medium Tank")
        );
        assert_eq!(
            bp.string(&["Audio", "Fire", "Cue"]),
            Some("UEL0201_Cannon_Sgl"),
            "a constructor call stands for its table"
        );
        let categories: Vec<_> = bp
            .table(&["Categories"])
            .unwrap()
            .sequence()
            .filter_map(LuaValue::as_str)
            .collect();
        assert_eq!(categories, ["TECH1", "LAND", "UEF"]);
        assert_eq!(number(&bp, &["Defense", "RegenRate"]), 0.5);
        let weapon = bp
            .table(&["Weapon"])
            .unwrap()
            .index(1)
            .unwrap()
            .as_table()
            .unwrap();
        assert!((number(weapon, &["RateOfFire"]) - 10.0 / 15.0).abs() < 1e-12);
        let offset: Vec<_> = weapon
            .table(&["Offset"])
            .unwrap()
            .sequence()
            .filter_map(LuaValue::as_number)
            .collect();
        assert_eq!(offset, [0.0, -0.25, 10.0]);
        assert!(bp.get("Unused").is_none(), "nil leaves the field unset");
        assert!(bp.flag(&["Merge"]));
    }

    #[test]
    fn arithmetic_follows_lua_precedence() {
        let bp = parse_blueprint(
            "UnitBlueprint { A = 1 + 2 * 3, B = -2^2, C = 2^-1, D = (1 + 1) / 4, E = 7 % 3, F = 0x10 }",
        )
        .unwrap();
        assert_eq!(number(&bp, &["A"]), 7.0);
        assert_eq!(number(&bp, &["B"]), -4.0);
        assert_eq!(number(&bp, &["C"]), 0.5);
        assert_eq!(number(&bp, &["D"]), 0.5);
        assert_eq!(number(&bp, &["E"]), 1.0);
        assert_eq!(number(&bp, &["F"]), 16.0);
    }

    #[test]
    fn strings_unescape_and_long_brackets_read_verbatim() {
        let bp = parse_blueprint(
            "ProjectileBlueprint { A = 'it\\'s', B = \"tab\\tend\", C = [[\nraw \\n]], --[==[ gone ]==] D = '\\65' }",
        )
        .unwrap();
        assert_eq!(bp.string(&["A"]), Some("it's"));
        assert_eq!(bp.string(&["B"]), Some("tab\tend"));
        assert_eq!(bp.string(&["C"]), Some("raw \\n"));
        assert_eq!(bp.string(&["D"]), Some("A"));
    }

    #[test]
    fn bracketed_keys_and_positions_mix() {
        let bp =
            parse_blueprint("UnitBlueprint { T = { 'a', ['b'] = 2, [5] = 'five', 'c' } }").unwrap();
        let table = bp.table(&["T"]).unwrap();
        assert_eq!(table.index(1).and_then(LuaValue::as_str), Some("a"));
        assert_eq!(table.index(2).and_then(LuaValue::as_str), Some("c"));
        assert_eq!(table.index(5).and_then(LuaValue::as_str), Some("five"));
        assert_eq!(table.number(&["b"]), Some(2.0));
        assert_eq!(table.sequence().count(), 2, "the list stops at the gap");
    }

    #[test]
    fn errors_name_the_line() {
        let error = parse_blueprint("UnitBlueprint {\n  A = 1,\n  B = = 2,\n}").unwrap_err();
        assert_eq!(error.line, 3);
        assert!(parse_blueprint("UnitBlueprint { A = 'open }").is_err());
        assert!(parse_blueprint("UnitBlueprint { A = 1").is_err());
        assert!(parse_blueprint("return { A = 1 }").is_err());
        assert!(parse_blueprint("UnitBlueprint { A = 'x' + 1 }").is_err());
    }

    #[test]
    fn a_merge_blueprint_overrides_field_by_field() {
        let base = parse_blueprint(
            "UnitBlueprint { Defense = { Health = 300, MaxHealth = 300, ArmorType = 'Normal' }, Display = { Mesh = 1 }, Weapon = { { Damage = 20, Label = 'Gun' } } }",
        )
        .unwrap();
        let overlay = parse_blueprint(
            "UnitBlueprint { Merge = true, Defense = { MaxHealth = 350 }, Display = '__nil', Weapon = { { Damage = 24 } } }",
        )
        .unwrap();
        let result = merged(&base, &overlay);
        assert_eq!(result.number(&["Defense", "MaxHealth"]), Some(350.0));
        assert_eq!(result.number(&["Defense", "Health"]), Some(300.0));
        assert_eq!(result.string(&["Defense", "ArmorType"]), Some("Normal"));
        assert!(result.get("Display").is_none(), "`__nil` removes a field");
        let weapon = result
            .table(&["Weapon"])
            .unwrap()
            .index(1)
            .unwrap()
            .as_table()
            .unwrap();
        assert_eq!(weapon.number(&["Damage"]), Some(24.0));
        assert_eq!(
            weapon.string(&["Label"]),
            Some("Gun"),
            "lists merge by position"
        );
    }
}
