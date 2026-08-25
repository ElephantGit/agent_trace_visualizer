//! 实时监控：把增长中的 Claude Code transcript 文件以 SSE 逐行推送。
//!
//! - `GET /api/live?path=<transcript绝对路径>`：握手 `init` 事件（当前行数），
//!   随后每 500ms 轮询文件增长，新增完整行逐条以 `event` 帧推送（半行缓冲
//!   由 `LineReader` 处理），30s 心跳。
//! - `GET /api/live/latest`：返回 ~/.claude/projects 下 mtime 最新且 5 分钟
//!   内活跃的 transcript 路径（支撑前端"一键监控当前会话"）。
//!
//! 信任边界与既有端点一致：path 仅允许 ~/.claude/projects 下的 *.jsonl。

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use axum::Json;
use axum::extract::Query;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Deserialize;
use serde_json::json;

use crate::api::errors::ApiError;
use crate::util::LineReader;

/// 5 分钟内活跃视为"正在进行的会话"。
const ACTIVE_WINDOW: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

fn projects_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".claude/projects")
}

fn opencode_trace_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".local/share/opencode/trace")
}

/// path 必须落在允许的 trace 目录下且扩展名匹配（信任边界）：
/// - Claude Code：~/.claude/projects 下的 *.jsonl
/// - Opencode：~/.local/share/opencode/trace 下的 *.ndjson
fn allowed_live_path(path: &str) -> bool {
    let Ok(p) = std::fs::canonicalize(path) else {
        return false;
    };
    let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    for (root, want_ext) in [(projects_root(), "jsonl"), (opencode_trace_root(), "ndjson")] {
        if ext == want_ext && std::fs::canonicalize(&root).map(|r| p.starts_with(&r)).unwrap_or(false)
        {
            return true;
        }
    }
    false
}

// ── SSE 端点 ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LiveQuery {
    pub path: String,
}

pub async fn live_handler(
    Query(q): Query<LiveQuery>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let path = PathBuf::from(&q.path);
    if !allowed_live_path(&q.path) {
        return Err(ApiError::bad_request(
            "仅允许监控 ~/.claude/projects 下的 transcript jsonl 文件",
        ));
    }
    if !path.is_file() {
        return Err(ApiError::not_found(format!("文件不存在：{}", q.path)));
    }

    let stream = async_stream::stream! {
        let mut reader = LineReader::new();
        // 握手：当前文件行数（前端用于对齐）
        let line_count = count_lines(&path);
        tracing::info!("[live] SSE connected: path={} lineCount={line_count}", q.path);
        yield Ok(Event::default()
            .event("init")
            .data(json!({ "lineCount": line_count, "path": q.path }).to_string()));

        // 握手只发增量：从当前文件末尾开始监控
        reader.seek_end(&path);

        let mut interval = tokio::time::interval(POLL_INTERVAL);
        let mut ticks: u64 = 0;
        loop {
            interval.tick().await;
            ticks += 1;
            let file_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            match reader.read_since(&path) {
                Ok(lines) => {
                    if !lines.is_empty() {
                        tracing::debug!("[live] tick={ticks} file_len={file_len} offset={} got={}", reader.offset(), lines.len());
                    }
                    for line in lines {
                        // transcript 行均为 JSON；非 JSON 行（理论上不应出现）跳过
                        if serde_json::from_str::<serde_json::Value>(&line).is_ok() {
                            yield Ok(Event::default().event("event").data(line));
                        }
                    }
                }
                Err(e) => {
                    // 文件暂时不可读（被锁/删除）——静默等待下一轮
                    tracing::warn!("[live] read_since error: {e}");
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(30))))
}

fn count_lines(path: &Path) -> u64 {
    std::fs::read_to_string(path)
        .map(|s| s.lines().count() as u64)
        .unwrap_or(0)
}

// ── 最新活跃会话 ─────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct LiveLatest {
    pub path: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    /// 5 分钟内有写入 → true
    pub active: bool,
}

#[derive(Deserialize)]
pub struct LiveLatestQuery {
    /// claude_code（默认）| opencode
    pub agent: Option<String>,
}

pub async fn live_latest_handler(
    Query(q): Query<LiveLatestQuery>,
) -> Result<Json<LiveLatest>, ApiError> {
    let is_opencode = q.agent.as_deref() == Some("opencode");
    let root = if is_opencode {
        opencode_trace_root()
    } else {
        projects_root()
    };
    let want_ext = if is_opencode { "ndjson" } else { "jsonl" };
    let root_label = if is_opencode {
        "~/.local/share/opencode/trace 不存在"
    } else {
        "~/.claude/projects 不存在"
    };
    if !root.is_dir() {
        return Err(ApiError::not_found(root_label));
    }

    let mut best: Option<(u64, PathBuf)> = None;
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(want_ext) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let Ok(ms) = mtime
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
        else {
            continue;
        };
        if best
            .as_ref()
            .map(|(best_ms, _)| ms > *best_ms)
            .unwrap_or(true)
        {
            best = Some((ms, path.to_path_buf()));
        }
    }

    let Some((mtime_ms, path)) = best else {
        return Err(ApiError::not_found("未找到任何 transcript 文件"));
    };

    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let active = now_ms.saturating_sub(mtime_ms) <= ACTIVE_WINDOW.as_millis() as u64;

    Ok(Json(LiveLatest {
        path: path.to_string_lossy().into_owned(),
        mtime_ms,
        active,
    }))
}
