//! cl100k_base token counting — the tiktoken half of
//! `legacy/trace_viz/utils.py`.
//!
//! Fallback order:
//!   1. `tiktoken_rs::cl100k_base()` — the official cl100k ranks are embedded
//!      in the crate (include_str!), so this works offline and needs no
//!      download. (Note: tiktoken-rs 0.9 keeps `CoreBPE::new` crate-private,
//!      so the legacy custom-pat_str cache-file path from utils.py cannot be
//!      reproduced — official cl100k is used instead, which is strictly more
//!      accurate than legacy's `len/4` fallback on machines without that cache.)
//!   2. `max(1, len/4)` — legacy's ultimate fallback.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use tiktoken_rs::CoreBPE;

static ENCODER: OnceLock<Mutex<Option<CoreBPE>>> = OnceLock::new();

/// 内容 → token 数缓存：实时监控会周期性重解析同一个增长中的
/// transcript，绝大部分工具输出文本没有变化；按 128 位文本哈希缓存
/// 计数后，重复解析只为新增内容做 BPE（10MB 级会话从 ~10s 降到 ~1s）。
static TOKEN_CACHE: OnceLock<Mutex<HashMap<(u64, u64), usize>>> = OnceLock::new();

/// 超过此条目数清空一次，防止长时间运行内存无限增长。
const TOKEN_CACHE_MAX: usize = 200_000;

fn text_hash(text: &str) -> (u64, u64) {
    let mut h1 = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h1);
    let a = h1.finish();
    // 第二个独立哈希：换一个前缀再 hash 一遍，碰撞概率 ~2^-128
    let mut h2 = std::collections::hash_map::DefaultHasher::new();
    1u8.hash(&mut h2);
    text.hash(&mut h2);
    (a, h2.finish())
}

/// Approximate token count via cl100k_base; falls back to len/4.
/// 结果按文本内容缓存（见 TOKEN_CACHE）。
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let key = text_hash(text);
    {
        let cache = TOKEN_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .expect("token cache poisoned");
        if let Some(&n) = cache.get(&key) {
            return n;
        }
    }
    let n = {
        let guard = ENCODER
            .get_or_init(|| Mutex::new(tiktoken_rs::cl100k_base().ok()))
            .lock()
            .expect("encoder mutex poisoned");
        match guard.as_ref() {
            Some(bpe) => bpe.encode_with_special_tokens(text).len(),
            None => (text.chars().count() / 4).max(1),
        }
    };
    let mut cache = TOKEN_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("token cache poisoned");
    if cache.len() >= TOKEN_CACHE_MAX {
        cache.clear();
    }
    cache.insert(key, n);
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_is_zero() {
        assert_eq!(count_tokens(""), 0);
    }

    #[test]
    fn known_cl100k_counts() {
        // Reference values from the Python tiktoken cl100k_base encoder.
        assert_eq!(count_tokens("hello world"), 2);
        assert_eq!(count_tokens("你好世界"), 5);
    }
}
