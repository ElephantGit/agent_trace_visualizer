//! A/B compare payload builder — port of the computation half of
//! `legacy/trace_viz/views/compare.py`. The frontend renders this payload
//! without doing any math.

use serde::Serialize;
use serde_json::Value;

use crate::models::ParseResult;

pub const COLOR_BASELINE: &str = "#ea4335";
pub const COLOR_RTK: &str = "#0a9e6a";

// ── Payload types ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct ComparePayload {
    #[serde(rename = "summaryCards")]
    pub summary_cards: Vec<SummaryCard>,
    pub overlay: Overlay,
    #[serde(rename = "perTurn")]
    pub per_turn: Vec<PerTurnRow>,
    pub tools: Vec<ToolRow>,
    pub savings: Vec<Value>,
    pub labels: Value,
    pub detail: Vec<DetailRow>,
}

#[derive(Serialize)]
pub struct SummaryCard {
    pub title: String,
    pub val_a: f64,
    pub val_b: f64,
    pub fmt: String,
    pub lower_better: bool,
    pub str_a: String,
    pub str_b: String,
    pub delta_pct: f64, // may be +inf
    pub delta_color: String,
    pub arrow: String,
    pub desc: String,
    pub delta_str: String,
}

#[derive(Serialize)]
pub struct Overlay {
    pub turns_a: Vec<OverlayTurn>,
    pub turns_b: Vec<OverlayTurn>,
    pub annotation: Option<Value>,
}

