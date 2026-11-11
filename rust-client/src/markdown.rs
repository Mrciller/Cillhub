//! Chat Markdown like the web client's markdown/Markdown.tsx, parsed into plain blocks and styled
//! spans that the UI draws. Same rules and order as the web: escapes, inline code, links, masked
//! links, custom emoji (shown as :name:), <t:…> times, URLs, mentions, @everyone/@here, spoilers,
//! bold, underline, italic, strike; blocks: code fences, quotes, headers (#, ##, ###), subtext (-#), lists.
//! Not drawn: KaTeX ($…$ stays text) and tables (stay text).

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub code: bool,
    pub mention: bool,
    /// Index of the spoiler this text is in (per message, in reading order).
    pub spoiler: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub style: Style,
    /// http(s) target when the text is a link.
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Text(Vec<Span>),
    Heading(u8, Vec<Span>),
    Sub(Vec<Span>),
    /// List item: nesting depth (0..=2), marker ("•", "◦" or "3."), content.
    Item(u8, String, Vec<Span>),
    Quote(Vec<Block>),
    Code { lang: Option<String>, code: String },
}

/// Names for ids in mentions; None = unknown.
pub struct Ctx<'a> {
    pub user: &'a dyn Fn(&str) -> Option<String>,
    pub role: &'a dyn Fn(&str) -> Option<String>,
    pub channel: &'a dyn Fn(&str) -> Option<String>,
    /// Formats a unix time for <t:unix:style>.
    pub time: &'a dyn Fn(i64, char) -> String,
}

