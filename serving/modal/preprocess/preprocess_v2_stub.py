from typing import *

import modal
from modal import fastapi_endpoint

from serving.modal.preprocess.image import v2_image
from serving.handlers.preprocess import run_preprocess


app = modal.App("cadmium-preprocess-web-v2")
app.image = v2_image


@app.cls(
    image=v2_image,
    scaledown_window=300,
    min_containers=0,
    cloud="aws",
    cpu=16.0,
    enable_memory_snapshot=True,
)
class Preprocessor:

    @fastapi_endpoint(method="POST")
    def preprocess(self, input: Dict) -> Dict:
        for k, v in input.items():
            if 'uri' not in k:
                print(f'{k}: {v}')

        # Shared with the local server (serving/handlers) to keep the API contract identical.
        return run_preprocess(**input)
