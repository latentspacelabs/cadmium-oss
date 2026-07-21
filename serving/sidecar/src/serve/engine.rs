//! Lazily-built ONNX Runtime sessions for the two models the sidecar serves:
//! the GapCloser UDF net (`/segment` with strength > 0) and the AnT v2
//! colorizer (`/colorize`). Sessions are created on first use so `/health`,
//! `/preprocess` and strength-0 `/segment` work without any model files.
//!
//! Execution-provider selection (`--ep`, AnT forward only):
//!   cpu     — the dynamic AnT model on the CPU EP (the golden gate's
//!             baseline provider).
//!   coreml  — macOS: the CORPUS_BUCKET-pinned AnT model (`--ant-model-bucket`,
//!             all dims static) on the CoreML EP (MLProgram, compute units
//!             ALL), built lazily on first /colorize. Feeds are bucket-padded
//!             (`tokenize::bucket`); a feed that exceeds the bucket falls
//!             back to a lazily-built dynamic CPU session. One static shape
//!             means ONE CoreML compile for the whole corpus.
//!   dml     — Windows: the DYNAMIC AnT model on DirectML + CPU fallback
//!             (DML handles dynamic shapes, no bucket model needed) —
//!             mirrors `parity_replay.py --dml`. Compiled only for Windows
//!             targets; a stub error elsewhere.
//!   auto    — coreml when running on macOS with `--ant-model-bucket`
//!             supplied, else cpu. dml stays opt-in until the Windows
//!             evaluation lands.
//!
//! The GapCloser stays on the CPU EP regardless of `--ep` (2.6 s per
//! /segment is acceptable; moving it to CoreML is a follow-up).

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Instant;

use ort::ep::CPU;
use ort::session::Session;
use ort::value::Tensor as OrtTensor;

use crate::tokenize::bucket::{pad_feed_to_bucket, CORPUS_BUCKET};
use crate::tokenize::feed::AntFeed;
use crate::tokenize::Tensor;

// ---------------------------------------------------------------------------
// EP selection

/// The `--ep` flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpSelect {
    Auto,
    Cpu,
    CoreMl,
    Dml,
}

impl FromStr for EpSelect {
    type Err = String;

    fn from_str(s: &str) -> Result<EpSelect, String> {
        match s {
            "auto" => Ok(EpSelect::Auto),
            "cpu" => Ok(EpSelect::Cpu),
            "coreml" => Ok(EpSelect::CoreMl),
            "dml" => Ok(EpSelect::Dml),
            other => Err(format!("unknown EP `{other}` (expected auto|cpu|coreml|dml)")),
        }
    }
}

/// The resolved AnT serving plan (per-process, decided at startup).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AntEp {
    /// Dynamic model, CPU EP.
    Cpu,
    /// Bucket-pinned model on CoreML; dynamic-CPU fallback for feeds that
    /// exceed CORPUS_BUCKET.
    CoreMlBucket,
    /// Dynamic model, DirectML EP with CPU fallback (Windows only).
    Dml,
}

// ---------------------------------------------------------------------------
// engine

/// CoreML session plus a first-run marker (the first forward includes
/// CoreML's on-device model specialization, worth logging separately).
struct BucketState {
    session: Session,
    warmed: bool,
}

pub struct Engine {
    pub gap_model_path: Option<PathBuf>,
    pub ant_model_path: Option<PathBuf>,
    pub ant_bucket_model_path: Option<PathBuf>,
    ant_ep: AntEp,
    gap: Mutex<Option<Session>>,
    /// Dynamic AnT model: CPU EP, or DirectML+CPU when `ant_ep` is Dml.
    ant: Mutex<Option<Session>>,
    /// Bucket-pinned AnT model on the CoreML EP.
    ant_bucket: Mutex<Option<BucketState>>,
}

