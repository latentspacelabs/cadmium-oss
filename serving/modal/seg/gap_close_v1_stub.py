from typing import *
import os

from modal import fastapi_endpoint
from modal import enter
import modal

from serving.modal.seg.image import gap_closer_image
from serving.handlers.segment import run_segment


app = modal.App("cadmium-gap-close-v1-12292025")
app.image = gap_closer_image
volume = modal.Volume.from_name("cadmium-gap-close-weights")

MODEL_DIR = "/models"

@app.cls(
    image=gap_closer_image,
    scaledown_window=300,
    gpu="A10G",
    cloud="aws",
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    volumes={MODEL_DIR: volume},
    cpu=16.0,
)
class Segmenter:

    @enter(snap=True)
    def load(self):
        import torch
        from segmentation.gap_closing.gap_closer import GapCloser

        checkpoint_path = os.path.join(MODEL_DIR, "gap_close_v1_1229.ckpt")
        print(f"Loading gap closer checkpoint from {checkpoint_path}...")

        # Load checkpoint manually to bypass Lightning CLI issues
        checkpoint = torch.load(checkpoint_path, map_location='cuda')

        # Extract hyperparameters from checkpoint
        hparams = checkpoint.get('hyper_parameters', {})
        print(f"Checkpoint hyperparameters: {hparams}")

        # Create model instance with hyperparameters
        self.gap_closer_model = GapCloser(**hparams)

        # Load state dict
        self.gap_closer_model.load_state_dict(checkpoint['state_dict'])
        self.gap_closer_model.eval()
        self.gap_closer_model = self.gap_closer_model.cuda()
        print("Gap closer model loaded successfully")

    @fastapi_endpoint(method="POST")
    def segment(self, input: Dict) -> Dict:
        for k, v in input.items():
            if 'uri' not in k:
                print(f'{k}: {v}')

        # Shared with the local server (serving/handlers) to keep the API contract identical.
        return run_segment(self.gap_closer_model, **input)
