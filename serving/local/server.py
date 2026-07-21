"""Local (non-Modal) HTTP server exposing the same API as the Modal endpoints.

A single FastAPI process that serves all three ML operations the Cadmium app
needs, with request/response contracts identical to the Modal deployments
(`serving/modal/...`), so any client that talks to Modal works unchanged here:

    POST /colorize    reference-guided colorization        (AnT v2)
    POST /predict     alias of /colorize (back-compat)
    POST /segment     gap-closing + trapped-ball segmentation
    POST /preprocess  reference-assisted palette extraction (v2)
    GET  /health

The handlers under `serving/handlers/` are shared with the Modal stubs, so the
two cannot drift apart. Models are loaded once at startup, so the first request
has no cold-start penalty. Requires a CUDA GPU (see requirements-cuda.txt).

Run:

    python -m serving.local.server \\
        --checkpoint checkpoints/ant_v2 \\
        --gap-close-checkpoint checkpoints/gap_close_v1_1229.ckpt \\
        --host 0.0.0.0 --port 8000

`--gap-close-checkpoint` is optional; without it the /segment endpoint runs
trapped-ball only (no ML gap closing).
"""
import argparse
from typing import *

from fastapi import FastAPI

from serving.handlers.colorize import run_colorize
from serving.handlers.segment import run_segment
from serving.handlers.preprocess import run_preprocess


def _load_gap_closer(checkpoint: str, device: str):
    """Load a GapCloser model the same way the Modal stub does."""
    import torch
    from segmentation.gap_closing.gap_closer import GapCloser

    print(f"Loading gap closer checkpoint from {checkpoint} ...")
    ckpt = torch.load(checkpoint, map_location=device)
    hparams = ckpt.get("hyper_parameters", {})
    model = GapCloser(**hparams)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    model = model.to(device)
    print("Gap closer model loaded")
    return model


def create_app(
    checkpoint: str,
    gap_close_checkpoint: Optional[str] = None,
    device: str = "cuda",
    verbose: bool = True,
) -> FastAPI:
    app = FastAPI(title="cadmium serving (local)")

    from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline

    print(f"Loading colorize pipeline from {checkpoint} ...")
    pipeline = AnTV2Pipeline.from_pretrained(
        checkpoint=checkpoint,
        verbose=verbose,
        device=device,
    )
    pipeline.model.to(device)
    print("Colorize pipeline loaded")

    gap_closer_model = (
        _load_gap_closer(gap_close_checkpoint, device) if gap_close_checkpoint else None
    )

    @app.get("/health")
    def health() -> Dict:
        return {"status": "ok", "gap_closer": gap_closer_model is not None}

    # A single dict body param => the whole JSON body is `input`, matching the
    # Modal `fastapi_endpoint(method="POST")` signature `predict(input: Dict)`.
    @app.post("/colorize")
    def colorize(input: Dict) -> Dict:
        # The app omits return_colorized (the proxy used to inject it); default it on.
        return run_colorize(pipeline, **{"return_colorized": True, **input})

    # Back-compat alias for the previous local server (/predict == /colorize).
    @app.post("/predict")
    def predict(input: Dict) -> Dict:
        return run_colorize(pipeline, **{"return_colorized": True, **input})

    @app.post("/segment")
    def segment(input: Dict) -> Dict:
        return run_segment(gap_closer_model, **input)

    @app.post("/preprocess")
    def preprocess(input: Dict) -> Dict:
        return run_preprocess(**input)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True,
                        help="Path to a trained AnT v2 checkpoint directory.")
    parser.add_argument("--gap-close-checkpoint", default=None,
                        help="Path to a GapCloser .ckpt (optional; enables ML gap closing).")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--device", default="cuda")
    args = parser.parse_args()

    import uvicorn
    app = create_app(
        args.checkpoint,
        gap_close_checkpoint=args.gap_close_checkpoint,
        device=args.device,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
