//! cadmium-sidecar library — Rust ports of the Python serving pipeline
//! (verified byte-exact against production goldens) plus the HTTP serving
//! layer (`serve`) that assembles them behind the production contract.

pub mod goldens;
pub mod imageprep;
pub mod postprocess;
pub mod segment;
pub mod serve;
pub mod tokenize;
