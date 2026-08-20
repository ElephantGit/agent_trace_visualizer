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

use std::sync::{Mutex, OnceLock};

use tiktoken_rs::CoreBPE;

static ENCODER: OnceLock<Mutex<Option<CoreBPE>>> = OnceLock::new();

/// Approximate token count via cl100k_base; falls back to len/4.
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let guard = ENCODER
        .get_or_init(|| Mutex::new(tiktoken_rs::cl100k_base().ok()))
        .lock()
        .expect("encoder mutex poisoned");
    match guard.as_ref() {
        Some(bpe) => bpe.encode_with_special_tokens(text).len(),
        None => (text.chars().count() / 4).max(1),
    }
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
