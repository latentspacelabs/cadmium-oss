import argparse
from typing import *
import os

import torch
from datasets import Dataset
from dotenv import load_dotenv
from transformers import set_seed

from colorize.ant_v1.metrics_ant_v1 import compute_metrics, preprocess_logits_for_metrics
from colorize.datasets.frame_pair_datamodule import FramePairDatamodule
from colorize.ant_v1.model_ant_v1 import AnTV1Model
from colorize.ant_v2.model_ant_v2 import AnTV2Model
from colorize.ant_v2.config_ant_v2 import AnTV2Config
from colorize.ant_v2.tokenizer_ant_v2 import AnTV2Tokenizer
from colorize.vectorization.vtrace import VecArgs
from colorize.common.image import ImageArgs


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--real_dataset_path", type=str, required=True)
    parser.add_argument("--cadmium_dataset_path", type=str, required=True)
    parser.add_argument("--pbc_dataset_path", type=str, required=True)
    parser.add_argument("--synth_dataset_path", type=str, required=True)
    parser.add_argument("--shapes_dataset_path", type=str, required=True)
    parser.add_argument("--handdrawn_dataset_path", type=str, required=True)
    parser.add_argument("--anita_dataset_path", type=str, required=True)
    parser.add_argument("--checkpoint", type=str, required=False)
    parser.add_argument("--debug", action="store_true", help="Debug mode")
    args = parser.parse_args()

    # Load COMET_API_KEY (and any other secrets) from a local .env file.
    # See .env.example for the expected variables. Comet logging is skipped
    # automatically if COMET_API_KEY is unset.
    load_dotenv()
    os.environ["COMET_LOG_ASSETS"] = "True"
    os.environ["COMET_LOG_METRICS"] = "True"
    os.environ["COMET_LOG_HYPERPARAMETERS"] = "True"
    os.environ["COMET_MODE"] = "ONLINE"

    # if args.deterministic:
    #     os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":16:8"  # For CUDA 10.2 or later
    #     torch.backends.cudnn.deterministic = True
    #     torch.backends.cudnn.benchmark = False
    #     torch.use_deterministic_algorithms(True, warn_only=True)
    #     set_seed(1, deterministic=False)

    if not args.debug:
        os.environ["COMET_PROJECT_NAME"] = "ant_v2"
    else:
        os.environ["COMET_PROJECT_NAME"] = "ant_v2_debug"
        torch.cuda.set_device(0)  # Set to whichever GPU you're using
        torch.cuda.synchronize()

    from transformers import TrainingArguments, Trainer
    from transformers.integrations import CometCallback

    if "ant_v2_out" in args.checkpoint:
        model = AnTV2Model.from_pretrained(args.checkpoint)
        model_config = model.config
    elif "ant_v1_out" in args.checkpoint:
        model_config = AnTV2Config()
        model = AnTV2Model(model_config)
        model.ant_v1 = AnTV1Model.from_pretrained(args.checkpoint)
    model.to("cuda")

    vec_args = VecArgs()

    image_args = ImageArgs()
    
    tokenizer = AnTV2Tokenizer(
        image_args=image_args,
        vec_args=vec_args,
        max_segments=model_config.max_segments,
        max_vec_seq_length=model_config.svg_max_seq_length,
        verbose=args.debug,
    )

    datamodule = FramePairDatamodule(
        real_dataset_path=args.real_dataset_path,
        cadmium_dataset_path=args.cadmium_dataset_path,
        pbc_dataset_path=args.pbc_dataset_path,
        synth_dataset_path=args.synth_dataset_path,
        shapes_dataset_path=args.shapes_dataset_path,
        handdrawn_dataset_path=args.handdrawn_dataset_path,
        anita_dataset_path=args.anita_dataset_path,
        tokenizer=tokenizer,
        verbose=args.debug,
        debug=args.debug,
    )
    
    train_ds = datamodule.get_train_ds()
    val_ds = datamodule.get_val_ds()

    training_args = TrainingArguments(
        output_dir="ant_v2_out",
        dataloader_drop_last=True,
        gradient_checkpointing=False,
        gradient_accumulation_steps=8,
        save_strategy="steps",
        evaluation_strategy="steps",
        max_steps=10000,
        eval_steps=250,
        save_steps=250,
        logging_steps=1,
        per_device_train_batch_size=4,
        per_device_eval_batch_size=4,
        learning_rate=1e-4,
        lr_scheduler_type="cosine",
        warmup_steps=100,
        fp16=False,
        bf16=False,
        push_to_hub=False,
        label_names=["target_color_ids"],
        dataloader_num_workers=4,
        seed=1,
        data_seed=1,
        save_safetensors=False,
        max_grad_norm=0.1,
        weight_decay=1e-5,
        remove_unused_columns=False,
    )
    
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=tokenizer.collate,
        compute_metrics=compute_metrics,
        preprocess_logits_for_metrics=preprocess_logits_for_metrics,
    )

    # trainer.add_callback(CometCallback())

    trainer.train()
     