/// The URL if it is http(s), else None (like safeUrl in the web client).
pub fn safe_url(u: &str) -> Option<String> {
    let url = url::Url::parse(u).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

fn word_before(s: &str, i: usize) -> bool {
    s[..i].chars().next_back().is_some_and(is_word)
}

fn digits(s: &str) -> usize {
    s.bytes().take_while(u8::is_ascii_digit).count()
}

/// Longer content is shown as plain text after this many bytes (the hub accepts 2000 chars).
pub const MAX_PARSED_BYTES: usize = 8000;

struct Inline<'c, 'a> {
    ctx: &'c Ctx<'a>,
    out: Vec<Span>,
    spoilers: u16,
    /// Per string (address, length) and search: (searched from, first hit). See `first`.
    memo: HashMap<(usize, usize), HashMap<String, (usize, Option<usize>)>>,
}

/// What a matched rule adds: plain text, or a slice parsed again with a style (and link).
enum Act<'s> {
    Text(String, Style, Option<String>),
    Nest(&'s str, Style, Option<String>),
}

impl Inline<'_, '_> {
    /// First hit at or after byte `from` of `s` of a search whose answer depends only on the position. Remembered
    /// per string, so a missing or far delimiter is not searched for again from every later start (that made long
    /// hostile messages quadratic).
    fn first(&mut self, s: &str, from: usize, key: &str, search: impl Fn(usize) -> Option<usize>) -> Option<usize> {
        let m = self.memo.entry((s.as_ptr() as usize, s.len())).or_default();
        if let Some(&(f0, hit)) = m.get(key) {
            if from >= f0 && hit.is_none_or(|p| p >= from) {
                return hit;
            }
        }
        let hit = search(from);
        m.insert(key.to_string(), (from, hit));
        hit
    }

    /// Start (relative to `i`) of the first `delim` after `from` (content at least one char) for which `ok`
    /// (given absolute positions) holds.
    fn close(&mut self, s: &str, i: usize, from: usize, delim: &str, key: &str, ok: impl Fn(usize) -> bool) -> Option<usize> {
        let start = i + from + s[i + from..].chars().next()?.len_utf8();
        let hit = self.first(s, start, key, |f| {
            let mut j = f;
            while let Some(k) = s.get(j..)?.find(delim) {
                if ok(j + k) {
                    return Some(j + k);
                }
                j += k + 1;
            }
            None
        })?;
        Some(hit - i)
    }

    fn push(&mut self, text: &str, style: Style, link: Option<String>) {
        if text.is_empty() {
            return;
        }
        if let Some(last) = self.out.last_mut() {
            if last.style == style && last.link == link {
                last.text.push_str(text);
                return;
            }
        }
        self.out.push(Span { text: text.to_string(), style, link });
    }

    /// One rule at `i` (a starter char): bytes consumed and what to add, when it matched.
    fn rule<'s>(&mut self, s: &'s str, i: usize, st: Style) -> Option<(usize, Act<'s>)> {
        let rest = &s[i..];
        let c = rest.chars().next()?;
        let text = |t: &str, style: Style, link: Option<String>| Act::Text(t.to_string(), style, link);
        // \x escapes a non-alphanumeric, non-space char
        if c == '\\' {
            let n = rest[1..].chars().next()?;
            if !n.is_alphanumeric() && !n.is_whitespace() {
                let len = 1 + n.len_utf8();
                return Some((len, text(&rest[1..len], st, None)));
            }
        }
        if c == '`' {
            let n = rest.bytes().take_while(|&b| b == b'`').count();
            let fence = &rest[..n];
            let mut j = n;
            while let Some(pos) = self.first(s, i + j, fence, |f| s[f..].find(fence).map(|k| f + k)).map(|p| p - i) {
                let run = rest[pos..].bytes().take_while(|&b| b == b'`').count();
                let content = &rest[n..pos];
                if run == n && !content.is_empty() && !content.ends_with('`') {
                    let body = content
                        .strip_prefix(' ')
                        .and_then(|x| x.strip_suffix(' '))
                        .filter(|x| !x.is_empty())
                        .unwrap_or(content);
                    return Some((pos + n, text(body, Style { code: true, ..st }, None)));
                }
                j = pos + run;
            }
        }
        if c == '<' {
            let end = self.first(s, i, ">", |f| s[f..].find('>').map(|k| f + k))? - i;
            let tag = &rest[1..end];
            if (tag.starts_with("http://") || tag.starts_with("https://")) && !tag.contains(char::is_whitespace) {
                return Some((end + 1, text(tag, st, safe_url(tag))));
            }
            let id_ok = |id: &str| !id.is_empty() && digits(id) == id.len();
            let tr = crate::i18n::tr;
            // <@id> <@!id> <@&id> <#id>
            let mention = if let Some(id) = tag.strip_prefix("@&").filter(|id| id_ok(id)) {
                Some(format!("@{}", (self.ctx.role)(id).unwrap_or_else(|| tr("deleted-role").into())))
            } else if let Some(id) = tag.strip_prefix('@').map(|id| id.strip_prefix('!').unwrap_or(id)).filter(|id| id_ok(id)) {
                Some(format!("@{}", (self.ctx.user)(id).unwrap_or_else(|| tr("unknown-user").into())))
            } else if let Some(id) = tag.strip_prefix('#').filter(|id| id_ok(id)) {
                Some(format!("#{}", (self.ctx.channel)(id).unwrap_or_else(|| tr("unknown").into())))
            } else {
                None
            };
            if let Some(m) = mention {
                return Some((end + 1, Act::Text(m, Style { mention: true, ..st }, None)));
            }
            // <:name:id> / <a:name:id> custom emoji, shown as :name:
            let parts: Vec<&str> = tag.split(':').collect();
            if parts.len() == 3
                && (parts[0].is_empty() || parts[0] == "a")
                && (2..=32).contains(&parts[1].len())
                && parts[1].chars().all(|ch| ch.is_alphanumeric() || ch == '_')
                && id_ok(parts[2])
            {
                return Some((end + 1, Act::Text(format!(":{}:", parts[1]), st, None)));
            }
            // <t:unix> / <t:unix:style>
            let t = tag.strip_prefix("t:")?;
            let (num, style) = match t.split_once(':') {
                Some((a, b)) if b.len() == 1 && "tTdDfFR".contains(b) => (a, b.chars().next()?),
                Some(_) => return None,
                None => (t, 'f'),
            };
            let n = num.strip_prefix('-').unwrap_or(num);
            let v = num.parse::<i64>().ok().filter(|v| (1..=13).contains(&n.len()) && id_ok(n) && v.abs() <= 8_640_000_000_000)?;
            return Some((end + 1, Act::Text((self.ctx.time)(v, style), st, None)));
        }
        if c == '[' {
            let close_text = self.first(s, i, "]", |f| s[f..].find(']').map(|k| f + k))? - i;
            let label = &rest[1..close_text];
            if label.is_empty() || label.contains(['[', '\n']) || !rest[close_text..].starts_with("](") {
                return None;
            }
            let after = &rest[close_text + 2..];
            let after_lt = after.strip_prefix('<').unwrap_or(after);
            if !(after_lt.starts_with("http://") || after_lt.starts_with("https://")) {
                return None;
            }
            let at = s.len() - after_lt.len();
            let url_end = |ch: char| ch.is_whitespace() || ch == ')' || ch == '>';
            let url_len = self.first(s, at, "url-end", |f| s[f..].find(url_end).map(|k| f + k))? - at;
            let tail = &after_lt[url_len..];
            let gt = usize::from(tail.starts_with('>'));
            if !tail[gt..].starts_with(')') {
                return None;
            }
            let total = close_text + 2 + (after.len() - after_lt.len()) + url_len + gt + 1;
            let href = safe_url(&after_lt[..url_len])?;
            return Some((total, Act::Nest(label, st, Some(href))));
        }
        if c == 'h' && (rest.starts_with("http://") || rest.starts_with("https://")) && !word_before(s, i) {
            let end = rest.find(|ch: char| ch.is_whitespace() || ch == '<').unwrap_or(rest.len());
            // the last char may not be one of . , : ; " ' ) ]
            let url = rest[..end].trim_end_matches(['.', ',', ':', ';', '"', '\'', ')', ']']);
            let scheme = if url.starts_with("https") { 8 } else { 7 };
            return (url.len() > scheme).then(|| (url.len(), text(url, st, safe_url(url))));
        }
        if c == '@' && !word_before(s, i) {
            for w in ["@everyone", "@here"] {
                if rest.starts_with(w) && !rest[w.len()..].chars().next().is_some_and(is_word) {
                    return Some((w.len(), text(w, Style { mention: true, ..st }, None)));
                }
            }
        }
        let nest = |open: usize, end: usize, style: Style| Some((end + open, Act::Nest(&rest[open..end], style, None)));
        if rest.starts_with("||") {
            if let Some(e) = self.close(s, i, 2, "||", "||", |_| true) {
                self.spoilers += 1;
                return nest(2, e, Style { spoiler: Some(self.spoilers - 1), ..st });
            }
        }
        if rest.starts_with("**") {
            if let Some(e) = self.close(s, i, 2, "**", "**", |p| !s[p + 2..].starts_with('*')) {
                return nest(2, e, Style { bold: true, ..st });
            }
        }
        if rest.starts_with("__") {
            if let Some(e) = self.close(s, i, 2, "__", "__", |p| !s[p + 2..].starts_with('_')) {
                return nest(2, e, Style { underline: true, ..st });
            }
        }
        if c == '*' && rest[1..].chars().next().is_some_and(|n| !n.is_whitespace()) {
            let ok = |p: usize| {
                !s[..p].chars().next_back().is_some_and(char::is_whitespace) && !s[p + 1..].starts_with('*')
            };
            if let Some(e) = self.close(s, i, 1, "*", "*i", ok) {
                return nest(1, e, Style { italic: true, ..st });
            }
        }
        if c == '_' && !word_before(s, i) {
            if let Some(p) = self.first(s, i + 1, "_", |f| s[f..].find('_').map(|k| f + k)).map(|p| p - i).filter(|&p| p > 1) {
                if !rest[p + 1..].chars().next().is_some_and(|n| is_word(n) || n == '_') {
                    return nest(1, p, Style { italic: true, ..st });
                }
            }
        }
        if rest.starts_with("~~") {
            if let Some(e) = self.close(s, i, 2, "~~", "~~", |_| true) {
                return nest(2, e, Style { strike: true, ..st });
            }
        }
        None
    }

    fn inline(&mut self, s: &str, st: Style, link: Option<String>, depth: u8) {
        if depth > 8 {
            self.push(s, st, link);
            return;
        }
        let (mut i, mut buf) = (0, 0);
        while i < s.len() {
            let c = s[i..].chars().next().unwrap_or(' ');
            if "\\`<h@|*_~[".contains(c) {
                if let Some((n, act)) = self.rule(s, i, st) {
                    self.push(&s[buf..i], st, link.clone());
                    match act {
                        Act::Text(t, style, l) => self.push(&t, style, l.or_else(|| link.clone())),
                        Act::Nest(t, style, l) => self.inline(t, style, l.or_else(|| link.clone()), depth + 1),
                    }
                    i += n;
                    buf = i;
                    continue;
                }
            }
            i += c.len_utf8();
        }
        self.push(&s[buf..], st, link);
    }
}

