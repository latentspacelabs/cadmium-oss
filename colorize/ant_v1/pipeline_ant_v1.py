
from typing import *
import argparse
import time
import os
from dataclasses import dataclass

import torch
import numpy as np
from PIL import Image
from transformers import Pipeline

from colorize.ant_v1.model_ant_v1 import AnTV1Model, AnTV1Output
from colorize.ant_v1.tokenizer_ant_v1 import AnTV1Tokenizer
from colorize.ant_v2.model_ant_v2 import AnTV2Model, AnTV2Output
from colorize.ant_v2.tokenizer_ant_v2 import AnTV2Tokenizer
from colorize.common.image import ImageArgs
from colorize.common.ops import rgba_to_dense_flat
from colorize.vectorization.vtrace import VecArgs
from colorize.common.frame import (
    KeyFrame,
    LineImageFrame,
    MaterializedKeyFrame,
    Palette,
    SegImageFrame,
    ColorImageFrame,
)
from colorize.common.sequence import PartialSequence

@dataclass
class AnTV1PipelineOutput:

    target_colors_rgba: List[int]
    target_color_ids: List[int]

    ref_color_image: Image = None
    target_color_image: Image = None


class AnTV1Pipeline(Pipeline):

    def __init__(
        self,
        model: AnTV1Model,
        tokenizer: AnTV1Tokenizer,
        verbose: bool = False,
        device: str = "cuda",
    ):
        super().__init__(model=model, tokenizer=tokenizer, device=device)
        self.verbose = verbose

    @classmethod
    def from_pretrained(
        cls,
        checkpoint: str,
        verbose: bool = False,
        device: str = "cuda",
    ):
        model = AnTV1Model.from_pretrained(
            pretrained_model_name_or_path=checkpoint,
        )
        tokenizer = AnTV1Tokenizer(
            image_args=ImageArgs(),
            vec_args=VecArgs(),
            max_segments=model.config.max_segments,
            max_vec_seq_length=model.config.svg_max_seq_length,
        )
        return AnTV1Pipeline(
            model=model,
            tokenizer=tokenizer,
            verbose=verbose,
            device=device,
        )

    def _sanitize_parameters(self, **kwargs):
        preprocess_kwargs = kwargs
        postprocess_kwargs = kwargs
        return preprocess_kwargs, {}, postprocess_kwargs
    
    def preprocess(
        self,
        inputs: Dict[str, Any],
        **kwargs
    ) -> Dict[str, torch.Tensor]:
        start = time.time()

        # type hints
        self.model: Union[AnTV1Model, AnTV2Model]
        self.tokenizer: Union[AnTV1Tokenizer, AnTV2Tokenizer]

        ref_seg_frame = SegImageFrame.from_image(inputs["ref_seg_image"], 0)
        ref_line_frame = LineImageFrame.from_image(inputs["ref_line_image"], 0)

        if "ref_color_list" in inputs:
            ref_color_list = inputs["ref_color_list"]
        elif "ref_colors_rgba" in inputs:
            ref_colors_rgba = inputs["ref_colors_rgba"]
            ref_color_list = [rgba_to_dense_flat(np.array(c)) for c in ref_colors_rgba]
        elif "ref_color_image" in inputs:
            ref_color_frame = ColorImageFrame.from_image(inputs["ref_color_image"], 0)
            ref_color_list, _ = KeyFrame.compute_color_list(ref_seg_frame, ref_color_frame, ref_line_frame)
        else:
            raise ValueError("No reference color information provided")

        ref_key_frame = MaterializedKeyFrame.from_frames(
            seg_frame=ref_seg_frame,
            line_frame=ref_line_frame,
            color_list=ref_color_list, 
        )

        target_seg_frame = SegImageFrame.from_image(inputs["target_seg_image"], 1)
        target_line_frame = LineImageFrame.from_image(inputs["target_line_image"], 1)

        partial_seq = PartialSequence.from_keyframes(
            ref_keyframes=[ref_key_frame],
            target_seg_frames=[target_seg_frame],
            target_line_frames=[target_line_frame],
            unique_color_ids=kwargs.get("unique_color_ids", False),
        )
        print(f"Time to prepare partial sequence: {time.time() - start} seconds")

        start = time.time()
        partial_seq.prepare_images_for_inference(
            image_args=self.tokenizer.image_args,
            vec_args=self.tokenizer.vec_args,
            verbose=self.verbose,
        )
        print(f"Time to prepare images for inference: {time.time() - start} seconds")

        start = time.time()
        tokenized = self.tokenizer.from_partial_seq(partial_seq)
        print(f"Time to tokenize: {time.time() - start} seconds")

        start = time.time()
        for k, v in tokenized.items():
            v.to(self.model.device)
        print(f"Time to move to device: {time.time() - start} seconds")


        return {
            "tokenized": tokenized,
            "ref_key_frame": ref_key_frame,
            "target_seg_frame": target_seg_frame,
            "target_line_frame": target_line_frame,
            "palette": partial_seq.palette,
            **kwargs
        }

    def _forward(self, model_inputs: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
        start = time.time()
        with torch.inference_mode():
            outputs: AnTV1Output = self.model(**model_inputs["tokenized"])
        end = time.time()
        print(f"Time to do model inference: {end - start} seconds")
        return {
            "input": model_inputs,
            "target_color_id_predictions": outputs.target_color_id_predictions
        }

    def postprocess(
        self,
        model_output: Dict[str, torch.Tensor],
        **kwargs
    ):
        palette: Palette = model_output["input"]["palette"]
        target_color_ids = model_output["target_color_id_predictions"].squeeze(0).tolist()
        target_colors_rgba = palette.color_ids_to_colors(target_color_ids)

        if model_output["input"]["return_colorized"] == True:
            # render ref color image
            ref_key_frame: MaterializedKeyFrame = model_output["input"]["ref_key_frame"]
            ref_color_image = Image.fromarray(ref_key_frame.render_color_image())

            # render target color image
            target_frame: SegImageFrame = model_output["input"]["target_seg_frame"]
            target_color_list = np.array(palette.color_ids_to_dense_colors(target_color_ids))
            target_color_image = Image.fromarray(target_frame.render_as_image(target_color_list))

            # render svg
            # ref_color_svg = ref_key.seg_frame.render_color_svg_frame(ref_color_ids, palette)
            # target_color_svg = target_frame.render_color_svg_frame(target_color_ids, palette)
        else:
            ref_color_image = None
            target_color_image = None

        # no batch dim
        return AnTV1PipelineOutput(
            target_colors_rgba=target_colors_rgba,
            target_color_ids=target_color_ids,
            ref_color_image=ref_color_image,
            target_color_image=target_color_image,
        )


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=str, required=False, help="Checkpoint path to resume training from")
    args = parser.parse_args()

    # project_path = "./data/cadmium-data-2024_03_28/0cd42c890e9108bf51a8a5357db3f57c3083429f240bcd62d281b2e0a2ab046c/41897821/2024_2_6_1_54_29"
    # ref_color_path = os.path.join(project_path, "color_0.png")
    # ref_line_path = os.path.join(project_path, "line_0.png")
    # ref_seg_path = os.path.join(project_path, "seg_0.png")
    # target_seg_path = os.path.join(project_path, "seg_2.png")
    # target_line_path = os.path.join(project_path, "line_2.png")

    project_path = "./toei_frames"
    ref_color_image = Image.open(os.path.join(project_path, "color/A_00001.png"))
    ref_seg_image = Image.open(os.path.join(project_path, "seg/A_00001.png"))
    ref_line_image = Image.open(os.path.join(project_path, "line/A_00001.png"))
    target_seg_image = Image.open(os.path.join(project_path, "seg/A_00002.png"))
    target_line_image = Image.open(os.path.join(project_path, "line/A_00002.png"))

    pipeline = AnTV1Pipeline.from_pretrained(
        checkpoint=args.checkpoint,
        verbose=True,
    )
    pipeline.model.to("cuda")

    out = pipeline(
        inputs={
            "ref_seg_image": ref_seg_image,
            "ref_line_image": ref_line_image,
            "ref_color_image": ref_color_image,
            "target_seg_image": target_seg_image,
            "target_line_image": target_line_image,
        },
        return_colorized=True,
        unique_color_ids=True,
    )

    out.ref_color_image.save("ref_color_image.png")
    out.target_color_image.save("target_color_image.png")

    print(out.target_colors_rgba)
    print(out.target_color_ids)
