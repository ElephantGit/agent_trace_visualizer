//! Claude Code transcript listing (browse mode) + per-file session-name
//! extraction (readable labels for the file pickers instead of raw UUIDs).

use std::io::BufRead;
use std::path::Path;

use axum::Json;
use axum::extract::Query;
use serde::Deserialize;
use serde::Serialize;

use crate::api::errors::ApiError;

#[derive(Deserialize)]
pub struct TracesQuery {
    /// Root directory to scan; defaults by agent（~/.claude/projects 或
    /// ~/.local/share/opencode/trace）。
    pub root: Option<String>,
    /// claude_code（默认）| opencode——决定默认根目录与扩展名过滤。
    pub agent: Option<String>,
}

#[derive(Serialize)]
pub struct TraceEntry {
    pub path: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

fn default_root() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".claude/projects")
}

fn opencode_root() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".local/share/opencode/trace")
}

/// GET /api/traces?root=&agent= — rglob *.jsonl/*.ndjson, mtime-descending.
pub async fn traces_handler(
    Query(q): Query<TracesQuery>,
) -> Result<Json<Vec<TraceEntry>>, ApiError> {
    let is_opencode = q.agent.as_deref() == Some("opencode");
    let root = q
        .root
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            if is_opencode {
                opencode_root()
            } else {
                default_root()
            }
        });
    if !root.is_dir() {
        return Ok(Json(Vec::new()));
    }

    let mut entries: Vec<TraceEntry> = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "jsonl" && ext != "ndjson" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(TraceEntry {
            path: path.to_string_lossy().into_owned(),
            mtime_ms,
            size_bytes: meta.len(),
        });
    }

    entries.sort_by_key(|e| std::cmp::Reverse(e.mtime_ms));
    // Cap at a generous bound; the frontend paginates the rest.
    entries.truncate(5000);
    Ok(Json(entries))
}

// ── 会话名提取（文件列表可读性）───────────────────────────────

/// 会话名截断长度（首个用户输入通常很长，取前 40 字符）。
const NAME_MAX: usize = 40;

#[derive(Deserialize)]
pub struct TraceNameQuery {
    pub path: String,
    /// claude_code（默认）| opencode
    pub agent: Option<String>,
}

#[derive(Serialize)]
pub struct TraceName {
    /// 可读会话名；None = 未能提取（前端回退显示文件名）。
    pub name: Option<String>,
}

/// 从 transcript 头部提取可读会话名：
/// - claude_code：首个真实用户文本输入（会话主题，同桌面端 topic
///   自动标题的做法）；没有则回退 cwd 目录名。
/// - opencode：session.start 的 title（回退 sessionID）。
/// 只扫描文件头部（上限 512KB，逐行找，命中即停），大文件也廉价。
fn extract_trace_name(path: &Path, is_opencode: bool) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(f);
    let mut line = String::new();
    let mut scanned = 0usize;
    let mut cwd: Option<String> = None;
    while reader.read_line(&mut line).ok()? > 0 && scanned < 512 * 1024 {
        scanned += line.len();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            line.clear();
            continue;
        }
        let parsed = serde_json::from_str::<serde_json::Value>(trimmed).ok();
        line.clear();
        let Some(v) = parsed else {
            continue;
        };
        if is_opencode {
            if v.get("type").and_then(|t| t.as_str()) == Some("session.start") {
                if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                    if !t.trim().is_empty() {
                        return Some(truncate_name(t.trim()));
                    }
                }
                if let Some(id) = v.get("sessionID").and_then(|t| t.as_str()) {
                    return Some(truncate_name(id));
                }
                return None;
            }
            continue;
        }
        // claude：记录 cwd 作为回退
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.trim().is_empty() {
                    cwd = Some(c.trim().to_string());
                }
            }
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let msg = v.get("message").unwrap_or(&v);
        let content = msg.get("content").unwrap_or(&serde_json::Value::Null);
        // 字符串内容 = 直接的用户输入
        if let Some(s) = content.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(truncate_name(s));
            }
            continue;
        }
        // 块数组：取第一个 text 块（跳过 tool_result 包装）
        if let Some(blocks) = content.as_array() {
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) != Some("text") {
                    continue;
                }
                if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                    let s = s.trim();
                    if !s.is_empty() {
                        return Some(truncate_name(s));
                    }
                }
            }
        }
    }
    cwd.and_then(|c| {
        let base = Path::new(&c).file_name().map(|b| b.to_string_lossy().into_owned());
        base.filter(|b| !b.is_empty()).map(|b| truncate_name(&b))
    })
}

