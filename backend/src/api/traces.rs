//! Claude Code transcript listing (browse mode).

use axum::Json;
use axum::extract::Query;
use serde::Deserialize;
use serde::Serialize;

use crate::api::errors::ApiError;

#[derive(Deserialize)]
pub struct TracesQuery {
    /// Root directory to scan; defaults to ~/.claude/projects.
    pub root: Option<String>,
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

/// GET /api/traces?root= — rglob *.jsonl, mtime-descending.
pub async fn traces_handler(
    Query(q): Query<TracesQuery>,
) -> Result<Json<Vec<TraceEntry>>, ApiError> {
    let root = q
        .root
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_root);
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
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
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
