from typing import *
import os

import modal
from modal import fastapi_endpoint, enter

from serving.modal.colorize.image import image
from serving.handlers.colorize import run_colorize


app = modal.App("cadmium-colorize-web-v2.0-08112025")
app.image = image
volume = modal.Volume.from_name("cadmium-colorizer-weights")

MODEL_DIR = "/models"

@app.cls(
    image=image,
    scaledown_window=300,
    gpu="A10G",
    cloud="aws",
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    volumes={MODEL_DIR: volume}
)
class Colorizer:

    @enter(snap=True)
    def load(self):
        from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline

        print("Loading pipeline")
        self.pipeline = AnTV2Pipeline.from_pretrained(
            checkpoint=os.path.join(MODEL_DIR, "v2-encoder-pretrained-large-10000"),
            verbose=True,
            device="cuda",
        )
        # self.pipeline.model = torch.compile(self.pipeline.model)
        print("Pipeline loaded")

    @fastapi_endpoint(method="POST")
    def predict(self, input: Dict) -> Dict:
        for k, v in input.items():
            if 'uri' not in k:
                print(f'{k}: {v}')

        # Shared with the local server (serving/handlers) to keep the API contract identical.
        return run_colorize(self.pipeline, **input)