fn build_cpu_session(what: &str, path: &Path) -> Result<Session, String> {
    let t0 = Instant::now();
    let session = (|| {
        Session::builder()?
            .with_execution_providers([CPU::default().build()])?
            .commit_from_file(path)
    })()
    .map_err(|e| format!("failed to load {what} model {}: {e}", path.display()))?;
    tracing::info!(
        model = %path.display(),
        load_ms = t0.elapsed().as_millis() as u64,
        "{what} ONNX session created (CPU EP)"
    );
    Ok(session)
}

/// CoreML session over the bucket-pinned model: MLProgram format, compute
/// units ALL, CPU EP fallback for any unsupported partitions.
/// `error_on_failure` so a misconfigured CoreML EP fails loudly instead of
/// silently serving from the CPU (the goldens would still pass and hide it).
#[cfg(target_os = "macos")]
fn build_coreml_session(path: &Path) -> Result<Session, String> {
    use ort::ep::coreml::{ComputeUnits, ModelFormat};

    let t0 = Instant::now();
    let session = (|| {
        Session::builder()?
            .with_execution_providers([
                ort::ep::CoreML::default()
                    .with_model_format(ModelFormat::MLProgram)
                    .with_compute_units(ComputeUnits::All)
                    .build()
                    .error_on_failure(),
                CPU::default().build(),
            ])?
            .commit_from_file(path)
    })()
    .map_err(|e| format!("failed to load bucket AnT model {}: {e}", path.display()))?;
    tracing::info!(
        model = %path.display(),
        load_ms = t0.elapsed().as_millis() as u64,
        "AnT bucket ONNX session created (CoreML EP, MLProgram, compute units ALL)"
    );
    Ok(session)
}

#[cfg(not(target_os = "macos"))]
fn build_coreml_session(_path: &Path) -> Result<Session, String> {
    Err("CoreML EP is only compiled into macOS builds".into())
}

/// DirectML session over the DYNAMIC model + CPU fallback — the Rust replica
/// of `parity_replay.py::make_session(dml=True)` (`DmlExecutionProvider` +
/// `CPUExecutionProvider`; the DML provider factory itself disables memory
/// pattern and forces sequential execution, so no extra session options).
#[cfg(target_os = "windows")]
fn build_dml_session(what: &str, path: &Path) -> Result<Session, String> {
    let t0 = Instant::now();
    let session = (|| {
        Session::builder()?
            .with_execution_providers([
                ort::ep::DirectML::default().build().error_on_failure(),
                CPU::default().build(),
            ])?
            .commit_from_file(path)
    })()
    .map_err(|e| format!("failed to load {what} model {}: {e}", path.display()))?;
    tracing::info!(
        model = %path.display(),
        load_ms = t0.elapsed().as_millis() as u64,
        "{what} ONNX session created (DirectML EP + CPU fallback)"
    );
    Ok(session)
}

#[cfg(not(target_os = "windows"))]
fn build_dml_session(_what: &str, _path: &Path) -> Result<Session, String> {
    Err("DirectML EP is only compiled into Windows builds".into())
}

impl Engine {
    pub fn new(
        gap_model_path: Option<PathBuf>,
        ant_model_path: Option<PathBuf>,
        ant_bucket_model_path: Option<PathBuf>,
        ep: EpSelect,
    ) -> Result<Engine, String> {
        let ant_ep = match ep {
            EpSelect::Cpu => AntEp::Cpu,
            EpSelect::Auto => {
                if cfg!(target_os = "macos") && ant_bucket_model_path.is_some() {
                    AntEp::CoreMlBucket
                } else {
                    AntEp::Cpu
                }
            }
            EpSelect::CoreMl => {
                if !cfg!(target_os = "macos") {
                    return Err("--ep coreml is only available on macOS builds".into());
                }
                if ant_bucket_model_path.is_none() {
                    return Err(
                        "--ep coreml needs --ant-model-bucket (the CORPUS_BUCKET-pinned AnT \
                         export; the dynamic model would trigger a CoreML compile per shape)"
                            .into(),
                    );
                }
                AntEp::CoreMlBucket
            }
            EpSelect::Dml => {
                if !cfg!(target_os = "windows") {
                    return Err("--ep dml is only available on Windows builds (DirectML)".into());
                }
                AntEp::Dml
            }
        };
        tracing::info!(ep = Self::ep_label(ant_ep), "AnT execution provider resolved");
        Ok(Engine {
            gap_model_path,
            ant_model_path,
            ant_bucket_model_path,
            ant_ep,
            gap: Mutex::new(None),
            ant: Mutex::new(None),
            ant_bucket: Mutex::new(None),
        })
    }

