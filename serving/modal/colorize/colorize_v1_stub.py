from typing import *
import time
import os

import numpy as np
import modal
from modal import fastapi_endpoint, enter

from serving.modal.colorize.image import image
from segmentation.trapped_ball.serialization import img_to_base64_png_uri, base64_png_uri_to_img


app = modal.App("cadmium-colorize-web-v1.0-08112025")
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
        from colorize.ant_v1.pipeline_ant_v1 import AnTV1Pipeline

        print("Loading pipeline")
        self.pipeline = AnTV1Pipeline.from_pretrained(
            checkpoint=os.path.join(MODEL_DIR, "v1-step-7500"),
            verbose=True,
            device="cuda",
        )
        # self.pipeline.model = torch.compile(self.pipeline.model)
        print("Pipeline loaded")

    @fastapi_endpoint(method="POST")
    def predict(self, input: Dict) -> Dict:
        for k,v in input.items():
            if 'uri' not in k:
                print(f'{k}: {v}')

        return self._call(**input)

    def _call(
        self,
        ref_seg_map_uri: str,
        ref_line_image_uri: str,
        target_seg_map_uri: str,
        target_line_image_uri: str,
        ref_colors_rgba: List[Tuple[int, int, int, int]],
        return_colorized: bool = False,
        unique_color_ids: bool = False,
        **kwargs,
    ) -> Dict:
        start = time.time()
        # convert uris to images
        ref_seg_image = base64_png_uri_to_img(ref_seg_map_uri, is_url_safe=False)
        ref_line_image = base64_png_uri_to_img(ref_line_image_uri, is_url_safe=False)
        target_seg_image = base64_png_uri_to_img(target_seg_map_uri, is_url_safe=False)
        target_line_image = base64_png_uri_to_img(target_line_image_uri, is_url_safe=False)

        print(f"Time to load images: {time.time() - start}")

        out = self.pipeline(
            inputs={
                "ref_seg_image": ref_seg_image,
                "ref_line_image": ref_line_image,
                # "ref_color_image": ref_color_image,
                "target_seg_image": target_seg_image,
                "target_line_image": target_line_image,
                "ref_colors_rgba": ref_colors_rgba,
            },
            return_colorized=return_colorized,
            unique_color_ids=unique_color_ids,
            verbose=True,
        )

        output = {
            "target_colors_rgba": out.target_colors_rgba,
            "target_color_ids": out.target_color_ids,
        }

        if return_colorized:
            target_color_image = out.target_color_image
            target_color_image_uri = img_to_base64_png_uri(np.array(target_color_image))

            ref_color_image = out.ref_color_image
            ref_color_image_uri = img_to_base64_png_uri(np.array(ref_color_image))

            output.update({
                "target_color_image_uri": target_color_image_uri,
                "ref_color_image_uri": ref_color_image_uri,
            })

        return output