fn truncate_name(s: &str) -> String {
    let mut chars = s.chars();
    let mut out: String = chars.by_ref().take(NAME_MAX).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

/// GET /api/trace-name?path=&agent= — 返回单个 trace 文件的可读会话名。
pub async fn trace_name_handler(
    Query(q): Query<TraceNameQuery>,
) -> Result<Json<TraceName>, ApiError> {
    if !crate::api::live::allowed_live_path(&q.path) {
        return Err(ApiError::bad_request(
            "仅允许提取 ~/.claude/projects 或 opencode trace 目录下文件的会话名",
        ));
    }
    let is_opencode = q.agent.as_deref() == Some("opencode");
    let name = extract_trace_name(Path::new(&q.path), is_opencode);
    Ok(Json(TraceName { name }))
}

// ── 会话列表元数据（文件模式表格列）───────────────────────────

/// 5 分钟内活跃视为"进行中"（与 /api/live/latest 一致）。
const ACTIVE_WINDOW_MS: u64 = 5 * 60 * 1000;

/// 与 claude parser 的 SUBAGENT_NAMES 保持一致。
const SUBAGENT_NAMES: [&str; 6] = ["task", "Task", "delegate", "subagent", "agent", "Agent"];

/// 头部扫描上限：会话名/目录/agent 计数只在前 2MB 内统计
/// （大文件里 agent 计数为近似值，列表场景足够）。
const HEAD_SCAN_CAP: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
pub struct SessionMetaQuery {
    pub path: String,
    /// claude_code（默认）| opencode
    pub agent: Option<String>,
}

#[derive(Serialize)]
pub struct SessionMeta {
    pub name: Option<String>,
    /// 5 分钟内有写入 → true（进行中）
    pub active: bool,
    #[serde(rename = "lastActiveMs")]
    pub last_active_ms: u64,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
    /// 主 agent + 派发的 subagent 数
    #[serde(rename = "agentCount")]
    pub agent_count: u32,
    /// 会话所在目录（cwd）
    pub directory: Option<String>,
}

fn ts_of(v: &serde_json::Value) -> Option<u64> {
    // opencode：ts 为毫秒数；claude：timestamp 为 ISO 字符串
    if let Some(n) = v.get("ts").and_then(|t| t.as_u64()) {
        return Some(n);
    }
    if let Some(s) = v.get("timestamp").and_then(|t| t.as_str()) {
        if let Some(ms) = crate::util::parse_iso_epoch_ms(s) {
            return Some(ms.max(0.0) as u64);
        }
    }
    None
}

/// 从 assistant 消息的 content 块中数出 subagent 派发（claude）。
fn count_claude_dispatch(v: &serde_json::Value) -> u32 {
    let mut n = 0;
    if let Some(blocks) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for b in blocks {
            if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            if let Some(name) = b.get("name").and_then(|n| n.as_str()) {
                if SUBAGENT_NAMES.contains(&name) {
                    n += 1;
                }
            }
        }
    }
    n
}

struct SessionScan {
    name: Option<String>,
    directory: Option<String>,
    first_ts_ms: Option<u64>,
    agent_count: u32,
}

