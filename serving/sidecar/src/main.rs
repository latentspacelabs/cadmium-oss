//! cadmium-sidecar — the embedded Rust serving backend.
//!
//! Serves the exact HTTP contract of the Python server
//! (`serving/local/server.py`): `GET /health` plus `POST /segment`,
//! `/preprocess`, `/colorize` (and its back-compat alias `/predict`), backed
//! by the byte-exact classical ports under `src/` and ONNX Runtime sessions
//! for the two models. Sessions are built lazily on first use, so `/health`,
//! `/preprocess` and strength-0 `/segment` work without any model files.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;

use cadmium_sidecar::serve::engine::{Engine, EpSelect};
use cadmium_sidecar::serve::{self};

#[derive(Parser, Debug)]
#[command(
    name = "cadmium-sidecar",
    version,
    about = "Cadmium ML serving sidecar (Rust)"
)]
struct Args {
    /// Port to listen on.
    #[arg(long, default_value_t = 8001)]
    port: u16,

    /// Host/interface to bind.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    /// AnT v2 colorizer .onnx path (required for /colorize).
    #[arg(long, value_name = "PATH.onnx")]
    ant_model: Option<PathBuf>,

    /// CORPUS_BUCKET-pinned AnT v2 export (all input dims static) for the
    /// CoreML EP; enables `--ep coreml` / the macOS `auto` fast path.
    #[arg(long, value_name = "PATH.onnx")]
    ant_model_bucket: Option<PathBuf>,

    /// Execution provider for the AnT forward: auto|cpu|coreml|dml.
    /// `auto` resolves to coreml on macOS when --ant-model-bucket is
    /// supplied, else cpu. The GapCloser always runs on the CPU EP.
    #[arg(long, default_value = "auto")]
    ep: EpSelect,

    /// GapCloser UDF .onnx path (enables ML gap closing on /segment;
    /// without it /segment runs trapped-ball only, like the Python server
    /// with no --gap-close-checkpoint).
    #[arg(long, value_name = "PATH.onnx")]
    gap_model: Option<PathBuf>,

    /// Exit when stdin reaches EOF. A supervising parent (the Electron app)
    /// spawns us with stdin as a pipe; if the parent dies by ANY means —
    /// including SIGKILL, which fires no quit hooks — the OS closes the
    /// pipe and we exit instead of orphaning.
    #[arg(long, default_value_t = false)]
    exit_on_stdin_close: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            // ONNX Runtime's internal logger (`ort::logging`) is extremely
            // chatty at INFO (per-graph-transformer lines); default it to
            // warn. Override with RUST_LOG as usual.
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,ort::logging=warn".into()),
        )
        .init();

    let args = Args::parse();

    if args.exit_on_stdin_close {
        std::thread::spawn(|| {
            use std::io::Read;
            let mut buf = [0u8; 256];
            let mut stdin = std::io::stdin();
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // Exit WITHOUT logging: stderr is a socketpair whose
                        // peer (the parent) is gone — a write can block
                        // forever instead of failing with EPIPE, which is
                        // exactly the hang this thread exists to prevent.
                        std::process::exit(0);
                    }
                    Ok(_) => {} // parent may write keepalives; ignore content
                }
            }
        });
        // Belt AND suspenders: stdin-EOF wakeups have proven unreliable when
        // the parent is an Electron main process on macOS (the blocked read
        // does not wake on peer close). Orphaning re-parents us to pid 1 on
        // Unix — poll for that; it survives every parent-death mode
        // including SIGKILL.
        #[cfg(unix)]
        std::thread::spawn(|| {
            let original = std::os::unix::process::parent_id();
            let dbg = std::env::var("CADMIUM_SIDECAR_WATCHDOG_DEBUG").ok();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let ppid = std::os::unix::process::parent_id();
                if let Some(path) = &dbg {
                    use std::io::Write;
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                        let _ = writeln!(f, "tick ppid={ppid} original={original}");
                    }
                }
                if ppid == 1 || ppid != original {
                    // Do NOT log via tracing here: stderr is a dead
                    // socketpair at this point and must not be touched on
                    // the exit path.
                    std::process::exit(0);
                }
            }
        });
    }

    let engine = Arc::new(Engine::new(
        args.gap_model,
        args.ant_model,
        args.ant_model_bucket,
        args.ep,
    )?);
    let app = serve::router(engine);

    let addr = SocketAddr::new(args.host, args.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "cadmium-sidecar listening");
    axum::serve(listener, app).await?;
    Ok(())
}