fn spans(s: &str, ctx: &Ctx, spoilers: &mut u16) -> Vec<Span> {
    let mut p = Inline { ctx, out: Vec::new(), spoilers: *spoilers, memo: HashMap::new() };
    p.inline(s, Style::default(), None, 0);
    *spoilers = p.spoilers;
    p.out
}

fn blocks(src: &str, ctx: &Ctx, quoted: bool, sp: &mut u16, out: &mut Vec<Block>) {
    let lines: Vec<&str> = src.split('\n').collect();
    let mut text: Vec<&str> = Vec::new();
    let mut quote: Vec<String> = Vec::new();
    let flush_text = |text: &mut Vec<&str>, out: &mut Vec<Block>, sp: &mut u16| {
        if !text.is_empty() {
            out.push(Block::Text(spans(&text.join("\n"), ctx, sp)));
            text.clear();
        }
    };
    let flush_quote = |quote: &mut Vec<String>, out: &mut Vec<Block>, sp: &mut u16| {
        if !quote.is_empty() {
            let mut inner = Vec::new();
            blocks(&quote.join("\n"), ctx, true, sp, &mut inner);
            out.push(Block::Quote(inner));
            quote.clear();
        }
    };
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if !quoted {
            if let Some(r) = line.strip_prefix(">>> ") {
                flush_text(&mut text, out, sp);
                flush_quote(&mut quote, out, sp);
                quote.push(r.to_string());
                quote.extend(lines[i + 1..].iter().map(|l| l.to_string()));
                break;
            }
            if line.starts_with("> ") || line == ">" {
                flush_text(&mut text, out, sp);
                quote.push(line.get(2..).unwrap_or("").to_string());
                i += 1;
                continue;
            }
        }
        flush_quote(&mut quote, out, sp);
        let hashes = line.bytes().take_while(|&b| b == b'#').count();
        let indent = line.bytes().take_while(|&b| b == b' ').count();
        let body = &line[indent..];
        let depth = (indent / 2).min(2) as u8;
        let num = digits(body);
        if (1..=3).contains(&hashes) && line[hashes..].starts_with(' ') && line.len() > hashes + 1 {
            flush_text(&mut text, out, sp);
            out.push(Block::Heading(hashes as u8, spans(&line[hashes + 1..], ctx, sp)));
        } else if let Some(r) = line.strip_prefix("-# ").filter(|r| !r.is_empty()) {
            flush_text(&mut text, out, sp);
            out.push(Block::Sub(spans(r, ctx, sp)));
        } else if let Some(r) = body.strip_prefix("- ").or_else(|| body.strip_prefix("* ")).filter(|r| !r.is_empty()) {
            flush_text(&mut text, out, sp);
            let marker = if depth == 0 { "•" } else { "◦" };
            out.push(Block::Item(depth, marker.into(), spans(r, ctx, sp)));
        } else if (1..=9).contains(&num) && body[num..].starts_with(". ") && body.len() > num + 2 {
            flush_text(&mut text, out, sp);
            out.push(Block::Item(depth, format!("{}.", &body[..num]), spans(&body[num + 2..], ctx, sp)));
        } else {
            text.push(line);
        }
        i += 1;
    }
    flush_text(&mut text, out, sp);
    flush_quote(&mut quote, out, sp);
}

