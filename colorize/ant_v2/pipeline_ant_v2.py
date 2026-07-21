from typing import *
import argparse
import time
import os
from dataclasses import dataclass

import torch
import numpy as np
from PIL import Image

from colorize.ant_v1.pipeline_ant_v1 import AnTV1Pipeline
from colorize.ant_v2.config_ant_v2 import AnTV2Config
from colorize.ant_v2.model_ant_v2 import AnTV2Model, AnTV2Output
from colorize.ant_v2.tokenizer_ant_v2 import AnTV2Tokenizer
from colorize.common.image import ImageArgs
from colorize.vectorization.vtrace import VecArgs
from colorize.common.frame import Palette, MaterializedKeyFrame, SegImageFrame
from colorize.common.ops import compute_normalized_entropy

from segmentation.trapped_ball.serialization import img_to_base64_png_uri, base64_png_uri_to_img


@dataclass
class AnTV2PipelineOutput:

    palette: Palette
    target_colors_rgba: List[int]
    target_color_ids: List[int]
    target_color_logits: torch.FloatTensor
    entropy_conf_scores: torch.FloatTensor

    # only if return_colorized is True
    ref_color_image: Image = None
    target_color_image: Image = None



class AnTV2Pipeline(AnTV1Pipeline):

    # TODO: add option for image dims
    @classmethod
    def from_pretrained(
        cls,
        checkpoint: str,
        verbose: bool = False,
        device: str = "cuda",
    ):
        model: AnTV2Model = AnTV2Model.from_pretrained(
            pretrained_model_name_or_path=checkpoint,
        )
        image_args = ImageArgs()
        vec_args = VecArgs()
        tokenizer = AnTV2Tokenizer(
            image_args=image_args,
            vec_args=vec_args,
            max_segments=model.config.max_segments,
            max_vec_seq_length=model.config.svg_max_seq_length,
        )
        return AnTV2Pipeline(
            model=model,
            tokenizer=tokenizer,
            verbose=verbose,
            device=device,
        )
            
    def _forward(self, model_inputs: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
        start = time.time()

        output: AnTV2Output = self.model.forward(
            **model_inputs["tokenized"],
        )

        result = {
            "input": model_inputs,
            "target_color_id_predictions": output.target_color_id_predictions,
            "target_color_logits": output.target_color_logits,
        }

        print(f"Time to do model inference: {time.time() - start} seconds")
        return result 
    

    def postprocess(
        self,
        model_output: Dict[str, torch.Tensor],
        **kwargs
    ):
        palette: Palette = model_output["input"]["palette"]
        target_color_ids = model_output["target_color_id_predictions"].squeeze(0).tolist()
        target_color_ids = [
            target_color_id if target_color_id < len(palette.color_list) else -100
            for target_color_id in target_color_ids
        ]
        target_colors_rgba = palette.color_ids_to_colors(target_color_ids)

        num_classes = len(np.unique(palette.frame_idx_to_color_ids[str(0)]))
        if num_classes > 1:
            norm_entropy = compute_normalized_entropy(model_output["target_color_logits"], num_classes).squeeze(0)
            entropy_conf_scores = 1 - norm_entropy
        else:
            entropy_conf_scores = torch.ones_like(model_output["target_color_logits"][0, :, 0])

        if model_output["input"]["return_colorized"] == True:
            start = time.time()
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
            print(f"Time to render images: {time.time() - start} seconds")
        else:
            ref_color_image = None
            target_color_image = None

        # no batch dim
        return AnTV2PipelineOutput(
            palette=model_output["input"]["palette"],
            target_colors_rgba=target_colors_rgba,
            target_color_ids=target_color_ids,
            target_color_logits=model_output["target_color_logits"].squeeze(0),
            entropy_conf_scores=entropy_conf_scores,
            ref_color_image=ref_color_image,
            target_color_image=target_color_image,
        )
   

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=str, required=True, help="Checkpoint path to resume training from")
    args = parser.parse_args()

    # project_path = "./data/cadmium-data-2024_03_28/0cd42c890e9108bf51a8a5357db3f57c3083429f240bcd62d281b2e0a2ab046c/41897821/2024_2_6_1_54_29"
    # ref_color_path = os.path.join(project_path, "color_0.png")
    # ref_line_path = os.path.join(project_path, "line_0.png")
    # ref_seg_path = os.path.join(project_path, "seg_0.png")
    # target_seg_path = os.path.join(project_path, "seg_2.png")
    # target_line_path = os.path.join(project_path, "line_2.png")

    ref_colors_rgba = [[255,255,255,0],[255,255,255,0],[255,255,255,0],[255,255,255,0],[255,255,255,0],[255,255,255,0],[104,102,96,255],[77,75,69,255],[77,75,69,255],[236,185,143,255],[77,75,69,255],[77,75,69,255],[77,75,69,255],[128,107,88,255],[254,215,186,255],[96,77,61,255],[192,150,118,255],[96,77,61,255],[192,150,118,255],[89,84,76,255],[89,84,76,255],[184,138,101,255],[184,138,101,255],[53,43,33,255],[236,185,143,255],[237,240,241,255],[236,185,143,255],[184,138,101,255],[184,138,101,255],[184,138,101,255],[202,207,230,255],[202,207,230,255],[202,207,230,255],[202,207,230,255],[117,122,126,255],[8,8,8,255],[53,43,33,255],[237,240,241,255],[250,250,250,255],[193,198,203,255],[193,198,203,255],[84,70,55,255],[237,240,241,255],[8,8,8,255],[237,240,241,255],[250,250,250,255],[53,43,33,255],[193,198,203,255],[84,70,55,255],[8,8,8,255],[184,138,101,255],[184,138,101,255],[184,138,101,255],[78,83,87,255],[236,185,143,255],[184,138,101,255],[78,83,87,255],[117,122,126,255],[77,51,36,255],[193,198,203,255],[250,250,250,255],[8,8,8,255],[141,95,67,255],[192,150,118,255],[128,107,88,255],[112,68,66,255],[202,207,230,255],[192,150,118,255],[122,83,62,255],[8,8,8,255],[237,240,241,255],[8,8,8,255],[237,240,241,255],[77,51,36,255],[245,247,249,255],[245,247,249,255],[254,215,186,255],[193,198,203,255],[237,240,241,255],[141,95,67,255],[8,8,8,255],[77,51,36,255],[192,150,118,255],[230,114,138,255],[128,29,29,255],[245,247,249,255],[8,8,8,255],[77,51,36,255],[250,250,250,255],[8,8,8,255],[237,240,241,255],[254,215,186,255],[91,60,43,255],[122,83,62,255],[245,247,249,255],[202,207,230,255],[128,29,29,255],[202,207,230,255],[245,247,249,255],[128,29,29,255],[128,29,29,255],[173,41,41,255],[173,41,41,255],[128,29,29,255],[245,247,249,255],[245,247,249,255],[202,207,230,255],[245,247,249,255],[128,29,29,255],[128,29,29,255],[173,41,41,255],[245,247,249,255],[245,247,249,255],[202,207,230,255],[202,207,230,255],[91,60,43,255],[245,247,249,255],[245,247,249,255],[189,167,42,255],[173,41,41,255],[197,198,198,255],[197,198,198,255],[197,198,198,255],[202,207,230,255],[202,207,230,255],[245,247,249,255],[202,207,230,255],[197,198,198,255],[197,198,198,255],[197,198,198,255],[197,198,198,255]]

    project_path = "./toei_frames"
    ref_color_image = Image.open(os.path.join(project_path, "color/A_00001.png"))
    ref_seg_image = Image.open(os.path.join(project_path, "seg/A_00001.png"))
    ref_line_image = Image.open(os.path.join(project_path, "line/A_00001.png"))
    target_seg_image = Image.open(os.path.join(project_path, "seg/A_00002.png"))
    target_line_image = Image.open(os.path.join(project_path, "line/A_00002.png"))

    pipeline = AnTV2Pipeline.from_pretrained(
        checkpoint=args.checkpoint,
        verbose=True,
    )
    pipeline.model.to("cuda")


    out: AnTV2PipelineOutput = pipeline(
        inputs={
            "ref_colors_rgba": ref_colors_rgba,
            "ref_seg_image": ref_seg_image,
            "ref_line_image": ref_line_image,
            # "ref_color_image": Image.open(ref_color_path),
            "target_seg_image": target_seg_image,
            "target_line_image": target_line_image,
        },
        return_colorized=True,
        # unique_color_ids=True,
    )

    out.ref_color_image.save("ref_color_image.png")
    out.target_color_image.save("target_color_image.png")

    # print(out.target_colors_rgba)
    # print(out.target_color_ids)
    # print(out.entropy_conf_scores)
