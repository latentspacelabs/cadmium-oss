//! Request/response types pinning the Cadmium serving HTTP contract.
//!
//! Field names and defaults mirror the framework-free Python handlers:
//!
//! - `serving/handlers/segment.py`    → [`SegmentRequest`] / [`SegmentResponse`]
//! - `serving/handlers/preprocess.py` → [`PreprocessRequest`] / [`PreprocessResponse`]
//! - `serving/handlers/colorize.py`   → [`ColorizeRequest`] / [`ColorizeResponse`]
//!
//! All images travel as base64 PNG data-URI strings (`data:image/png;base64,…`).
//! NOTE: `/preprocess` inputs use **URL-safe** base64 (the app encodes them with
//! `url-safe-base64`); `/segment` and `/colorize` use standard base64. The
//! Python handlers accept and ignore unknown fields (`**kwargs`), which is also
//! serde's default behavior — do not add `deny_unknown_fields`.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub engine: &'static str,
    pub version: &'static str,
    /// Mirrors the Python server's health field: whether a gap-closer model
    /// is configured (the session itself is built lazily).
    pub gap_closer: bool,
}

/// Body returned on any handler error (HTTP 500), mirroring FastAPI's
/// error-out-of-handler behavior closely enough for the app.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

// ---------------------------------------------------------------------------
// /segment — gap closing + trapped-ball segmentation
// ---------------------------------------------------------------------------

/// Mirrors `run_segment(...)` in `serving/handlers/segment.py`.
#[derive(Debug, Deserialize)]
pub struct SegmentRequest {
    /// Base64 PNG data URI of the RGBA line image (standard base64).
    pub line_image_uri: String,
    /// Also render a colorized visualization of the seg map. Default: false.
    #[serde(default)]
    pub return_colorized: bool,
    /// Maps to the GapCloser's UDF binarization threshold; <= 0 skips the ML
    /// gap closer entirely (trapped-ball only). Default: 1.0.
    #[serde(default = "default_gap_closer_strength")]
    pub gap_closer_strength: f32,
    /// GPU batch size for the GapCloser tile forward. Accepted for contract
    /// compatibility; the sidecar always forwards tiles one at a time — the
    /// composition verified 0-flips against the golden tile boundaries.
    /// Default: 24.
    #[serde(default = "default_gap_closer_batch_size")]
    pub gap_closer_batch_size: u32,
    /// Minimum segment size (pixels) kept by trapped-ball. Default: 10.
    #[serde(default = "default_min_seg_size")]
    pub min_seg_size: u32,
}

fn default_gap_closer_strength() -> f32 {
    1.0
}
fn default_gap_closer_batch_size() -> u32 {
    24
}
fn default_min_seg_size() -> u32 {
    10
}

/// `run_segment`'s response dict. The empty-alpha short-circuit omits
/// `boundary_binary_uri` (the Python dict simply lacks the key), hence the
/// Option + skip.
#[derive(Debug, Serialize)]
pub struct SegmentResponse {
    /// Base64 PNG data URI of the dense (label-per-pixel) seg map.
    pub seg_map_uri: String,
    /// Present (possibly null) — null unless `return_colorized`.
    pub colorized_seg_map_uri: Option<String>,
    /// Base64 PNG data URI of the closed-boundary binary image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary_binary_uri: Option<String>,
    pub num_segments: u32,
}

// ---------------------------------------------------------------------------
// /preprocess — reference-assisted palette extraction (v2)
// ---------------------------------------------------------------------------

/// One reference in the ordered `references` list (length-1 today; the
/// two-reference seam). Mirrors the dict shape consumed by
/// `run_preprocess(...)` in `serving/handlers/preprocess.py`.
#[derive(Debug, Deserialize)]
pub struct PreprocessReference {
    /// URL-safe base64 PNG data URI of the reference seg map.
    pub seg_map_uri: String,
    /// URL-safe base64 PNG data URI of the reference color image.
    pub color_image_uri: String,
    /// Optional URL-safe base64 PNG data URI of the reference line image.
    pub line_image_uri: Option<String>,
}

