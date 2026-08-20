//! Deterministic event sampling — port of `sample_events` in
//! `legacy/trace_viz/views/shared.py`.
//!
//! Keeps first & last, seeded-shuffles the middle. The exact sampled set may
//! differ from Python's MT19937; the contract is: first/last kept, count
//! capped, notice shown.

use rand::SeedableRng;
use rand::seq::SliceRandom;
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
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let mut middle: Vec<usize> = (1..events.len() - 1).collect();
    middle.shuffle(&mut rng);
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
