//! Workflow tree extraction + ReactFlow JSON loading — port of
//! `legacy/trace_viz/views/workflow.py` (rendering lives on the frontend).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::models::{ParseResult, WorkflowNode};
use crate::parsers;
use crate::util::py_str;

// ── Path constants ────────────────────────────────────────────

fn oc_trace_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".local/share/opencode/trace")
}

fn default_reactflow_path() -> PathBuf {
    std::env::var("REACTFLOW_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("assets/reactflow.json"))
}

/// Load a ReactFlow JSON file; None when absent/invalid. Must contain both
/// "nodes" and "edges" keys.
pub fn load_reactflow_json(path: Option<&Path>) -> Option<Value> {
    let filepath = path
        .map(Path::to_path_buf)
        .unwrap_or_else(default_reactflow_path);
    if !filepath.is_file() {
        return None;
    }
    let data: Value = serde_json::from_str(&std::fs::read_to_string(&filepath).ok()?).ok()?;
    if data.get("nodes").is_some() && data.get("edges").is_some() {
        Some(data)
    } else {
        None
    }
}

// ── Trace workflow build ──────────────────────────────────────

/// From a ParseResult build the workflow tree. None when there is no
/// subagent activity.
pub fn build_workflow(result: &ParseResult) -> Option<WorkflowNode> {
    if result.raw_events.is_empty() {
        return None;
    }
    match result.source.as_str() {
        "opencode" => Some(build_opencode(result)),
        "claude_code" => Some(build_claude_code(result)),
        _ => None,
    }
}

fn build_opencode(result: &ParseResult) -> WorkflowNode {
    let si = &result.session_info;
    let mut root = WorkflowNode {
        id: if si.session_id.is_empty() {
            "root".into()
        } else {
            si.session_id.clone()
        },
        name: if !si.title.is_empty() {
            si.title.clone()
        } else if !si.model.is_empty() {
            si.model.clone()
        } else {
            "主 Agent".into()
        },
        description: "主会话".into(),
        state: "completed".into(),
        parent_id: None,
        global_step: 0,
        duration_ms: Some(result.result_info.duration_ms),
        tool_count: result.tool_calls.len() as u64,
        input_tokens: result.result_info.total_input,
        output_tokens: result.result_info.total_output,
        is_root: true,
        ..Default::default()
    };
    for sub in &result.subagents {
        if let Some(child) = build_subagent_node(sub) {
            root.children.push(child);
            let last = root.children.last_mut().unwrap();
            load_child_worktree(last, 1, 3);
        }
    }
    root
}

fn build_claude_code(result: &ParseResult) -> WorkflowNode {
    let si = &result.session_info;
    let cwd = result
        .parse_debug
        .get("cwd")
        .map(py_str)
        .unwrap_or_default();
    let mut root = WorkflowNode {
        id: if si.session_id.is_empty() {
            "root".into()
        } else {
            si.session_id.clone()
        },
        name: if !cwd.is_empty() {
            cwd
        } else if !si.model.is_empty() {
            si.model.clone()
        } else {
            "Claude Code".into()
        },
        description: "主会话".into(),
        state: if result.result_info.is_error {
            "error".into()
        } else {
            "completed".into()
        },
        parent_id: None,
        global_step: 0,
        duration_ms: Some(result.result_info.duration_ms),
        tool_count: result.tool_calls.len() as u64,
        input_tokens: result.result_info.total_input,
        output_tokens: result.result_info.total_output,
        is_root: true,
        ..Default::default()
    };
    for sub in &result.subagents {
        if let Some(child) = build_subagent_node(sub) {
            root.children.push(child);
            let last = root.children.last_mut().unwrap();
            last.parent_id = Some(root.id.clone());
        }
    }
    root
}

fn build_subagent_node(sub: &Value) -> Option<WorkflowNode> {
    let child_id = sub.get("childSessionID").map(py_str).unwrap_or_default();
    let name = sub.get("agentName").map(py_str).unwrap_or_default();
    let name = if name.is_empty() {
        "unnamed".to_string()
    } else {
        name
    };
    let state = sub
        .get("state")
        .map(py_str)
        .unwrap_or_else(|| "unknown".into());
    let description = sub.get("description").map(py_str).unwrap_or_default();
    let step = sub.get("globalStep").and_then(Value::as_u64).unwrap_or(0);
    let dur = sub.get("dispatchDurationMs").and_then(Value::as_i64);
    Some(WorkflowNode {
        id: if child_id.is_empty() {
            format!("sub_{step}_{name}")
        } else {
            child_id
        },
        name,
        description,
        state,
        parent_id: None,
        global_step: step,
        duration_ms: dur,
        ..Default::default()
    })
}

fn load_child_worktree(node: &mut WorkflowNode, depth: usize, max_depth: usize) {
    if depth >= max_depth || node.id.is_empty() || !node.id.starts_with("ses_") {
        return;
    }
    let child_path = oc_trace_dir().join(format!("{}.ndjson", node.id));
    if !child_path.is_file() {
        return;
    }
    let child_result = match std::fs::read(&child_path) {
        Ok(bytes) => parsers::opencode::parse(&bytes),
        Err(_) => return,
    };
    if node.tool_count == 0 {
        node.tool_count = child_result.tool_calls.len() as u64;
    }
    if node.input_tokens == 0 {
        node.input_tokens = child_result.result_info.total_input;
    }
    if node.output_tokens == 0 {
        node.output_tokens = child_result.result_info.total_output;
    }
    if node.duration_ms.is_none() {
        node.duration_ms = Some(child_result.result_info.duration_ms);
    }
    for sub in &child_result.subagents {
        if let Some(child) = build_subagent_node(sub) {
            node.children.push(child);
            let last = node.children.last_mut().unwrap();
            last.parent_id = Some(node.id.clone());
            let depth = depth + 1;
            load_child_worktree(last, depth, max_depth);
        }
    }
}

/// Estimate longest-path depth of a ReactFlow DAG (topo sort + DP).
pub fn estimate_dag_depth(nodes: &[Value], edges: &[Value]) -> usize {
    if nodes.is_empty() {
        return 0;
    }
    use std::collections::{HashMap, VecDeque};

    let mut node_ids = std::collections::HashSet::new();
    for n in nodes {
        if let Some(id) = n.get("id").and_then(Value::as_str) {
            node_ids.insert(id.to_string());
        }
    }
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    let mut indeg: HashMap<String, usize> = HashMap::new();
    for nid in &node_ids {
        adj.insert(nid.clone(), Vec::new());
        indeg.insert(nid.clone(), 0);
    }
    for e in edges {
        let (Some(src), Some(tgt)) = (
            e.get("source").and_then(Value::as_str),
            e.get("target").and_then(Value::as_str),
        ) else {
            continue;
        };
        if node_ids.contains(src) && node_ids.contains(tgt) {
            adj.get_mut(src).unwrap().push(tgt.to_string());
            *indeg.get_mut(tgt).unwrap() += 1;
        }
    }

    let mut depth: HashMap<String, usize> = HashMap::new();
    let mut queue: VecDeque<String> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(n, _)| n.clone())
        .collect();
    for nid in &queue {
        depth.insert(nid.clone(), 1);
    }
    while let Some(u) = queue.pop_front() {
        let du = depth[&u];
        for v in adj[&u].clone() {
            let dv = depth.entry(v.clone()).or_insert(0);
            *dv = (*dv).max(du + 1);
            let e = indeg.get_mut(&v).unwrap();
            *e -= 1;
            if *e == 0 {
                queue.push_back(v);
            }
        }
    }

    if depth.is_empty() {
        nodes.len().max(1)
    } else {
        depth.values().copied().max().unwrap_or(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dag_depth_topo() {
        let nodes = vec![
            json!({"id": "a"}),
            json!({"id": "b"}),
            json!({"id": "c"}),
            json!({"id": "d"}),
        ];
        let edges = vec![
            json!({"source": "a", "target": "b"}),
            json!({"source": "a", "target": "c"}),
            json!({"source": "b", "target": "d"}),
            json!({"source": "c", "target": "d"}),
        ];
        assert_eq!(estimate_dag_depth(&nodes, &edges), 3);
        // cycle: depth falls back to node count
        let edges_cycle = vec![
            json!({"source": "a", "target": "b"}),
            json!({"source": "b", "target": "a"}),
        ];
        let d = estimate_dag_depth(&nodes[..2], &edges_cycle);
        assert_eq!(d, 2);
    }

    #[test]
    fn claude_workflow_root_shape() {
        let result = crate::parsers::claude_code::parse(
            &std::fs::read(format!(
                "{}/tests/fixtures/sample_claude_code_transcript.jsonl",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        );
        let root = build_workflow(&result).expect("workflow root");
        assert!(root.is_root);
        assert_eq!(root.state, "completed");
        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].name, "Explore");
        assert_eq!(root.children[0].parent_id.as_deref(), Some("sess-1"));
    }
}
