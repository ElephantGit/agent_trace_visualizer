//! Ora embedded-iframing contract — port of `legacy/trace_viz/embedded.py`.
//!
//! Ora resolves a session id to a trace file and writes a locator JSON:
//!     <appDataDir>/dashboard/<oraSessionId>.json
//!         -> {"traceFilePath": "...", "agentType": "..."}
//!
//! The locator root mirrors Ora's Tauri `app_data_dir` for the
//! `space.ora.desktop` identifier.

use std::path::PathBuf;

use serde::Deserialize;

use crate::models::ParseResult;
use crate::parsers;

pub const ORA_APP_IDENTIFIER: &str = "space.ora.desktop";
pub const LOCATOR_SUBDIR: &str = "dashboard";

/// Conventional directory where Ora writes dashboard locators (per-OS).
pub fn locator_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA")
            && !appdata.is_empty()
        {
            return PathBuf::from(appdata)
                .join(ORA_APP_IDENTIFIER)
                .join(LOCATOR_SUBDIR);
        }
        return PathBuf::from(home)
            .join("AppData")
            .join("Roaming")
            .join(ORA_APP_IDENTIFIER)
            .join(LOCATOR_SUBDIR);
    }
    if cfg!(target_os = "macos") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(ORA_APP_IDENTIFIER)
            .join(LOCATOR_SUBDIR);
    }
    // Linux / other POSIX: XDG data home, defaulting to ~/.local/share.
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|p| p.starts_with('/'))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".local").join("share"));
    base.join(ORA_APP_IDENTIFIER).join(LOCATOR_SUBDIR)
}

#[derive(Debug, Deserialize)]
pub struct Locator {
    #[serde(rename = "traceFilePath")]
    pub trace_file_path: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
}

/// Read the locator Ora wrote for one session id; None when absent/invalid.
pub fn load_locator(session_id: &str, root: Option<&std::path::Path>) -> Option<Locator> {
    let root = root
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(locator_root);
    let locator_path = root.join(format!("{session_id}.json"));
    if !locator_path.is_file() {
        return None;
    }
    let payload: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&locator_path).ok()?).ok()?;
    let trace_file_path = payload.get("traceFilePath")?.as_str()?.to_string();
    let agent_type = payload.get("agentType")?.as_str()?.to_string();
    Some(Locator {
        trace_file_path,
        agent_type,
    })
}

/// Read the resolved trace file, None when not yet on disk.
pub fn read_trace_bytes(locator: &Locator) -> Option<Vec<u8>> {
    let path = PathBuf::from(&locator.trace_file_path);
    if !path.is_file() {
        return None;
    }
    std::fs::read(&path).ok()
}

/// One round trip mirroring `render_embedded` in legacy app.py.
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddedStatus {
    Ok,
    LocatorMissing,
    AgentMismatch,
    TraceMissing,
    ParseEmpty,
    UnsupportedAgent,
}

#[derive(serde::Serialize)]
pub struct EmbeddedResponse {
    pub status: EmbeddedStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ParseResult>,
    /// Human-readable message for the four error states (Chinese UI copy
    /// kept verbatim from legacy app.py).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn resolve_embedded(session_id: &str, agent_type: &str) -> EmbeddedResponse {
    resolve_embedded_with_root(session_id, agent_type, &locator_root())
}

/// Same flow against an explicit locator root (used by tests; production
/// passes `locator_root()`).
pub fn resolve_embedded_with_root(
    session_id: &str,
    agent_type: &str,
    root: &std::path::Path,
) -> EmbeddedResponse {
    let Some(locator) = load_locator(session_id, Some(root)) else {
        return EmbeddedResponse {
            status: EmbeddedStatus::LocatorMissing,
            result: None,
            message: Some(
                "定位器尚未生成。请先在 Ora 中打开该会话的 dashboard，让 Ora 解析并写入 trace 文件路径。"
                    .to_string(),
            ),
        };
    };
    if locator.agent_type != agent_type {
        return EmbeddedResponse {
            status: EmbeddedStatus::AgentMismatch,
            result: None,
            message: Some(format!(
                "agent_type 不一致：URL 为 {agent_type}，定位器为 {}。",
                locator.agent_type
            )),
        };
    }
    let Some(content) = read_trace_bytes(&locator) else {
        return EmbeddedResponse {
            status: EmbeddedStatus::TraceMissing,
            result: None,
            message: Some(
                "trace 文件尚未生成或为空——会话进行中或尚未产生事件，稍后再试。".to_string(),
            ),
        };
    };
    let Some(result) = parsers::parse_for_agent_type(&content, agent_type) else {
        return EmbeddedResponse {
            status: EmbeddedStatus::UnsupportedAgent,
            result: None,
            message: Some(format!("不支持的 agent_type：{agent_type}")),
        };
    };
    if result.raw_events.is_empty() {
        return EmbeddedResponse {
            status: EmbeddedStatus::ParseEmpty,
            result: None,
            message: Some("已读取 trace 文件，但未解析到任何事件。".to_string()),
        };
    }
    EmbeddedResponse {
        status: EmbeddedStatus::Ok,
        result: Some(result),
        message: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        let nonce = std::process::id();
        path.push(format!("atv-locator-test-{nonce}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn locator_roundtrip() {
        let root = temp_root();
        let trace = root.join("trace.ndjson");
        std::fs::write(
            &trace,
            b"{\"type\":\"session.start\",\"model\":\"m\",\"sessionID\":\"s\",\"title\":\"t\"}\n",
        )
        .unwrap();
        let locator = serde_json::json!({
            "traceFilePath": trace.to_str().unwrap(),
            "agentType": "opencode"
        });
        std::fs::write(root.join("sess1.json"), locator.to_string()).unwrap();

        let resp = resolve_embedded_with_root("sess1", "opencode", &root);
        assert!(matches!(resp.status, EmbeddedStatus::Ok));
        let result = resp.result.unwrap();
        assert_eq!(result.session_info.session_id, "s");
        assert_eq!(result.raw_events.len(), 1);

        // missing locator
        let resp2 = resolve_embedded_with_root("sess2", "opencode", &root);
        assert!(matches!(resp2.status, EmbeddedStatus::LocatorMissing));
        assert!(resp2.message.unwrap().contains("定位器尚未生成"));

        // agent mismatch
        let resp3 = resolve_embedded_with_root("sess1", "claude_code", &root);
        assert!(matches!(resp3.status, EmbeddedStatus::AgentMismatch));

        // trace missing
        std::fs::remove_file(&trace).unwrap();
        let resp4 = resolve_embedded_with_root("sess1", "opencode", &root);
        assert!(matches!(resp4.status, EmbeddedStatus::TraceMissing));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn session_id_validation() {
        assert!(crate::api::valid_session_id("abc-123"));
        assert!(!crate::api::valid_session_id("../etc/passwd"));
        assert!(!crate::api::valid_session_id("a/b"));
        assert!(!crate::api::valid_session_id("a\\b"));
        assert!(!crate::api::valid_session_id(""));
    }
}
