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
//!   dml     — Windows: the TILED-scatter AnT model (`--ant-model-tiled`, pool
//!             ScatterElements rewritten as a bounded one-hot MatMul so the
//!             whole forward stays on the GPU) on DirectML, built lazily on
//!             first /colorize. If the tiled model is absent it uses the stock
//!             dynamic model instead; either way, if DirectML cannot
//!             initialize (no DirectX-12 device) it falls back to the stock
//!             model on the CPU EP. Compiled only for Windows targets; a stub
//!             error elsewhere.
//!   auto    — coreml when running on macOS with `--ant-model-bucket`
//!             supplied; dml when running on Windows with `--ant-model-tiled`
//!             supplied; else cpu.
//!
//! The GapCloser (`/segment` with strength > 0) runs on CoreML on macOS when
//! its batch-pinned export (`--gap-model-bucket`) is supplied under the
//! coreml/auto EP — the 512x512 tiles are forwarded in fixed batches of
//! `GAP_COREML_BATCH` (~16x faster than the CPU EP on a high-res drawing).
//! Otherwise (no bucket export, non-macOS, or a CoreML init failure) it runs
//! on the CPU EP, one tile at a time.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ort::ep::CPU;
use ort::session::Session;
use ort::value::Tensor as OrtTensor;

use crate::segment::tiled::TILE_SIZE;
use crate::segment::tiler::PlaneF32;
use crate::tokenize::bucket::{pad_feed_to_bucket, CORPUS_BUCKET};
use crate::tokenize::feed::AntFeed;
use crate::tokenize::Tensor;

/// The batch the CoreML gap-closer export (`--gap-model-bucket`) is pinned to.
/// Tiles are forwarded in chunks of this size, padding the final short chunk
/// (conv is per-sample, so the pad tiles never affect the real ones).
const GAP_COREML_BATCH: usize = 24;

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
    /// DirectML EP (Windows only): the tiled-scatter model when supplied, else
    /// the dynamic model. Falls back to the dynamic model on the CPU EP if
    /// DirectML can't initialize.
    Dml,
}

/// The resolved GapCloser serving plan (per-process, decided at startup).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GapEp {
    /// Dynamic model, CPU EP, one 512x512 tile per forward.
    Cpu,
    /// Batch-pinned model on CoreML; falls back to CPU on a CoreML init error.
    CoreMl,
}

// ---------------------------------------------------------------------------
// engine

/// CoreML session plus a first-run marker (the first forward includes
/// CoreML's on-device model specialization, worth logging separately).
struct BucketState {
    session: Session,
    warmed: bool,
}

/// `ant_bucket_gate` states: the AnT bucket's CoreML build takes ~107s cold
/// (~20s from the model cache), so requests must never block behind it.
/// IDLE means no prewarm was requested (verify harnesses): the request builds
/// the session inline, blocking — the sidecar itself always prewarms.
const GATE_IDLE: u8 = 0;
const GATE_BUILDING: u8 = 1;
const GATE_READY: u8 = 2;
const GATE_FAILED: u8 = 3;

/// One capability's acceleration state, served in `/health` so the app can
/// show *expected vs actual* instead of silently degrading (see
/// `docs/serving-setup-design.md`).
#[derive(Debug, serde::Serialize)]
pub struct AccelCapability {
    /// What the resolved plan intends: `coreml` | `dml` | `cpu`.
    pub planned: &'static str,
    /// What the next request actually gets: `coreml` | `dml` | `cpu` |
    /// `building` (CoreML compile in flight; requests serve from CPU).
    pub active: &'static str,
    /// Non-null exactly when something actionable is wrong (accelerator
    /// model missing under `auto`, an EP build failure). A deliberate CPU
    /// plan carries no reason — CPU-by-design is not a degradation.
    pub reason: Option<String>,
}

/// The `/health` acceleration report: one entry per accelerable capability.
#[derive(Debug, serde::Serialize)]
pub struct AccelReport {
    pub colorize: AccelCapability,
    pub segment: AccelCapability,
}

