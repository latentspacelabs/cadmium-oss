//! The Cadmium serving HTTP contract, implemented in Rust over the verified
//! port modules + ONNX Runtime sessions.
//!
//! Route shapes mirror `serving/local/server.py`: the whole JSON body is the
//! handler's kwargs dict; `/predict` aliases `/colorize`, and both inject
//! `return_colorized=True` when the field is absent (the app omits it).
//! Handlers run on the blocking pool (they are pure CPU work) so `/health`
//! stays responsive.

pub mod codec;
pub mod colorize_impl;
pub mod contract;
pub mod engine;
pub mod preprocess_impl;
pub mod segment_impl;

use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

use contract::{
    ColorizeRequest, ErrorResponse, HealthResponse, PreprocessRequest, SegmentRequest,
};
use engine::Engine;

/// Build the application router over a (lazily-loading) engine.
pub fn router(engine: Arc<Engine>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/segment", post(segment))
        .route("/preprocess", post(preprocess))
        .route("/colorize", post(colorize))
        // Back-compat alias kept from the Python server (/predict == /colorize).
        .route("/predict", post(colorize))
        .with_state(engine)
}

async fn health(State(engine): State<Arc<Engine>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        engine: "sidecar-rust",
        version: env!("CARGO_PKG_VERSION"),
        gap_closer: engine.gap_model_path.is_some(),
        acceleration: engine.accel_report(),
    })
}

fn error_response(msg: String) -> Response {
    tracing::warn!(error = %msg, "handler error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse { error: msg }),
    )
        .into_response()
}

/// Run a blocking handler body on the blocking pool, mapping String errors
/// (and panics — production Python turns both into HTTP 500s) to an error
/// body.
async fn run_blocking<T: serde::Serialize + Send + 'static>(
    route: &'static str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Response {
    let t0 = Instant::now();
    let result = tokio::task::spawn_blocking(f).await;
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    match result {
        Ok(Ok(resp)) => {
            tracing::info!(route, elapsed_ms, "request done");
            Json(resp).into_response()
        }
        Ok(Err(msg)) => error_response(format!("{route}: {msg}")),
        Err(join_err) => error_response(format!("{route}: handler panicked: {join_err}")),
    }
}

async fn segment(State(engine): State<Arc<Engine>>, Json(req): Json<SegmentRequest>) -> Response {
    run_blocking("/segment", move || segment_impl::run_segment(&engine, &req)).await
}

async fn preprocess(
    State(_engine): State<Arc<Engine>>,
    Json(req): Json<PreprocessRequest>,
) -> Response {
    run_blocking("/preprocess", move || preprocess_impl::run_preprocess(&req)).await
}

async fn colorize(State(engine): State<Arc<Engine>>, Json(req): Json<ColorizeRequest>) -> Response {
    run_blocking("/colorize", move || colorize_impl::run_colorize(&engine, &req)).await
}
