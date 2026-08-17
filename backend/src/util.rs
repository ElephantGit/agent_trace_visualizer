//! Shared utilities: coercion, NDJSON loading, text sanitization, formatting.
//! Port of `legacy/trace_viz/utils.py`.

use serde_json::Value;

// ── Value coercion ────────────────────────────────────────────

/// Python `str()`-like coercion of a JSON value: None/absent → "", strings
/// pass through, dict/list render as compact JSON (ensure_ascii=false).
pub fn py_str(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "True".into()
            } else {
                "False".into()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Coerce any value to a plain string — port of `to_str` in utils.py.
pub fn to_str(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "True".into()
            } else {
                "False".into()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Python truthiness for JSON values (`x or y` chains in the parsers).
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => !n.as_f64().is_some_and(|f| f == 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `a or b`-style fallback: returns `a` when Python-truthy, else `b`.
pub fn or_value<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if is_truthy(a) { a } else { b }
}

/// Serialize JSON the way Python's `json.dumps(v, ensure_ascii=False)` does:
/// `, ` and `: ` separators (the default), no ASCII escaping of non-ASCII.
pub fn py_dumps(value: &Value) -> String {
    use serde_json::ser::Formatter;
    use std::io::Write;

    struct PyStyle;
    impl Formatter for PyStyle {
        fn begin_array_value<W: ?Sized + Write>(
            &mut self,
            writer: &mut W,
            first: bool,
        ) -> std::io::Result<()> {
            if first {
                Ok(())
            } else {
                writer.write_all(b", ")
            }
        }
        fn begin_object_key<W: ?Sized + Write>(
            &mut self,
            writer: &mut W,
            first: bool,
        ) -> std::io::Result<()> {
            if first {
                Ok(())
            } else {
                writer.write_all(b", ")
            }
        }
        fn begin_object_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> std::io::Result<()> {
            writer.write_all(b": ")
        }
    }

    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, PyStyle);
    serde::Serialize::serialize(value, &mut ser).expect("Value serialization cannot fail");
    String::from_utf8(buf).expect("JSON output is valid UTF-8")
}

// ── Text helpers ──────────────────────────────────────────────

/// Try common encodings in order; return None if all fail.
/// Port of `decode_bytes` (utf-8, utf-8-sig, utf-16, latin-1).
pub fn decode_bytes(content: &[u8]) -> Option<String> {
    // utf-8 (BOM retained, same as Python's "utf-8" codec)
    if let Ok(s) = std::str::from_utf8(content) {
        return Some(s.to_string());
    }
    // utf-8-sig (strip BOM)
    if let Ok(s) = std::str::from_utf8(content.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(content))
    {
        return Some(s.to_string());
    }
    // utf-16 with BOM sniffing (Python's "utf-16" codec: BOM or native LE)
    if content.len() >= 2 && content.len().is_multiple_of(2) {
        let (le, bytes) = if content[0] == 0xFE && content[1] == 0xFF {
            (false, &content[2..])
        } else if content[0] == 0xFF && content[1] == 0xFE {
            (true, &content[2..])
        } else {
            (true, content) // native order on x86_64 is LE
        };
        let (text, _, had_errors) = if le {
            encoding_rs::UTF_16LE.decode(bytes)
        } else {
            encoding_rs::UTF_16BE.decode(bytes)
        };
        if !had_errors {
            return Some(text.into_owned());
        }
    }
    // latin-1 never fails (all 256 byte values are valid)
    let (text, _, _) = encoding_rs::WINDOWS_1252.decode(content);
    Some(text.into_owned())
}

/// Parse NDJSON bytes into a list of JSON values, silently dropping malformed
/// lines — port of `load_ndjson`.
pub fn load_ndjson(content: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(content);
    let mut events = Vec::new();
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str(line) {
            events.push(v);
        }
    }
    events
}

/// Human-readable duration from milliseconds — port of `format_duration`.
pub fn format_duration(ms: f64) -> String {
    if ms == 0.0 {
        return "—".to_string();
    }
    let s = ms / 1000.0;
    if s < 60.0 {
        return format!("{s:.1}s");
    }
    let m = (s as i64) / 60;
    let rem = (s as i64) % 60;
    format!("{m}m {rem}s")
}

// ── Mermaid sanitization ──────────────────────────────────────

/// Make a string safe for use in a Mermaid diagram label.
/// Port of `sanitize_mermaid`: the translate table is security-critical — the
/// six smart/fullwidth quote forms would otherwise terminate Mermaid's
/// double-quoted label mid-string ("Syntax error in text").
pub fn sanitize_mermaid(text: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.trim().chars() {
        let mapped = match ch {
            '"' => "'",
            ':' => "：",
            '\n' => " ",
            '[' => "(",
            ']' => ")",
            ';' => ",",
            '#' => "",
            '<' => "＜",
            '>' => "＞",
            '&' => "＆",
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' | '\u{ff02}' | '\u{2018}'
            | '\u{2019}' | '\u{201a}' | '\u{201b}' => "'",
            _ => {
                out.push(ch);
                continue;
            }
        };
        out.push_str(mapped);
    }
    if out.chars().count() > max_len {
        let truncated: String = out.chars().take(max_len).collect();
        return format!("{truncated}…");
    }
    out
}

