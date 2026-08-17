//! Derived-data builders — ports of the transformation half of the legacy
//! `trace_viz/views/` modules. Everything that walks `raw_events` lives here
//! (server-side); pure row-shaping stays on the frontend.

pub mod compare;
pub mod replay;
pub mod sample;
pub mod workflow;