pub struct Engine {
    pub gap_model_path: Option<PathBuf>,
    pub gap_bucket_model_path: Option<PathBuf>,
    pub ant_model_path: Option<PathBuf>,
    pub ant_bucket_model_path: Option<PathBuf>,
    pub ant_tiled_model_path: Option<PathBuf>,
    /// Where CoreML persists compiled models (--coreml-cache-dir).
    coreml_cache_dir: Option<PathBuf>,
    ant_ep: AntEp,
    gap_ep: GapEp,
    /// Dynamic GapCloser model on the CPU EP (one tile per forward).
    gap: Mutex<Option<Session>>,
    /// Batch-pinned GapCloser model on the CoreML EP (batched tiles).
    gap_coreml: Mutex<Option<Session>>,
    /// Latched once the CoreML gap build fails (prewarm or lazy): the compile
    /// won't succeed on a retry with the same model+machine, so every later
    /// `/segment` skips straight to the CPU EP instead of re-paying the failed
    /// build. Never reset for the process's life.
    gap_coreml_failed: AtomicBool,
    /// The non-CoreML AnT session: the dynamic model on the CPU EP, or (when
    /// `ant_ep` is Dml) the tiled model on DirectML — with a lazy fallback to
    /// the dynamic model on the CPU EP if DirectML can't initialize.
    ant: Mutex<Option<Session>>,
    /// Bucket-pinned AnT model on the CoreML EP.
    ant_bucket: Mutex<Option<BucketState>>,
    /// GATE_* — colorize serves from the dynamic CPU session while the
    /// bucket session is BUILDING (or after a FAILED build) instead of
    /// blocking behind the compile.
    ant_bucket_gate: AtomicU8,
    /// Why AnT acceleration is absent or degraded (accelerator model not
    /// configured, EP build failure) — `None` when accelerated or when CPU
    /// was deliberately chosen. Served in `/health`.
    ant_accel_reason: Mutex<Option<String>>,
    /// Same, for the GapCloser.
    gap_accel_reason: Mutex<Option<String>>,
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
/// With `cache_dir`, the compiled CoreML model is persisted there — the AnT
/// bucket's ~107s compile happens once per machine, then reloads in ~20s.
#[cfg(target_os = "macos")]
fn build_coreml_session(what: &str, path: &Path, cache_dir: Option<&Path>) -> Result<Session, String> {
    use ort::ep::coreml::{ComputeUnits, ModelFormat};

    if let Some(dir) = cache_dir {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!(dir = %dir.display(), error = %e, "cannot create CoreML cache dir; compiling uncached");
        }
    }
    let t0 = Instant::now();
    let session = (|| {
        let mut ep = ort::ep::CoreML::default()
            .with_model_format(ModelFormat::MLProgram)
            .with_compute_units(ComputeUnits::All);
        if let Some(dir) = cache_dir.filter(|d| d.is_dir()) {
            ep = ep.with_model_cache_dir(dir.display());
        }
        Session::builder()?
            .with_execution_providers([ep.build().error_on_failure(), CPU::default().build()])?
            .commit_from_file(path)
    })()
    .map_err(|e| format!("failed to load {what} model {}: {e}", path.display()))?;
    tracing::info!(
        model = %path.display(),
        load_ms = t0.elapsed().as_millis() as u64,
        "{what} ONNX session created (CoreML EP, MLProgram, compute units ALL)"
    );
    Ok(session)
}