#[derive(Serialize)]
pub struct OverlayTurn {
    pub turn_no: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

#[derive(Serialize)]
pub struct PerTurnRow {
    pub turn: u64,
    pub in_a: Option<u64>,
    pub in_b: Option<u64>,
    pub out_a: Option<u64>,
    pub out_b: Option<u64>,
    pub cache_read_a: Option<u64>,
    pub cache_read_b: Option<u64>,
    pub delta_in_a: Option<u64>,
    pub delta_in_b: Option<u64>,
}

#[derive(Serialize)]
pub struct ToolRow {
    pub name: String,
    pub count_a: u64,
    pub count_b: u64,
    pub tok_a: u64,
    pub tok_b: u64,
    pub dur_avg_a: Option<f64>,
    pub dur_avg_b: Option<f64>,
    pub delta_count: String,
    pub delta_token: String,
}

#[derive(Serialize)]
pub struct DetailRow {
    pub turn: u64,
    pub in_a: Option<String>,
    pub in_b: Option<String>,
    pub delta_in: String,
    pub out_a: Option<String>,
    pub out_b: Option<String>,
    pub delta_out: String,
    pub cache_read_a: String,
    pub cache_read_b: String,
}

// ── Entry point ────────────────────────────────────────────────

pub fn build_compare(
    result_a: &ParseResult,
    result_b: &ParseResult,
    label_a: &str,
    label_b: &str,
) -> ComparePayload {
    let turns_a = result_a.turns.clone();
    let turns_b = result_b.turns.clone();
    let tools_a = result_a.tool_calls.clone();
    let tools_b = result_b.tool_calls.clone();

    let summary_cards = summary_metrics(result_a, result_b, label_a, label_b);
    let overlay = overlay_token_trend(&turns_a, &turns_b);
    let per_turn = per_turn_comparison(&turns_a, &turns_b);
    let (tools, savings) = tool_comparison(&tools_a, &tools_b, label_a, label_b);
    let detail = detail_table(&turns_a, &turns_b, label_a, label_b);

    ComparePayload {
        summary_cards,
        overlay,
        per_turn,
        tools,
        savings,
        labels: serde_json::json!({ "a": label_a, "b": label_b }),
        detail,
    }
}

// ── Layer 1: summary cards ────────────────────────────────────

fn summary_metrics(
    a: &ParseResult,
    b: &ParseResult,
    label_a: &str,
    label_b: &str,
) -> Vec<SummaryCard> {
    let mut metrics: Vec<SummaryCard> = Vec::new();
    let ri_a = &a.result_info;
    let ri_b = &b.result_info;

    let in_a = if ri_a.total_input > 0 {
        ri_a.total_input as f64
    } else {
        a.peak_input_tokens() as f64
    };
    let in_b = if ri_b.total_input > 0 {
        ri_b.total_input as f64
    } else {
        b.peak_input_tokens() as f64
    };
    if in_a > 0.0 || in_b > 0.0 {
        metrics.push(card(
            "总 Input Tokens",
            in_a,
            in_b,
            "int",
            true,
            label_a,
            label_b,
        ));
    }

    let out_a = if ri_a.total_output > 0 {
        ri_a.total_output as f64
    } else {
        a.turns.iter().map(|t| t.output_tokens).sum::<u64>() as f64
    };
    let out_b = if ri_b.total_output > 0 {
        ri_b.total_output as f64
    } else {
        b.turns.iter().map(|t| t.output_tokens).sum::<u64>() as f64
    };
    if out_a > 0.0 || out_b > 0.0 {
        metrics.push(card(
            "总 Output Tokens",
            out_a,
            out_b,
            "int",
            true,
            label_a,
            label_b,
        ));
    }

    if (in_a + out_a) > 0.0 || (in_b + out_b) > 0.0 {
        metrics.push(card(
            "总 Tokens（In + Out）",
            in_a + out_a,
            in_b + out_b,
            "int",
            true,
            label_a,
            label_b,
        ));
    }

    let cost_a = ri_a.total_cost_usd;
    let cost_b = ri_b.total_cost_usd;
    if cost_a > 0.0 || cost_b > 0.0 {
        metrics.push(card(
            "总费用 (USD)",
            cost_a,
            cost_b,
            "cost",
            true,
            label_a,
            label_b,
        ));
    }

    let dur_a = ri_a.duration_ms as f64;
    let dur_b = ri_b.duration_ms as f64;
    if dur_a > 0.0 || dur_b > 0.0 {
        metrics.push(card(
            "总耗时",
            dur_a,
            dur_b,
            "duration",
            true,
            label_a,
            label_b,
        ));
    }

    let turns_a = a.turns.len() as f64;
    let turns_b = b.turns.len() as f64;
    if turns_a > 0.0 || turns_b > 0.0 {
        metrics.push(card(
            "LLM 推理轮次",
            turns_a,
            turns_b,
            "int",
            true,
            label_a,
            label_b,
        ));
    }

    let tc_a = a.tool_calls.len() as f64;
    let tc_b = b.tool_calls.len() as f64;
    if tc_a > 0.0 || tc_b > 0.0 {
        metrics.push(card(
            "工具调用次数",
            tc_a,
            tc_b,
            "int",
            true,
            label_a,
            label_b,
        ));
    }

    // Tool success rate (always shown; higher is better)
    metrics.push(card(
        "工具成功率 (%)",
        tool_success_rate(&a.tool_calls),
        tool_success_rate(&b.tool_calls),
        "pct",
        false,
        label_a,
        label_b,
    ));

    let sa_a = a.subagents.len() as f64;
    let sa_b = b.subagents.len() as f64;
    if sa_a > 0.0 || sa_b > 0.0 {
        metrics.push(card(
            "Subagent 派发数",
            sa_a,
            sa_b,
            "int",
            true,
            label_a,
            label_b,
        ));
    }

    metrics
}

fn tool_success_rate(tool_calls: &[crate::models::ToolCall]) -> f64 {
    if tool_calls.is_empty() {
        return 100.0;
    }
    let errors = tool_calls.iter().filter(|tc| tc.is_error).count();
    let rate = (1.0 - errors as f64 / tool_calls.len() as f64) * 100.0;
    (rate * 10.0).round() / 10.0
}

/// Python `f"{v:,}"`-style thousands grouping.
pub fn grouped(v: u64) -> String {
    let s = v.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

fn fmt_int(v: f64) -> String {
    grouped(v as u64)
}

fn fmt_cost(v: f64) -> String {
    format!("${v:.4}")
}

fn fmt_duration(ms: f64) -> String {
    if ms == 0.0 {
        return "—".into();
    }
    let s = ms / 1000.0;
    if s < 60.0 {
        format!("{s:.1}s")
    } else {
        let m = (s as i64) / 60;
        let rem = (s as i64) % 60;
        format!("{m}m {rem}s")
    }
}

fn card(
    title: &str,
    val_a: f64,
    val_b: f64,
    fmt: &str,
    lower_better: bool,
    _label_a: &str,
    _label_b: &str,
) -> SummaryCard {
    let (str_a, str_b) = match fmt {
        "int" => (fmt_int(val_a), fmt_int(val_b)),
        "cost" => (fmt_cost(val_a), fmt_cost(val_b)),
        "duration" => (fmt_duration(val_a), fmt_duration(val_b)),
        "pct" => (format!("{val_a:.1}%"), format!("{val_b:.1}%")),
        _ => (fmt_int(val_a), fmt_int(val_b)),
    };

    let delta_pct = if val_a > 0.0 {
        (val_b - val_a) / val_a * 100.0
    } else if val_b > 0.0 {
        f64::INFINITY
    } else {
        0.0
    };

    let (delta_color, arrow, desc) = if delta_pct.abs() < 0.01 {
        ("#64748b".to_string(), "→".to_string(), "持平".to_string())
    } else if (delta_pct < 0.0 && lower_better) || (delta_pct > 0.0 && !lower_better) {
        let arrow = if delta_pct < 0.0 { "↓" } else { "↑" };
        (COLOR_RTK.to_string(), arrow.to_string(), "改善".to_string())
    } else {
        let arrow = if delta_pct > 0.0 { "↑" } else { "↓" };
        let desc = if lower_better { "增加" } else { "下降" };
        (
            COLOR_BASELINE.to_string(),
            arrow.to_string(),
            desc.to_string(),
        )
    };
    let delta_str = format!("{arrow} {:.1}% {desc}", delta_pct.abs());

    SummaryCard {
        title: title.into(),
        val_a,
        val_b,
        fmt: fmt.into(),
        lower_better,
        str_a,
        str_b,
        delta_pct,
        delta_color,
        arrow,
        desc,
        delta_str,
    }
}

// ── Layer 2: overlay trend ────────────────────────────────────

fn overlay_token_trend(
    turns_a: &[crate::models::Turn],
    turns_b: &[crate::models::Turn],
) -> Overlay {
    let to_overlay = |turns: &[crate::models::Turn]| -> Vec<OverlayTurn> {
        turns
            .iter()
            .map(|t| OverlayTurn {
                turn_no: t.turn_no,
                input_tokens: t.input_tokens,
                output_tokens: t.output_tokens,
                cache_read: t.cache_read,
                cache_creation: t.cache_creation,
            })
            .collect()
    };

    let annotation = if !turns_a.is_empty() && !turns_b.is_empty() {
        let last_x = turns_a
            .last()
            .unwrap()
            .turn_no
            .max(turns_b.last().unwrap().turn_no);
        let in_a_last = value_at_or_near(turns_a, last_x);
        let in_b_last = value_at_or_near(turns_b, last_x);
        match (in_a_last, in_b_last) {
            (Some(a_last), Some(b_last)) => {
                let saving = a_last - b_last;
                if saving > 0 {
                    let pct = if a_last > 0 {
                        saving as f64 / a_last as f64 * 100.0
                    } else {
                        0.0
                    };
                    let mid_y = (a_last + b_last) / 2;
                    Some(serde_json::json!({
                        "x": last_x,
                        "y": mid_y,
                        "text": format!("节省 {} tokens<br>(−{pct:.1}%)", grouped(saving)),
                    }))
                } else {
                    None
                }
            }
            _ => None,
        }
    } else {
        None
    };

    Overlay {
        turns_a: to_overlay(turns_a),
        turns_b: to_overlay(turns_b),
        annotation,
    }
}

fn value_at_or_near(turns: &[crate::models::Turn], target_x: u64) -> Option<u64> {
    turns
        .iter()
        .find(|t| t.turn_no == target_x)
        .map(|t| t.input_tokens)
        .or_else(|| turns.last().map(|t| t.input_tokens))
}

// ── Layer 3: per-turn comparison ──────────────────────────────

fn per_turn_comparison(
    turns_a: &[crate::models::Turn],
    turns_b: &[crate::models::Turn],
) -> Vec<PerTurnRow> {
    let max_turns = turns_a
        .last()
        .map(|t| t.turn_no)
        .unwrap_or(0)
        .max(turns_b.last().map(|t| t.turn_no).unwrap_or(0));
    if max_turns == 0 {
        return Vec::new();
    }

    // input_delta = diff().fillna(first)
    let deltas = |turns: &[crate::models::Turn]| -> Vec<Option<u64>> {
        let mut out = Vec::with_capacity(turns.len());
        for (i, t) in turns.iter().enumerate() {
            if i == 0 {
                out.push(Some(t.input_tokens));
            } else {
                out.push(Some(
                    t.input_tokens.saturating_sub(turns[i - 1].input_tokens),
                ));
            }
        }
        out
    };
    let delta_a = deltas(turns_a);
    let delta_b = deltas(turns_b);

    fn get(turns: &[crate::models::Turn], t: u64) -> Option<&crate::models::Turn> {
        turns.iter().find(|x| x.turn_no == t)
    }

    (1..=max_turns)
        .map(|t| {
            let ra = get(turns_a, t);
            let rb = get(turns_b, t);
            PerTurnRow {
                turn: t,
                in_a: ra.map(|x| x.input_tokens),
                in_b: rb.map(|x| x.input_tokens),
                out_a: ra.map(|x| x.output_tokens),
                out_b: rb.map(|x| x.output_tokens),
                cache_read_a: ra.map(|x| x.cache_read),
                cache_read_b: rb.map(|x| x.cache_read),
                delta_in_a: delta_a.get((t - 1) as usize).copied().flatten(),
                delta_in_b: delta_b.get((t - 1) as usize).copied().flatten(),
            }
        })
        .collect()
}

// ── Layer 4: tool comparison ──────────────────────────────────

fn tool_comparison(
    tools_a: &[crate::models::ToolCall],
    tools_b: &[crate::models::ToolCall],
    _label_a: &str,
    _label_b: &str,
) -> (Vec<ToolRow>, Vec<Value>) {
    #[derive(Default)]
    struct Agg {
        count: u64,
        tokens: u64,
        dur_sum: f64,
        dur_n: u64,
    }

    let agg = |tools: &[crate::models::ToolCall]| -> std::collections::HashMap<String, Agg> {
        let mut m: std::collections::HashMap<String, Agg> = Default::default();
        for tc in tools {
            let e = m.entry(tc.name.clone()).or_default();
            e.count += 1;
            e.tokens += tc.tiktoken_tokens;
            if tc.duration_ms > 0.0 {
                e.dur_sum += tc.duration_ms;
                e.dur_n += 1;
            }
        }
        m
    };

    let agg_a = agg(tools_a);
    let agg_b = agg(tools_b);
    let has_duration = (agg_a.values().any(|a| a.dur_n > 0) || agg_b.values().any(|b| b.dur_n > 0))
        && (tools_a.iter().any(|t| t.duration_ms > 0.0)
            || tools_b.iter().any(|t| t.duration_ms > 0.0));

    let mut all_tools: Vec<&String> = agg_a.keys().chain(agg_b.keys()).collect();
    all_tools.sort();
    all_tools.dedup();

    let mut rows = Vec::new();
    let mut savings = Vec::new();
    for tool in all_tools {
        let ra = agg_a.get(tool);
        let rb = agg_b.get(tool);
        let count_a = ra.map(|x| x.count).unwrap_or(0);
        let count_b = rb.map(|x| x.count).unwrap_or(0);
        let tok_a = ra.map(|x| x.tokens).unwrap_or(0);
        let tok_b = rb.map(|x| x.tokens).unwrap_or(0);
        let dur_avg_a = ra
            .filter(|_| has_duration)
            .and_then(|x| (x.dur_n > 0).then(|| x.dur_sum / x.dur_n as f64));
        let dur_avg_b = rb
            .filter(|_| has_duration)
            .and_then(|x| (x.dur_n > 0).then(|| x.dur_sum / x.dur_n as f64));
        rows.push(ToolRow {
            name: tool.clone(),
            count_a,
            count_b,
            tok_a,
            tok_b,
            dur_avg_a,
            dur_avg_b,
            delta_count: delta_str(count_a as f64, count_b as f64, true),
            delta_token: if tok_a > 0 {
                delta_pct(tok_a as f64, tok_b as f64)
            } else {
                String::new()
            },
        });
        // savings: diff > 0 per tool (sorted by name, same iteration order)
        let diff = tok_a as i64 - tok_b as i64;
        if diff > 0 {
            savings.push(serde_json::json!({"name": tool, "savedTokens": diff}));
        }
    }

    let _ = (_label_a, _label_b); // labels ship in payload.labels
    (rows, savings)
}

// ── Layer 5: detail table ─────────────────────────────────────

fn detail_table(
    turns_a: &[crate::models::Turn],
    turns_b: &[crate::models::Turn],
    _label_a: &str,
    _label_b: &str,
) -> Vec<DetailRow> {
    if turns_a.is_empty() || turns_b.is_empty() {
        return Vec::new();
    }
    let max_turns = turns_a
        .last()
        .unwrap()
        .turn_no
        .max(turns_b.last().unwrap().turn_no);
    fn get(turns: &[crate::models::Turn], t: u64) -> Option<&crate::models::Turn> {
        turns.iter().find(|x| x.turn_no == t)
    }

    (1..=max_turns)
        .map(|t| {
            let ra = get(turns_a, t);
            let rb = get(turns_b, t);
            let fmt_opt = |v: Option<u64>| v.map(grouped);
            DetailRow {
                turn: t,
                in_a: fmt_opt(ra.map(|x| x.input_tokens)),
                in_b: fmt_opt(rb.map(|x| x.input_tokens)),
                delta_in: match (ra, rb) {
                    (Some(x), Some(y)) => {
                        delta_str(x.input_tokens as f64, y.input_tokens as f64, true)
                    }
                    _ => "—".into(),
                },
                out_a: fmt_opt(ra.map(|x| x.output_tokens)),
                out_b: fmt_opt(rb.map(|x| x.output_tokens)),
                delta_out: match (ra, rb) {
                    (Some(x), Some(y)) => {
                        delta_str(x.output_tokens as f64, y.output_tokens as f64, true)
                    }
                    _ => "—".into(),
                },
                cache_read_a: ra
                    .filter(|x| x.cache_read > 0)
                    .map(|x| grouped(x.cache_read))
                    .unwrap_or_else(|| "0".into()),
                cache_read_b: rb
                    .filter(|x| x.cache_read > 0)
                    .map(|x| grouped(x.cache_read))
                    .unwrap_or_else(|| "0".into()),
            }
        })
        .collect()
}

// ── Helpers ───────────────────────────────────────────────────

/// Port of `_delta_str`.
fn delta_str(val_a: f64, val_b: f64, lower_better: bool) -> String {
    if val_a == 0.0 {
        return "—".into();
    }
    let delta = val_b - val_a;
    let pct = delta / val_a * 100.0;
    if pct.abs() < 0.1 {
        return "→ 持平".into();
    }
    let arrow = if delta < 0.0 { "↓" } else { "↑" };
    let improved = (delta < 0.0 && lower_better) || (delta > 0.0 && !lower_better);
    format!(
        "{arrow} {:.1}% {}",
        pct.abs(),
        if improved { "✅" } else { "⚠️" }
    )
}

/// Port of `_delta_pct`.
fn delta_pct(val_a: f64, val_b: f64) -> String {
    if val_a == 0.0 {
        return "—".into();
    }
    let delta = (val_b - val_a) / val_a * 100.0;
    if delta.abs() < 0.1 {
        return "持平".into();
    }
    let arrow = if delta < 0.0 { "↓" } else { "↑" };
    format!("{arrow} {:.1}%", delta.abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ParseResult, ResultInfo, ToolCall, Turn};

    fn result_with(turns: Vec<Turn>, tools: Vec<ToolCall>, total_input: u64) -> ParseResult {
        ParseResult {
            source: "claude_code".into(),
            turns,
            tool_calls: tools,
            result_info: ResultInfo {
                total_input,
                total_output: 200,
                duration_ms: 60_000,
                total_cost_usd: 0.5,
                num_turns: 2,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn turn(no: u64, input: u64, output: u64) -> Turn {
        Turn {
            turn_no: no,
            input_tokens: input,
            output_tokens: output,
            ..Default::default()
        }
    }

    #[test]
    fn delta_strings_match_legacy() {
        assert_eq!(delta_str(100.0, 50.0, true), "↓ 50.0% ✅");
        assert_eq!(delta_str(100.0, 150.0, true), "↑ 50.0% ⚠️");
        assert_eq!(delta_str(0.0, 10.0, true), "—");
        assert_eq!(delta_str(100.0, 100.1, true), "→ 持平");
        assert_eq!(delta_pct(100.0, 60.0), "↓ 40.0%");
    }

    #[test]
    fn compare_payload_shape() {
        let a = result_with(vec![turn(1, 1000, 100), turn(2, 1500, 150)], vec![], 1500);
        let b = result_with(vec![turn(1, 800, 90), turn(2, 1100, 120)], vec![], 1100);
        let payload = build_compare(&a, &b, "无 RTK", "有 RTK");

        // summary: input + output + total + cost + duration + turns (+success rate)
        assert!(payload.summary_cards.len() >= 6);
        assert_eq!(payload.summary_cards[0].title, "总 Input Tokens");
        assert_eq!(payload.summary_cards[0].str_a, "1,500");
        assert!(payload.summary_cards[0].delta_str.contains("↓"));

        // overlay annotation: baseline 1500 vs rtk 1100 at last turn
        let ann = payload.overlay.annotation.as_ref().unwrap();
        assert_eq!(ann["x"], 2);
        assert_eq!(ann["y"], 1300);

        // per turn
        assert_eq!(payload.per_turn.len(), 2);
        assert_eq!(payload.per_turn[0].delta_in_a, Some(1000));
        assert_eq!(payload.per_turn[1].delta_in_a, Some(500));

        // detail rows with delta strings
        assert_eq!(payload.detail.len(), 2);
        assert!(payload.detail[1].delta_in.starts_with('↓'));
    }

    #[test]
    fn tool_savings_only_positive() {
        let tools_a = vec![
            ToolCall {
                name: "read".into(),
                tiktoken_tokens: 500,
                ..Default::default()
            },
            ToolCall {
                name: "grep".into(),
                tiktoken_tokens: 100,
                ..Default::default()
            },
        ];
        let tools_b = vec![ToolCall {
            name: "read".into(),
            tiktoken_tokens: 300,
            ..Default::default()
        }];
        let (rows, savings) = tool_comparison(&tools_a, &tools_b, "a", "b");
        assert_eq!(rows.len(), 2);
        // read: 500-300=200; grep only in a: 100-0=100 — both positive
        assert_eq!(savings.len(), 2);
        assert_eq!(savings[0]["name"], "grep");
        assert_eq!(savings[0]["savedTokens"], 100);
        assert_eq!(savings[1]["name"], "read");
        assert_eq!(savings[1]["savedTokens"], 200);
        // negative savings never appear: give b more tokens on read
        let tools_b2 = vec![ToolCall {
            name: "read".into(),
            tiktoken_tokens: 900,
            ..Default::default()
        }];
        let (_, savings2) = tool_comparison(&tools_a, &tools_b2, "a", "b");
        assert_eq!(savings2.len(), 1); // only grep remains positive
    }
}