    fn ep_label(ep: AntEp) -> &'static str {
        match ep {
            AntEp::Cpu => "cpu",
            AntEp::CoreMlBucket => "coreml-bucket",
            AntEp::Dml => "dml",
        }
    }

    /// The resolved AnT EP, for harness/report output.
    pub fn ant_ep_name(&self) -> &'static str {
        Self::ep_label(self.ant_ep)
    }

    /// Run `f` with the gap-closer session, building it on first use.
    /// `Ok(None)` when no gap model was configured (the caller falls back to
    /// the trapped-ball-only path, like the Python server with no
    /// `--gap-close-checkpoint`). Always CPU EP — see the module docs.
    pub fn with_gap_session<T>(
        &self,
        f: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let Some(path) = &self.gap_model_path else {
            return Ok(None);
        };
        let mut guard = self.gap.lock().map_err(|_| "gap session poisoned")?;
        if guard.is_none() {
            *guard = Some(build_cpu_session("gap-closer", path)?);
        }
        f(guard.as_mut().unwrap()).map(Some)
    }

    /// The AnT forward: dispatch `feed` to the resolved EP and return
    /// `packed_logits` as (dims, data). On the CoreML plan, feeds that fit
    /// CORPUS_BUCKET are padded and run on the pinned session (dims[1] is
    /// then the bucket length — real tokens stay a prefix, so target rows
    /// remain at `[n_ref .. n_ref+n_tgt)`); oversized feeds fall back to the
    /// dynamic CPU session.
    pub fn run_ant(&self, feed: &AntFeed) -> Result<(Vec<usize>, Vec<f32>), String> {
        match self.ant_ep {
            AntEp::Cpu | AntEp::Dml => self.run_ant_dynamic(feed),
            AntEp::CoreMlBucket => match pad_feed_to_bucket(feed, &CORPUS_BUCKET) {
                Ok(padded) => self.run_ant_bucket(&padded),
                Err(why) => {
                    tracing::warn!(
                        %why,
                        "feed exceeds CORPUS_BUCKET; falling back to the dynamic CPU session"
                    );
                    self.run_ant_dynamic(feed)
                }
            },
        }
    }

    /// Dynamic-shape AnT session (CPU EP, or DirectML+CPU under `--ep dml`),
    /// built on first use.
    fn run_ant_dynamic(&self, feed: &AntFeed) -> Result<(Vec<usize>, Vec<f32>), String> {
        let Some(path) = &self.ant_model_path else {
            return Err("no AnT model configured (start the sidecar with --ant-model)".into());
        };
        let mut guard = self.ant.lock().map_err(|_| "ant session poisoned")?;
        if guard.is_none() {
            *guard = Some(match self.ant_ep {
                AntEp::Dml => build_dml_session("AnT v2 (dynamic)", path)?,
                _ => build_cpu_session("AnT v2 (dynamic)", path)?,
            });
        }
        run_ant_session(guard.as_mut().unwrap(), feed)
    }

    /// Bucket-pinned AnT session on CoreML, built on first use. `feed` must
    /// already be bucket-padded.
    fn run_ant_bucket(&self, feed: &AntFeed) -> Result<(Vec<usize>, Vec<f32>), String> {
        let Some(path) = &self.ant_bucket_model_path else {
            return Err(
                "no bucket AnT model configured (start the sidecar with --ant-model-bucket)"
                    .into(),
            );
        };
        let mut guard = self
            .ant_bucket
            .lock()
            .map_err(|_| "ant bucket session poisoned")?;
        if guard.is_none() {
            *guard = Some(BucketState {
                session: build_coreml_session(path)?,
                warmed: false,
            });
        }
        let state = guard.as_mut().unwrap();
        let t0 = Instant::now();
        let out = run_ant_session(&mut state.session, feed)?;
        if !state.warmed {
            state.warmed = true;
            tracing::info!(
                first_forward_ms = t0.elapsed().as_millis() as u64,
                "CoreML bucket session first forward (includes CoreML model specialization)"
            );
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// session run

/// Feed an `AntFeed` to a session and extract `packed_logits`. Verifies the
/// output row axis matches the fed packed length (bucket length on the
/// pinned session, n_packed on the dynamic one).
fn run_ant_session(session: &mut Session, feed: &AntFeed) -> Result<(Vec<usize>, Vec<f32>), String> {
    fn f32t(t: &Tensor<f32>) -> Result<OrtTensor<f32>, String> {
        OrtTensor::from_array((t.shape.clone(), t.data.clone()))
            .map_err(|e| format!("feed tensor: {e}"))
    }
    fn boolt(t: &Tensor<bool>) -> Result<OrtTensor<bool>, String> {
        OrtTensor::from_array((t.shape.clone(), t.data.clone()))
            .map_err(|e| format!("feed tensor: {e}"))
    }
    fn i64t(t: &Tensor<i64>) -> Result<OrtTensor<i64>, String> {
        OrtTensor::from_array((t.shape.clone(), t.data.clone()))
            .map_err(|e| format!("feed tensor: {e}"))
    }

    let outputs = session
        .run(ort::inputs![
            "ref_line_image" => f32t(&feed.ref_line_image)?,
            "ref_sdf" => f32t(&feed.ref_sdf)?,
            "ref_seg_lowres" => i64t(&feed.ref_seg_lowres)?,
            "target_line_image" => f32t(&feed.target_line_image)?,
            "target_sdf" => f32t(&feed.target_sdf)?,
            "target_seg_lowres" => i64t(&feed.target_seg_lowres)?,
            "ref_svg_packed_nopad" => f32t(&feed.ref_svg_packed_nopad)?,
            "ref_svg_attn_nopad" => boolt(&feed.ref_svg_attn_nopad)?,
            "ref_svg_flat_idx" => i64t(&feed.ref_svg_flat_idx)?,
            "ref_svg_cmd_slot_idx" => i64t(&feed.ref_svg_cmd_slot_idx)?,
            "ref_svg_slot_counts" => f32t(&feed.ref_svg_slot_counts)?,
            "target_svg_packed_nopad" => f32t(&feed.target_svg_packed_nopad)?,
            "target_svg_attn_nopad" => boolt(&feed.target_svg_attn_nopad)?,
            "target_svg_flat_idx" => i64t(&feed.target_svg_flat_idx)?,
            "target_svg_cmd_slot_idx" => i64t(&feed.target_svg_cmd_slot_idx)?,
            "target_svg_slot_counts" => f32t(&feed.target_svg_slot_counts)?,
            "ref_colors" => i64t(&feed.ref_colors)?,
            "ref_color_ids" => i64t(&feed.ref_color_ids)?,
            "target_colors" => i64t(&feed.target_colors)?,
            "target_color_ids" => i64t(&feed.target_color_ids)?,
            "packed_gather_idx" => i64t(&feed.packed_gather_idx)?,
            "packed_attn_mask" => boolt(&feed.packed_attn_mask)?,
        ])
        .map_err(|e| format!("AnT forward: {e}"))?;
    let (shape, data) = outputs["packed_logits"]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("AnT output: {e}"))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    let fed_len = feed.packed_gather_idx.shape[0];
    if dims.len() != 3 || dims[0] != 1 || dims[1] != fed_len {
        return Err(format!(
            "unexpected packed_logits shape {dims:?} (fed packed length {fed_len})"
        ));
    }
    Ok((dims, data.to_vec()))
}