/// Mirrors `run_preprocess(...)` in `serving/handlers/preprocess.py`.
///
/// Exactly one of `references` (preferred) or the legacy flat `ref_*` fields
/// must be provided; the Python handler raises when both are absent. Only the
/// first reference is processed today.
#[derive(Debug, Deserialize)]
pub struct PreprocessRequest {
    /// Preferred: ordered reference list (only the first is used today).
    pub references: Option<Vec<PreprocessReference>>,
    /// Legacy single-reference fields (older clients / Modal stubs).
    pub ref_seg_map_uri: Option<String>,
    pub ref_color_image_uri: Option<String>,
    pub ref_line_image_uri: Option<String>,
    /// Also return the re-rendered anti-alias-free filled reference image.
    /// Default: true.
    #[serde(default = "default_true")]
    pub return_filled: bool,
}

/// `run_preprocess`'s response dict (`preprocessed_uri` key absent when
/// `return_filled` is false).
#[derive(Debug, Serialize)]
pub struct PreprocessResponse {
    /// Per-segment RGBA palette, one `[r, g, b, a]` (0–255) entry per segment
    /// id. The null color (-100 internally) is emitted as transparent
    /// `[0, 0, 0, 0]`.
    pub palette_rgba: Vec<[u8; 4]>,
    /// Base64 PNG data URI of the filled reference render (PIL/RGBA-ordered
    /// encoding on the Python side). Only present when `return_filled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preprocessed_uri: Option<String>,
}

// ---------------------------------------------------------------------------
// /colorize — reference-guided colorization (AnT v2). /predict is an alias.
// ---------------------------------------------------------------------------

/// One reference in the ordered `references` list. Mirrors the dict shape
/// consumed by `run_colorize(...)` in `serving/handlers/colorize.py`.
#[derive(Debug, Deserialize)]
pub struct ColorizeReference {
    /// Base64 PNG data URI of the reference seg map (standard base64).
    pub seg_map_uri: String,
    /// Base64 PNG data URI of the reference line image (standard base64).
    pub line_image_uri: String,
    /// Per-segment reference palette: `[r, g, b, a]` (0–255) per segment id.
    /// Python types this `List[Tuple[int, int, int, int]]` without range
    /// checks, so keep the full integer range and replicate its arithmetic
    /// (`rgba_to_dense_flat` is plain int math).
    pub colors_rgba: Vec<[i64; 4]>,
}

/// Mirrors `run_colorize(...)` in `serving/handlers/colorize.py`.
///
/// Exactly one of `references` (preferred) or the legacy flat `ref_*` fields
/// must be provided. The AnT v2 tokenizer consumes one reference; extras are
/// ignored with a log line.
#[derive(Debug, Deserialize)]
pub struct ColorizeRequest {
    /// Base64 PNG data URI of the target seg map (standard base64).
    pub target_seg_map_uri: String,
    /// Base64 PNG data URI of the target line image (standard base64).
    pub target_line_image_uri: String,
    /// Preferred: ordered reference list (only the first is used today).
    pub references: Option<Vec<ColorizeReference>>,
    /// Legacy single-reference fields (older clients / Modal stubs).
    pub ref_seg_map_uri: Option<String>,
    pub ref_line_image_uri: Option<String>,
    pub ref_colors_rgba: Option<Vec<[i64; 4]>>,
    /// Render colorized output images. The Python handler defaults this to
    /// false, but the local server injects `true` for /colorize and /predict
    /// (`{"return_colorized": True, **input}`) — an ABSENT field therefore
    /// means true, and only an explicit false disables the renders. Option
    /// distinguishes the two.
    pub return_colorized: Option<bool>,
    /// Accepted by the Python contract but NOT forwarded to the pipeline call
    /// (`run_colorize` drops it), so the palette is always built with
    /// `unique_color_ids=False`. Kept for request compatibility.
    #[serde(default)]
    pub unique_color_ids: bool,
    /// Server-side log verbosity (forwarded to the pipeline). Default: true.
    #[serde(default = "default_true")]
    pub verbose: bool,
}

fn default_true() -> bool {
    true
}

/// `run_colorize`'s response dict.
#[derive(Debug, Serialize)]
pub struct ColorizeResponse {
    /// Predicted per-segment RGBA colors for the target, `[r, g, b, a]`
    /// (0–255) per segment id; null/unmatched predictions are the production
    /// `[-100, -100, -100, -100]` sentinel.
    pub target_colors_rgba: Vec<[i64; 4]>,
    /// Predicted per-segment palette color ids for the target (-100 = null).
    pub target_color_ids: Vec<i64>,
    /// Rendered colorized target, only when `return_colorized`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_color_image_uri: Option<String>,
    /// Rendered colorized reference, only when `return_colorized`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_color_image_uri: Option<String>,
}