/// Parses a message: code fences first (```lang\n…```), Markdown blocks around them.
pub fn parse(content: &str, ctx: &Ctx) -> Vec<Block> {
    let mut cut = content.len().min(MAX_PARSED_BYTES);
    while !content.is_char_boundary(cut) {
        cut -= 1;
    }
    let (content, rest) = content.split_at(cut);
    let mut out = parse_all(content, ctx);
    if !rest.is_empty() {
        out.push(Block::Text(vec![Span { text: rest.to_string(), style: Style::default(), link: None }]));
    }
    out
}

fn parse_all(content: &str, ctx: &Ctx) -> Vec<Block> {
    let mut out = Vec::new();
    let mut sp = 0u16;
    let mut last = 0;
    let mut from = 0;
    while let Some(k) = content[from..].find("```") {
        let open = from + k;
        let mut body = open + 3;
        let lang_len = content[body..]
            .find(|c: char| !(c.is_alphanumeric() || "_+#.-".contains(c)))
            .unwrap_or(content.len() - body);
        let mut lang = None;
        if lang_len > 0 && content[body + lang_len..].starts_with('\n') {
            lang = Some(content[body..body + lang_len].to_string());
            body += lang_len + 1;
        }
        if content[body..].starts_with('\n') {
            body += 1;
        }
        let Some(end) = content[body..].find("```").map(|e| body + e) else { break };
        let before = &content[last..open];
        blocks(before.strip_suffix('\n').unwrap_or(before), ctx, false, &mut sp, &mut out);
        let code = content[body..end].strip_suffix('\n').unwrap_or(&content[body..end]);
        out.push(Block::Code { lang, code: code.to_string() });
        last = end + 3;
        if content[last..].starts_with('\n') {
            last += 1;
        }
        from = last;
    }
    blocks(&content[last..], ctx, false, &mut sp, &mut out);
    // an empty trailing text block (message ended with a fence) draws nothing
    out.retain(|b| !matches!(b, Block::Text(s) if s.is_empty()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_parse(s: &str) -> Vec<Block> {
        let user = |id: &str| (id == "42").then(|| "Alex".to_string());
        let none = |_: &str| None;
        let time = |v: i64, st: char| format!("T{v}{st}");
        parse(s, &Ctx { user: &user, role: &none, channel: &none, time: &time })
    }

    #[test]
    fn hostile_content_parses_fast() {
        let t = std::time::Instant::now();
        let blocks = ctx_parse(&"<".repeat(500_000));
        let shown: usize = blocks.iter().map(|b| match b { Block::Text(sp) => sp.iter().map(|s| s.text.len()).sum(), _ => 0 }).sum();
        assert_eq!(shown, 500_000, "nothing is lost, the rest is plain text");
        // below the cap every starter fails against the same missing (or rejected) delimiter
        for evil in ["<", "[", "*", "**", "_", "__", "||", "~~", "`", "[a](http"] {
            ctx_parse(&evil.repeat(MAX_PARSED_BYTES / evil.len()));
        }
        ctx_parse(&format!("**{}", "*".repeat(MAX_PARSED_BYTES)));
        ctx_parse(&format!("{}>", "<".repeat(MAX_PARSED_BYTES - 1)));
        assert!(t.elapsed() < std::time::Duration::from_secs(1), "{:?}", t.elapsed());
    }

    fn line(s: &str) -> Vec<Span> {
        match ctx_parse(s).remove(0) {
            Block::Text(sp) => sp,
            b => panic!("not text: {b:?}"),
        }
    }

    fn sp(text: &str, f: impl FnOnce(&mut Style)) -> Span {
        let mut style = Style::default();
        f(&mut style);
        Span { text: text.into(), style, link: None }
    }

    #[test]
    fn inline_styles_like_the_web() {
        assert_eq!(
            line("Approved. **Bold** and *italic* still render fine."),
            vec![
                sp("Approved. ", |_| {}),
                sp("Bold", |s| s.bold = true),
                sp(" and ", |_| {}),
                sp("italic", |s| s.italic = true),
                sp(" still render fine.", |_| {}),
            ]
        );
        assert_eq!(line("~~old~~"), vec![sp("old", |s| s.strike = true)]);
        assert_eq!(line("__u__"), vec![sp("u", |s| s.underline = true)]);
        assert_eq!(line("_it_"), vec![sp("it", |s| s.italic = true)]);
        assert_eq!(line("snake_case_name"), vec![sp("snake_case_name", |_| {})]);
        assert_eq!(line("`a *b*`"), vec![sp("a *b*", |s| s.code = true)]);
        assert_eq!(line("`` x ``"), vec![sp("x", |s| s.code = true)]);
        assert_eq!(line("**a *b***"), vec![sp("a ", |s| s.bold = true), sp("b", |s| { s.bold = true; s.italic = true })]);
        assert_eq!(line("2 * 3 * 4"), vec![sp("2 * 3 * 4", |_| {})]);
        assert_eq!(line("\\*not\\*"), vec![sp("*not*", |_| {})]);
        assert_eq!(line("a ** b"), vec![sp("a ** b", |_| {})]);
    }

    #[test]
    fn spoilers_links_and_mentions() {
        let s = line("||one|| and ||two||");
        assert_eq!(s[0], sp("one", |s| s.spoiler = Some(0)));
        assert_eq!(s[2], sp("two", |s| s.spoiler = Some(1)));
        let s = line("see https://example.com/a, and [docs](https://example.com/d)!");
        assert_eq!(s[1].text, "https://example.com/a");
        assert_eq!(s[1].link.as_deref(), Some("https://example.com/a"));
        assert_eq!(s[2].text, ", and ");
        assert_eq!((s[3].text.as_str(), s[3].link.as_deref()), ("docs", Some("https://example.com/d")));
        assert_eq!(s[4].text, "!");
        assert_eq!(line("[x](javascript:alert(1))")[0].link, None);
        let s = line("<@42> hi <@!7> @everyone mail@here.com");
        assert_eq!(s[0], sp("@Alex", |s| s.mention = true));
        assert_eq!(s[2].text, "@unknown-user");
        assert_eq!(s[4], sp("@everyone", |s| s.mention = true));
        assert_eq!(s[5].text, " mail@here.com");
        assert_eq!(line("<:wave:123> <t:100:t>")[0].text, ":wave: T100t");
        assert_eq!(line("a <b> c")[0].text, "a <b> c");
    }

    #[test]
    fn blocks_like_the_web() {
        let b = ctx_parse("hi\n> q1\n> q2\nafter\n```rust\nfn x() {}\n```\n# Head\n- one\n  - two\n3. three\n-# small");
        assert_eq!(b[0], Block::Text(vec![sp("hi", |_| {})]));
        assert_eq!(b[1], Block::Quote(vec![Block::Text(vec![sp("q1\nq2", |_| {})])]));
        assert_eq!(b[2], Block::Text(vec![sp("after", |_| {})]));
        assert_eq!(b[3], Block::Code { lang: Some("rust".into()), code: "fn x() {}".into() });
        assert_eq!(b[4], Block::Heading(1, vec![sp("Head", |_| {})]));
        assert_eq!(b[5], Block::Item(0, "•".into(), vec![sp("one", |_| {})]));
        assert_eq!(b[6], Block::Item(1, "◦".into(), vec![sp("two", |_| {})]));
        assert_eq!(b[7], Block::Item(0, "3.".into(), vec![sp("three", |_| {})]));
        assert_eq!(b[8], Block::Sub(vec![sp("small", |_| {})]));
        assert_eq!(b.len(), 9);
        assert_eq!(ctx_parse(">>> all\nof this"), vec![Block::Quote(vec![Block::Text(vec![sp("all\nof this", |_| {})])])]);
        assert_eq!(ctx_parse("```\nplain\n```"), vec![Block::Code { lang: None, code: "plain".into() }]);
        assert_eq!(ctx_parse("open ``` only"), vec![Block::Text(vec![sp("open ``` only", |_| {})])]);
    }
}