/// Return a Mermaid-safe double-quoted label — port of `mermaid_quote`.
pub fn mermaid_quote(text: &str) -> String {
    format!("\"{}\"", sanitize_mermaid(text, 50))
}

// ── Timestamps ────────────────────────────────────────────────

/// Millisecond delta between two ISO-8601-ish timestamp strings.
/// Port of `_ts_delta_ms`: Python uses `datetime.fromisoformat` with
/// `Z → +00:00`; we accept RFC3339 and two naive formats, defaulting to 0.0.
pub fn ts_delta_ms(ts_start: Option<&str>, ts_end: Option<&str>) -> f64 {
    let (Some(start), Some(end)) = (ts_start, ts_end) else {
        return 0.0;
    };
    let t1 = parse_iso_epoch_ms(start);
    let t2 = parse_iso_epoch_ms(end);
    match (t1, t2) {
        (Some(a), Some(b)) => (b - a).max(0.0),
        _ => 0.0,
    }
}

/// Parse a timestamp the way Python `datetime.fromisoformat` (with
/// `Z → +00:00` replacement) accepts it. Returns epoch milliseconds.
pub fn parse_iso_epoch_ms(ts: &str) -> Option<f64> {
    use chrono::{DateTime, NaiveDateTime};

    let normalized = ts.trim().replace('Z', "+00:00");
    if let Ok(dt) = DateTime::parse_from_rfc3339(&normalized) {
        return Some(dt.timestamp_millis() as f64);
    }
    // fromisoformat also accepts space-separated naive datetimes and no
    // fractional part; treat naive as UTC (matching pandas utc=True usage).
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ] {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(&normalized, fmt) {
            return Some(ndt.and_utc().timestamp_millis() as f64);
        }
    }
    // RFC3339 without colon in the offset (e.g. "+0000") — chrono accepts
    // this in the from_rfc3339 lenient path? Not always; try manual strip.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_table_covers_dangerous_quotes() {
        assert_eq!(sanitize_mermaid("a\"b", 50), "a'b");
        assert_eq!(sanitize_mermaid("“smart” ‘quotes’", 50), "'smart' 'quotes'");
        // '#' is removed (no space), ';' becomes ','.
        assert_eq!(
            sanitize_mermaid("a:b\nc[d]e;f#g<h>i&j", 50),
            "a：b c(d)e,fg＜h＞i＆j"
        );
        assert_eq!(sanitize_mermaid("abcdef", 3), "abc…");
        assert_eq!(sanitize_mermaid("  pad  ", 50), "pad");
    }

    #[test]
    fn mermaid_quote_wraps() {
        assert_eq!(mermaid_quote("x"), "\"x\"");
    }

    #[test]
    fn truthiness_matches_python() {
        assert!(!is_truthy(&json!(null)));
        assert!(!is_truthy(&json!(0)));
        assert!(!is_truthy(&json!("")));
        assert!(!is_truthy(&json!([])));
        assert!(!is_truthy(&json!({})));
        assert!(!is_truthy(&json!(false)));
        assert!(is_truthy(&json!(1)));
        assert!(is_truthy(&json!("0")));
        assert!(is_truthy(&json!([1])));
    }

    #[test]
    fn duration_formatting() {
        assert_eq!(format_duration(0.0), "—");
        assert_eq!(format_duration(1500.0), "1.5s");
        assert_eq!(format_duration(90_000.0), "1m 30s");
    }

    #[test]
    fn ts_delta_basic() {
        let a = "2025-01-01T10:00:00Z";
        let b = "2025-01-01T10:00:01.500Z";
        assert_eq!(ts_delta_ms(Some(a), Some(b)), 1500.0);
        assert_eq!(ts_delta_ms(None, Some(b)), 0.0);
        // naive format
        assert_eq!(
            ts_delta_ms(Some("2025-01-01 10:00:00"), Some("2025-01-01 10:00:02")),
            2000.0
        );
    }

    #[test]
    fn decode_bytes_encodings() {
        assert_eq!(decode_bytes("héllo".as_bytes()).unwrap(), "héllo");
        // utf-16 LE with BOM
        let mut utf16 = vec![0xFF, 0xFE];
        for u in "héllo".encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_bytes(&utf16).unwrap(), "héllo");
        // 2 bytes decode as UTF-16LE (U+E968) before latin-1 is tried —
        // same order as Python's codec list.
        assert_eq!(decode_bytes(&[0x68, 0xE9]).unwrap(), "\u{e968}");
        // Odd length skips utf-16 → latin-1 fallback.
        assert_eq!(decode_bytes(&[0x68, 0xE9, 0x21]).unwrap(), "hé!");
    }

    #[test]
    fn load_ndjson_drops_malformed() {
        let content = b"{\"a\":1}\nnot json\n  \n{\"b\":2}";
        let events = load_ndjson(content);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["a"], 1);
    }
}