#[cfg(not(target_os = "macos"))]
fn build_coreml_session(_what: &str, _path: &Path, _cache_dir: Option<&Path>) -> Result<Session, String> {
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
        gap_bucket_model_path: Option<PathBuf>,
        ant_model_path: Option<PathBuf>,
        ant_bucket_model_path: Option<PathBuf>,
        ant_tiled_model_path: Option<PathBuf>,
        ep: EpSelect,
        coreml_cache_dir: Option<PathBuf>,
    ) -> Result<Engine, String> {
        // Under `auto`, a missing accelerator model is the actionable,
        // easy-to-miss degradation — record why so `/health` can surface it.
        let mut ant_reason: Option<String> = None;
        let mut gap_reason: Option<String> = None;
        let ant_ep = match ep {
            EpSelect::Cpu => AntEp::Cpu,
            EpSelect::Auto => {
                if cfg!(target_os = "macos") {
                    if ant_bucket_model_path.is_some() {
                        AntEp::CoreMlBucket
                    } else {
                        ant_reason = Some(
                            "accelerator model not configured (--ant-model-bucket / \
                             ant_v2_fp32_bucket.onnx)"
                                .into(),
                        );
                        AntEp::Cpu
                    }
                } else if cfg!(target_os = "windows") {
                    // The tiled model is what makes DirectML worthwhile (the
                    // stock model's scatter falls back to CPU); only auto-enable
                    // DML when it is present.
                    if ant_tiled_model_path.is_some() {
                        AntEp::Dml
                    } else {
                        ant_reason = Some(
                            "accelerator model not configured (--ant-model-tiled / \
                             ant_v2_fp32_tiledscatter.onnx)"
                                .into(),
                        );
                        AntEp::Cpu
                    }
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
        // GapCloser: CoreML on macOS under coreml/auto when its batch-pinned
        // export is supplied; CPU everywhere else.
        let gap_ep = if cfg!(target_os = "macos") && matches!(ep, EpSelect::Auto | EpSelect::CoreMl)
        {
            if gap_bucket_model_path.is_some() {
                GapEp::CoreMl
            } else {
                gap_reason = Some(
                    "accelerator model not configured (--gap-model-bucket / \
                     gap_closer_fp32_bucket.onnx)"
                        .into(),
                );
                GapEp::Cpu
            }
        } else {
            GapEp::Cpu
        };
        tracing::info!(
            ant_ep = Self::ep_label(ant_ep),
            gap_ep = if gap_ep == GapEp::CoreMl { "coreml" } else { "cpu" },
            "execution providers resolved"
        );
        Ok(Engine {
            gap_model_path,
            gap_bucket_model_path,
            ant_model_path,
            ant_bucket_model_path,
            ant_tiled_model_path,
            coreml_cache_dir,
            ant_ep,
            gap_ep,
            gap: Mutex::new(None),
            gap_coreml: Mutex::new(None),
            gap_coreml_failed: AtomicBool::new(false),
            ant: Mutex::new(None),
            ant_bucket: Mutex::new(None),
            ant_bucket_gate: AtomicU8::new(GATE_IDLE),
            ant_accel_reason: Mutex::new(ant_reason),
            gap_accel_reason: Mutex::new(gap_reason),
        })
    }

    /// Record why a capability lost (or never got) acceleration; the app
    /// reads it from `/health`.
    fn note_accel_reason(slot: &Mutex<Option<String>>, reason: &str) {
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(reason.to_string());
        }
    }

    /// The `/health` acceleration report: per capability, the planned EP,
    /// what the next request actually gets, and the reason when degraded.
    pub fn accel_report(&self) -> AccelReport {
        let ant_reason = self.ant_accel_reason.lock().ok().and_then(|g| g.clone());
        let colorize = match self.ant_ep {
            AntEp::Cpu => AccelCapability { planned: "cpu", active: "cpu", reason: ant_reason },
            // A DirectML init failure latches a reason and serves from CPU;
            // until the first build the report is optimistic.
            AntEp::Dml => AccelCapability {
                planned: "dml",
                active: if ant_reason.is_some() { "cpu" } else { "dml" },
                reason: ant_reason,
            },
            AntEp::CoreMlBucket => AccelCapability {
                planned: "coreml",
                active: match self.ant_bucket_gate.load(Ordering::SeqCst) {
                    GATE_BUILDING => "building",
                    GATE_FAILED => "cpu",
                    // READY, or IDLE (harnesses build inline on first use).
                    _ => "coreml",
                },
                reason: ant_reason,
            },
        };
        let gap_reason = self.gap_accel_reason.lock().ok().and_then(|g| g.clone());
        let segment = match self.gap_ep {
            GapEp::Cpu => AccelCapability { planned: "cpu", active: "cpu", reason: gap_reason },
            GapEp::CoreMl => AccelCapability {
                planned: "coreml",
                active: if self.gap_coreml_failed.load(Ordering::SeqCst) { "cpu" } else { "coreml" },
                reason: gap_reason,
            },
        };
        AccelReport { colorize, segment }
    }

    /// Build the CoreML sessions in a background thread so the first user
    /// request doesn't pay for them: the GapCloser bucket compiles in ~3s,
    /// the AnT bucket in ~107s cold / ~20s from the model cache. While the
    /// AnT build is in flight (or if it failed), `run_ant` serves from the
    /// dynamic CPU session — colorize is never worse than the CPU-only path.
    /// No-op unless the resolved plan actually uses CoreML.
    pub fn prewarm(self: &Arc<Self>) {
        let coreml_wanted =
            self.gap_ep == GapEp::CoreMl || self.ant_ep == AntEp::CoreMlBucket;
        if !coreml_wanted {
            return;
        }
        // Claim the AnT bucket gate now, on the caller's thread (process start,
        // before the server accepts connections). If we spawned first and CAS'd
        // inside the thread, a `/colorize` arriving during the gap build (~3s)
        // would find the gate still IDLE and either block behind — or race into
        // a *second* — the ~107s inline compile. Flipping to BUILDING up front
        // means such a request serves from the CPU session instead.
        let build_ant = self.ant_ep == AntEp::CoreMlBucket
            && self
                .ant_bucket_gate
                .compare_exchange(GATE_IDLE, GATE_BUILDING, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok();
        let engine = Arc::clone(self);
        std::thread::spawn(move || {
            if engine.gap_ep == GapEp::CoreMl {
                if let (Some(path), Ok(mut guard)) =
                    (engine.gap_bucket_model_path.clone(), engine.gap_coreml.lock())
                {
                    if guard.is_none() {
                        match build_coreml_session(
                            "GapCloser bucket",
                            &path,
                            engine.coreml_cache_dir.as_deref(),
                        ) {
                            Ok(session) => *guard = Some(session),
                            // The same compile won't succeed on a lazy retry;
                            // latch it so every /segment goes straight to CPU.
                            Err(e) => {
                                engine.gap_coreml_failed.store(true, Ordering::SeqCst);
                                Self::note_accel_reason(&engine.gap_accel_reason, &e);
                                tracing::warn!(error = %e, "GapCloser prewarm failed; using the CPU EP");
                            }
                        }
                    }
                }
            }
            if build_ant {
                let gate = match engine.build_ant_bucket_state() {
                    Ok(state) => {
                        if let Ok(mut guard) = engine.ant_bucket.lock() {
                            *guard = Some(state);
                            GATE_READY
                        } else {
                            Self::note_accel_reason(
                                &engine.ant_accel_reason,
                                "ant bucket session state poisoned",
                            );
                            GATE_FAILED
                        }
                    }
                    Err(e) => {
                        Self::note_accel_reason(&engine.ant_accel_reason, &e);
                        tracing::warn!(
                            error = %e,
                            "AnT bucket prewarm failed; colorize stays on the dynamic CPU session"
                        );
                        GATE_FAILED
                    }
                };
                engine.ant_bucket_gate.store(gate, Ordering::SeqCst);
            }
        });
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

    /// Run the GapCloser UDF net over every 512x512 tile, returning one udf
    /// plane (`TILE_SIZE*TILE_SIZE` f32) per input tile, in order. `Ok(None)`
    /// when no gap model is configured (the caller does trapped-ball only).
    /// On the CoreML plan tiles are forwarded in fixed batches; a CoreML
    /// build/init error falls back to the CPU EP.
    pub fn run_gap_udfs(&self, tiles: &[PlaneF32]) -> Result<Option<Vec<Vec<f32>>>, String> {
        if self.gap_ep == GapEp::CoreMl && !self.gap_coreml_failed.load(Ordering::SeqCst) {
            match self.run_gap_coreml(tiles) {
                Ok(udfs) => return Ok(Some(udfs)),
                Err(e) => tracing::warn!(
                    error = %e,
                    "CoreML gap-closer unavailable; falling back to the CPU EP"
                ),
            }
        }
        self.run_gap_cpu(tiles)
    }

    /// CPU EP: dynamic gap session (built on first use), one 512x512 tile per
    /// forward — the byte-exact golden path. `Ok(None)` when unconfigured.
    fn run_gap_cpu(&self, tiles: &[PlaneF32]) -> Result<Option<Vec<Vec<f32>>>, String> {
        self.with_gap_session(|session| {
            let mut udfs = Vec::with_capacity(tiles.len());
            for tile in tiles {
                let tensor = OrtTensor::from_array(([1usize, 1, tile.h, tile.w], tile.data.clone()))
                    .map_err(|e| format!("gap tile tensor: {e}"))?;
                let outputs = session
                    .run(ort::inputs!["tiles" => tensor])
                    .map_err(|e| format!("gap-closer forward: {e}"))?;
                let (_, out) = outputs.iter().next().ok_or("gap-closer produced no outputs")?;
                let (_, udf) = out
                    .try_extract_tensor::<f32>()
                    .map_err(|e| format!("gap-closer output: {e}"))?;
                udfs.push(udf.to_vec());
            }
            Ok(udfs)
        })
    }

    /// CoreML EP: batch-pinned gap session (built on first use), tiles
    /// forwarded in chunks of `GAP_COREML_BATCH`, the last chunk zero-padded
    /// (conv is per-sample, so pad tiles don't touch the real outputs).
    fn run_gap_coreml(&self, tiles: &[PlaneF32]) -> Result<Vec<Vec<f32>>, String> {
        let Some(path) = &self.gap_bucket_model_path else {
            return Err("no gap bucket model configured (start with --gap-model-bucket)".into());
        };
        let mut guard = self.gap_coreml.lock().map_err(|_| "gap coreml session poisoned")?;
        if guard.is_none() {
            match build_coreml_session("GapCloser bucket", path, self.coreml_cache_dir.as_deref()) {
                Ok(session) => *guard = Some(session),
                Err(e) => {
                    // Latch the build failure so run_gap_udfs stops retrying a
                    // compile that can't succeed and serves from the CPU EP.
                    self.gap_coreml_failed.store(true, Ordering::SeqCst);
                    Self::note_accel_reason(&self.gap_accel_reason, &e);
                    return Err(e);
                }
            }
        }
        let session = guard.as_mut().unwrap();
        let tile_len = TILE_SIZE * TILE_SIZE;
        let mut udfs: Vec<Vec<f32>> = Vec::with_capacity(tiles.len());
        let mut start = 0;
        while start < tiles.len() {
            let end = (start + GAP_COREML_BATCH).min(tiles.len());
            let mut batch = vec![0f32; GAP_COREML_BATCH * tile_len];
            for (b, tile) in tiles[start..end].iter().enumerate() {
                if tile.data.len() != tile_len {
                    return Err(format!(
                        "gap tile is {}x{}, expected {TILE_SIZE}x{TILE_SIZE}",
                        tile.w, tile.h
                    ));
                }
                batch[b * tile_len..(b + 1) * tile_len].copy_from_slice(&tile.data);
            }
            let tensor = OrtTensor::from_array(([GAP_COREML_BATCH, 1, TILE_SIZE, TILE_SIZE], batch))
                .map_err(|e| format!("gap batch tensor: {e}"))?;
            let outputs = session
                .run(ort::inputs!["tiles" => tensor])
                .map_err(|e| format!("gap-closer CoreML forward: {e}"))?;
            let (_, out) = outputs.iter().next().ok_or("gap-closer produced no outputs")?;
            let (_, data) = out
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("gap-closer output: {e}"))?;
            for b in 0..(end - start) {
                udfs.push(data[b * tile_len..(b + 1) * tile_len].to_vec());
            }
            start = end;
        }
        Ok(udfs)
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
            AntEp::CoreMlBucket => {
                // While a prewarm is compiling the bucket session (or after
                // it failed), serve from the dynamic CPU session instead of
                // blocking this request behind a ~20-107s build.
                match self.ant_bucket_gate.load(Ordering::SeqCst) {
                    GATE_BUILDING => {
                        tracing::info!(
                            "CoreML bucket session still building; serving from the CPU session"
                        );
                        return self.run_ant_dynamic(feed);
                    }
                    GATE_FAILED => return self.run_ant_dynamic(feed),
                    _ => {}
                }
                match pad_feed_to_bucket(feed, &CORPUS_BUCKET) {
                    // A bucket build/forward failure (bad compile, CoreML
                    // runtime error) must not fail the request — the dynamic
                    // CPU session produces the same argmax. run_ant_bucket has
                    // already latched the gate to FAILED on a build error, so
                    // later requests skip straight here.
                    Ok(padded) => match self.run_ant_bucket(&padded) {
                        Ok(out) => Ok(out),
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                "CoreML bucket forward failed; falling back to the dynamic CPU session"
                            );
                            self.run_ant_dynamic(feed)
                        }
                    },
                    Err(why) => {
                        tracing::warn!(
                            %why,
                            "feed exceeds CORPUS_BUCKET; falling back to the dynamic CPU session"
                        );
                        self.run_ant_dynamic(feed)
                    }
                }
            }
        }
    }

    /// The non-CoreML AnT session (CPU EP, or DirectML under `--ep dml` /
    /// Windows `auto`), built on first use.
    fn run_ant_dynamic(&self, feed: &AntFeed) -> Result<(Vec<usize>, Vec<f32>), String> {
        let mut guard = self.ant.lock().map_err(|_| "ant session poisoned")?;
        if guard.is_none() {
            *guard = Some(self.build_ant_session()?);
        }
        run_ant_session(guard.as_mut().unwrap(), feed)
    }

    /// Build the non-CoreML AnT session. Under the Dml plan this prefers the
    /// tiled-scatter model on DirectML (all ops stay on the GPU); if the tiled
    /// model is absent it uses the stock dynamic model on DirectML, and if
    /// DirectML itself can't initialize (e.g. no DirectX-12 device) it falls
    /// back to the stock dynamic model on the CPU EP — so a GPU-less Windows
    /// box still serves, just at CPU speed.
    fn build_ant_session(&self) -> Result<Session, String> {
        if self.ant_ep == AntEp::Dml {
            // Prefer the DML-native tiled model, else the stock model on DML.
            let dml_path = self
                .ant_tiled_model_path
                .as_ref()
                .or(self.ant_model_path.as_ref());
            if let Some(path) = dml_path {
                let what = if self.ant_tiled_model_path.is_some() {
                    "AnT v2 (tiled)"
                } else {
                    "AnT v2 (dynamic)"
                };
                match build_dml_session(what, path) {
                    Ok(session) => return Ok(session),
                    Err(e) => {
                        Self::note_accel_reason(&self.ant_accel_reason, &e);
                        tracing::warn!(
                            error = %e,
                            "DirectML session unavailable; falling back to the stock AnT model on the CPU EP"
                        );
                    }
                }
            }
        }
        let path = self
            .ant_model_path
            .as_ref()
            .ok_or("no AnT model configured (start the sidecar with --ant-model)")?;
        build_cpu_session("AnT v2 (dynamic)", path)
    }

    /// Build the bucket-pinned CoreML session (the expensive step behind
    /// `ant_bucket_gate`).
    fn build_ant_bucket_state(&self) -> Result<BucketState, String> {
        let Some(path) = &self.ant_bucket_model_path else {
            return Err(
                "no bucket AnT model configured (start the sidecar with --ant-model-bucket)"
                    .into(),
            );
        };
        Ok(BucketState {
            session: build_coreml_session("AnT bucket", path, self.coreml_cache_dir.as_deref())?,
            warmed: false,
        })
    }

    /// Bucket-pinned AnT session on CoreML, built on first use when no
    /// prewarm ran (gate IDLE — verify harnesses; the build blocks the
    /// request). `feed` must already be bucket-padded.
    fn run_ant_bucket(&self, feed: &AntFeed) -> Result<(Vec<usize>, Vec<f32>), String> {
        let mut guard = self
            .ant_bucket
            .lock()
            .map_err(|_| "ant bucket session poisoned")?;
        if guard.is_none() {
            match self.build_ant_bucket_state() {
                Ok(state) => {
                    *guard = Some(state);
                    self.ant_bucket_gate.store(GATE_READY, Ordering::SeqCst);
                }
                Err(e) => {
                    Self::note_accel_reason(&self.ant_accel_reason, &e);
                    self.ant_bucket_gate.store(GATE_FAILED, Ordering::SeqCst);
                    return Err(e);
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accel_report_explicit_cpu_plan_carries_no_reason() {
        let e = Engine::new(None, None, None, None, None, EpSelect::Cpu, None).unwrap();
        let r = e.accel_report();
        assert_eq!((r.colorize.planned, r.colorize.active), ("cpu", "cpu"));
        assert!(r.colorize.reason.is_none());
        assert_eq!((r.segment.planned, r.segment.active), ("cpu", "cpu"));
        assert!(r.segment.reason.is_none());
    }

    /// `auto` with no accelerator models: the report must say WHY nothing is
    /// accelerated (the silent-CPU field failure this report exists to catch).
    #[cfg(target_os = "macos")]
    #[test]
    fn accel_report_auto_names_the_missing_accelerator_models() {
        let e = Engine::new(None, None, None, None, None, EpSelect::Auto, None).unwrap();
        let r = e.accel_report();
        assert_eq!(r.colorize.active, "cpu");
        assert!(r.colorize.reason.unwrap().contains("ant-model-bucket"));
        assert_eq!(r.segment.active, "cpu");
        assert!(r.segment.reason.unwrap().contains("gap-model-bucket"));
    }
}