/// 单次头扫描提取会话名/cwd/首时间戳/subagent 派发数。
fn scan_head(path: &Path, is_opencode: bool) -> SessionScan {
    let mut out = SessionScan {
        name: None,
        directory: None,
        first_ts_ms: None,
        agent_count: 0,
    };
    let Ok(f) = std::fs::File::open(path) else {
        return out;
    };
    let mut reader = std::io::BufReader::new(f);
    let mut line = String::new();
    let mut scanned = 0usize;
    let mut oc_title: Option<String> = None;
    while reader.read_line(&mut line).is_ok_and(|n| n > 0) && scanned < HEAD_SCAN_CAP {
        scanned += line.len();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            line.clear();
            continue;
        }
        let parsed = serde_json::from_str::<serde_json::Value>(trimmed).ok();
        line.clear();
        let Some(v) = parsed else { continue };
        if out.first_ts_ms.is_none() {
            out.first_ts_ms = ts_of(&v);
        }
        if out.directory.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.trim().is_empty() {
                    out.directory = Some(c.trim().to_string());
                }
            }
        }
        if is_opencode {
            if v.get("type").and_then(|t| t.as_str()) == Some("session.start") {
                oc_title = v
                    .get("title")
                    .and_then(|t| t.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("tool.start")
                && v.get("tool").and_then(|t| t.as_str()) == Some("task")
            {
                out.agent_count += 1;
            }
        } else {
            out.agent_count += count_claude_dispatch(&v);
            if out.name.is_none() {
                if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                    let msg = v.get("message").unwrap_or(&v);
                    let content = msg.get("content").unwrap_or(&serde_json::Value::Null);
                    if let Some(s) = content.as_str() {
                        let s = s.trim();
                        if !s.is_empty() {
                            out.name = Some(truncate_name(s));
                        }
                    } else if let Some(blocks) = content.as_array() {
                        for b in blocks {
                            if b.get("type").and_then(|t| t.as_str()) != Some("text") {
                                continue;
                            }
                            if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                                let s = s.trim();
                                if !s.is_empty() {
                                    out.name = Some(truncate_name(s));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if is_opencode {
        out.name = oc_title.or_else(|| {
            // sessionID 兜底：从文件名取（ses_xxx.ndjson）
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(truncate_name)
        });
    }
    if out.name.is_none() {
        if let Some(dir) = &out.directory {
            if let Some(base) = Path::new(dir).file_name().and_then(|b| b.to_str()) {
                out.name = Some(truncate_name(base));
            }
        }
    }
    out
}

/// 尾扫描：最后 8KB 内最后一条带时间戳的事件。
/// 注意用 lossy 解码——8KB 边界可能切在多字节 UTF-8 字符中间。
fn scan_tail_ts(path: &Path) -> Option<u64> {
    let Ok(bytes) = std::fs::read(path) else {
        return None;
    };
    let start = bytes.len().saturating_sub(8192);
    let mut last: Option<u64> = None;
    for line in String::from_utf8_lossy(&bytes[start..]).lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if let Some(ts) = ts_of(&v) {
                last = Some(ts);
            }
        }
    }
    last
}

/// GET /api/session-meta?path=&agent= — 会话列表行的元数据。
pub async fn session_meta_handler(
    Query(q): Query<SessionMetaQuery>,
) -> Result<Json<SessionMeta>, ApiError> {
    if !crate::api::live::allowed_live_path(&q.path) {
        return Err(ApiError::bad_request(
            "仅允许提取 ~/.claude/projects 或 opencode trace 目录下文件的会话信息",
        ));
    }
    let is_opencode = q.agent.as_deref() == Some("opencode");
    let head = scan_head(Path::new(&q.path), is_opencode);
    let last_ts = scan_tail_ts(Path::new(&q.path));
    let duration_ms = match (head.first_ts_ms, last_ts) {
        (Some(a), Some(b)) if b >= a => Some(b - a),
        _ => None,
    };
    let mtime_ms = std::fs::metadata(&q.path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Json(SessionMeta {
        name: head.name,
        active: now_ms.saturating_sub(mtime_ms) <= ACTIVE_WINDOW_MS,
        last_active_ms: mtime_ms,
        duration_ms,
        agent_count: 1 + head.agent_count, // 主 agent + subagent
        directory: head.directory,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atv-trace-name-{}-{name}", std::process::id()));
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn scan_head_claude_collects_all_fields() {
        let p = write_temp(
            "meta-claude",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"你好\"},\"cwd\":\"/home/u/proj\",\"timestamp\":\"2026-01-01T10:00:00Z\",\"uuid\":\"a\"}\n\
             {\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"task\",\"input\":{}},{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Bash\",\"input\":{}}]},\"timestamp\":\"2026-01-01T10:00:02Z\",\"uuid\":\"b\"}\n",
        );
        let s = scan_head(&p, false);
        assert_eq!(s.name.as_deref(), Some("你好"));
        assert_eq!(s.directory.as_deref(), Some("/home/u/proj"));
        assert_eq!(s.agent_count, 1); // 只有 task 计入
        assert!(s.first_ts_ms.is_some());
        assert_eq!(scan_tail_ts(&p).unwrap(), s.first_ts_ms.unwrap() + 2000);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn scan_head_opencode_title_and_task_count() {
        let p = write_temp(
            "meta-oc",
            "{\"type\":\"session.start\",\"ts\":1000,\"title\":\"标题\",\"sessionID\":\"ses_x\",\"cwd\":\"/home/u/oc\"}\n\
             {\"type\":\"tool.start\",\"ts\":2000,\"tool\":\"task\",\"toolCallId\":\"a\"}\n\
             {\"type\":\"tool.start\",\"ts\":3000,\"tool\":\"bash\",\"toolCallId\":\"b\"}\n",
        );
        let s = scan_head(&p, true);
        assert_eq!(s.name.as_deref(), Some("标题"));
        assert_eq!(s.directory.as_deref(), Some("/home/u/oc"));
        assert_eq!(s.agent_count, 1); // 只有 task 计入
        assert_eq!(s.first_ts_ms, Some(1000));
        assert_eq!(scan_tail_ts(&p), Some(3000));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn session_duration_zero_for_single_event() {
        // 单事件文件：首尾时间戳相同 → duration = Some(0)
        let p = write_temp(
            "meta-nodur",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"},\"timestamp\":\"2026-01-01T10:00:00Z\",\"uuid\":\"a\"}\n",
        );
        let head = scan_head(&p, false);
        assert_eq!(
            match (head.first_ts_ms, scan_tail_ts(&p)) {
                (Some(a), Some(b)) if b >= a => Some(b - a),
                _ => None,
            },
            Some(0)
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn claude_first_user_text_is_the_name() {
        let p = write_temp(
            "user-string",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"重构项目为 Rust 后端\"},\"cwd\":\"/tmp/x\",\"uuid\":\"a\"}\n\
             {\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]},\"uuid\":\"b\"}\n",
        );
        assert_eq!(
            extract_trace_name(&p, false).as_deref(),
            Some("重构项目为 Rust 后端")
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn claude_skips_tool_result_wrappers() {
        let p = write_temp(
            "blocks",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"t\",\"type\":\"tool_result\",\"content\":\"x\"}]},\"uuid\":\"a\"}\n\
             {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"真正的用户输入\"}]},\"uuid\":\"b\"}\n",
        );
        assert_eq!(extract_trace_name(&p, false).as_deref(), Some("真正的用户输入"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn claude_falls_back_to_cwd_basename() {
        let p = write_temp(
            "cwd",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"x\"}]},\"cwd\":\"/home/u/projects/my-dashboard\",\"uuid\":\"a\"}\n",
        );
        assert_eq!(extract_trace_name(&p, false).as_deref(), Some("my-dashboard"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn opencode_uses_session_title() {
        let p = write_temp(
            "oc",
            "{\"type\":\"session.start\",\"ts\":100,\"model\":\"m\",\"sessionID\":\"ses_x\",\"title\":\"我的会话标题\"}\n",
        );
        assert_eq!(extract_trace_name(&p, true).as_deref(), Some("我的会话标题"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn long_names_are_truncated() {
        let long = "长".repeat(60);
        let p = write_temp(
            "long",
            &format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{long}\"}},\"uuid\":\"a\"}}\n"),
        );
        let name = extract_trace_name(&p, false).unwrap();
        assert_eq!(name.chars().count(), NAME_MAX + 1); // + 省略号
        assert!(name.ends_with('…'));
        std::fs::remove_file(&p).ok();
    }
}
