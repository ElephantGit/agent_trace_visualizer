//! Deterministic event sampling — port of `sample_events` in
//! `legacy/trace_viz/views/shared.py`.
//!
//! Keeps first & last, seeded-shuffles the middle. The exact sampled set may
//! differ from Python's MT19937; the contract is: first/last kept, count
//! capped, notice shown.

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug)]
pub struct Sampled {
    pub events: Vec<Value>,
    /// Some when sampling actually happened (mirrors the legacy st.info).
    pub notice: Option<String>,
}

pub fn sample_events(events: &[Value], max_n: usize, seed: u64) -> Sampled {
    if events.len() <= max_n {
        return Sampled {
            events: events.to_vec(),
            notice: None,
        };
    }
    let mut rng = XorShift64::new(seed);
    let mut middle: Vec<usize> = (1..events.len() - 1).collect();
    // Fisher-Yates with the seeded PRNG: same determinism contract as StdRng,
    // but no getrandom dependency, so the core compiles to wasm32.
    for i in (1..middle.len()).rev() {
        let j = rng.below(i + 1);
        middle.swap(i, j);
    }
    let mut chosen: Vec<usize> = middle.into_iter().take(max_n - 2).collect();
    chosen.sort_unstable();
    let mut sampled = Vec::with_capacity(chosen.len() + 2);
    sampled.push(events[0].clone());
    for i in chosen {
        sampled.push(events[i].clone());
    }
    sampled.push(events[events.len() - 1].clone());
    Sampled {
        notice: Some(format!(
            "共 {} 个事件，已采样显示 {} 个",
            events.len(),
            sampled.len()
        )),
        events: sampled,
    }
}

/// xorshift64*：seed 化的确定性 PRNG。
///
/// 替代 rand 的 StdRng：采样契约只要求"seed 相同 → 结果相同、首尾保留、数量
/// 封顶"，不要求与任何特定库的洗牌序列一致（见模块文档）。纯算术实现使核心
/// 无需 getrandom 即可编译到 wasm32-unknown-unknown。
struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        // xorshift 状态不能为 0，否则永远输出 0。
        Self(seed.max(1))
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// 生成 [0, bound) 的整数；采样场景的均匀性要求远低于密码学强度。
    fn below(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_first_and_last_and_caps() {
        let events: Vec<Value> = (0..20).map(|i| json!({"i": i})).collect();
        let s = sample_events(&events, 5, 42);
        assert_eq!(s.events.len(), 5);
        assert_eq!(s.events.first().unwrap()["i"], 0);
        assert_eq!(s.events.last().unwrap()["i"], 19);
        assert!(s.notice.is_some());
        // deterministic
        let s2 = sample_events(&events, 5, 42);
        assert_eq!(s.events, s2.events);
    }

    #[test]
    fn small_inputs_pass_through() {
        let events: Vec<Value> = (0..3).map(|i| json!({"i": i})).collect();
        let s = sample_events(&events, 5, 42);
        assert_eq!(s.events, events);
        assert!(s.notice.is_none());
    }
}
