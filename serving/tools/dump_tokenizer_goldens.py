"""Dump per-stage goldens for AnT v2 preprocess/tokenization (R2d/R2e port gate).

Runs the PRODUCTION `pipeline.preprocess` + `build_feed` on the robot corpus
with recording wrappers monkeypatched around the stage boundaries — the
production code itself runs unmodified — then asserts the resulting ONNX
feed is byte-identical to the already-verified parity_corpus bundles
(`--feeds`), so these goldens are anchored to the same arrays that scored
11/11 100% against the production GPU forward.

Runs on wallace (production env; CPU is fine — preprocess has no CUDA math):

    PYTHONPATH=. python serving/tools/dump_tokenizer_goldens.py /tmp/robot_corpus /tmp/tokenizer_goldens \
        --checkpoint /home/evan/dev/cadmium-vision/checkpoints/colorizer/v2-encoder-pretrained-large-tb-aug-7750 \
        --feeds /tmp/robot_feeds

Layout per pair (pair_f<ref>_f<tgt>/):
    00_ref_svg.svg, 00_tgt_svg.svg   exact SVG strings SVG.from_str parsed
                                     (recorded inside SVG.load_svg, call order
                                     ref-then-target)
    01_color_list.json               KeyFrame.compute_color_list output for the ref
    02_vec_tokens.npz                get_vec_tokens return: ref/target per-path
                                     command tensors (S,C,6), packed, attn masks
    03_mask_ids.npz                  mask_null_color_ids input ids + output ids
    04_tokenized.npz                 the full tokenized dict (images included —
                                     these are the R2e resize/SDF-side goldens)
    05_feed.npz                      build_feed output (what the ONNX graph eats),
                                     asserted equal to the parity_corpus bundle
    meta.json                        shapes, viewbox, vec/image args, versions
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from serving.onnx.export_ant_v2 import build_feed, seg_map_for
from serving.onnx.parity_corpus import find_corpus, load_rgba

from colorize.vectorization.lib.svg import SVG
from colorize.ant_v1.tokenizer_ant_v1 import AnTV1Tokenizer
from colorize.common.frame import KeyFrame

RECORD = {}


def install_recorders():
    orig_load_svg = SVG.load_svg  # staticmethod: class access yields the plain function

    def rec_load_svg(file_path):
        with open(file_path, "r") as f:
            RECORD.setdefault("svg_strings", []).append(f.read())
        return orig_load_svg(file_path)

    SVG.load_svg = staticmethod(rec_load_svg)

    orig_vec = AnTV1Tokenizer.get_vec_tokens

    def rec_vec(self, *a, **kw):
        out = orig_vec(self, *a, **kw)
        RECORD["vec_tokens"] = {k: v.detach().cpu().numpy().copy() for k, v in out.items()}
        return out

    AnTV1Tokenizer.get_vec_tokens = rec_vec

    orig_mask = AnTV1Tokenizer.mask_null_color_ids

    def rec_mask(self, seg_image, color_ids, debug_path):
        out = orig_mask(self, seg_image, color_ids, debug_path)
        RECORD["mask_ids"] = {
            "in_ids": np.asarray(color_ids).copy(),
            "out_ids": out.detach().cpu().numpy().copy(),
        }
        return out

    AnTV1Tokenizer.mask_null_color_ids = rec_mask

    orig_ccl = KeyFrame.compute_color_list

    def rec_ccl(*a, **kw):
        out = orig_ccl(*a, **kw)
        RECORD["color_list"] = [list(map(int, c)) if hasattr(c, "__len__") else int(c)
                                for c in out[0]]
        return out

    KeyFrame.compute_color_list = staticmethod(rec_ccl)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("corpus_dir")
    ap.add_argument("out_root")
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--feeds", required=True,
                    help="parity_corpus --dump dir; the anchor the new goldens must match")
    ap.add_argument("--ref-frame", type=int, default=None)
    args = ap.parse_args()

    from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline

    pipeline = AnTV2Pipeline.from_pretrained(checkpoint=args.checkpoint, verbose=False, device="cpu")
    pipeline.model.eval()
    install_recorders()

    ref_nr, ref_line_p, ref_color_p, targets = find_corpus(args.corpus_dir, args.ref_frame)
    print(f"corpus: ref frame {ref_nr}, {len(targets)} targets")

    line_ref = load_rgba(ref_line_p)
    color_ref = load_rgba(ref_color_p)
    seg_cache = {ref_line_p: seg_map_for(line_ref)}

    # lowres probed once by parity_corpus; read it from the anchor bundles
    anchor0 = np.load(sorted(glob.glob(os.path.join(args.feeds, "pair_*.npz")))[0])
    lowres_hw = tuple(anchor0["feed_ref_seg_lowres"].shape[-2:])
    print(f"lowres_hw from anchor bundles: {lowres_hw}")

    tok_cfg = pipeline.tokenizer
    for nr, tgt_p in targets.items():
        name = f"pair_f{ref_nr}_f{nr}"
        out_dir = os.path.join(args.out_root, name)
        os.makedirs(out_dir, exist_ok=True)
        RECORD.clear()

        line_tgt = load_rgba(tgt_p)
        if tgt_p not in seg_cache:
            seg_cache[tgt_p] = seg_map_for(line_tgt)
        prep = pipeline.preprocess(inputs={
            "ref_seg_image": seg_cache[ref_line_p],
            "ref_line_image": line_ref,
            "target_seg_image": seg_cache[tgt_p],
            "target_line_image": line_tgt,
            "ref_color_image": color_ref,
        })
        tok = {k: v.cpu() for k, v in prep["tokenized"].items()}
        feed_t, ref_idx, tgt_idx = build_feed(tok, lowres_hw)
        feed_np = {k: v.numpy() for k, v in feed_t.items()}

        assert len(RECORD.get("svg_strings", [])) == 2, \
            f"expected 2 SVG.load_svg calls, got {len(RECORD.get('svg_strings', []))}"
        with open(os.path.join(out_dir, "00_ref_svg.svg"), "w") as f:
            f.write(RECORD["svg_strings"][0])
        with open(os.path.join(out_dir, "00_tgt_svg.svg"), "w") as f:
            f.write(RECORD["svg_strings"][1])
        with open(os.path.join(out_dir, "01_color_list.json"), "w") as f:
            json.dump(RECORD["color_list"], f)
        np.savez(os.path.join(out_dir, "02_vec_tokens.npz"), **RECORD["vec_tokens"])
        np.savez(os.path.join(out_dir, "03_mask_ids.npz"), **RECORD["mask_ids"])
        np.savez(os.path.join(out_dir, "04_tokenized.npz"),
                 **{k: v.numpy() for k, v in tok.items()})
        np.savez(os.path.join(out_dir, "05_feed.npz"), **feed_np)

        # anchor: byte-identical to the bundle that scored 100% vs production GPU
        anchor = np.load(os.path.join(args.feeds, f"{name}.npz"))
        for k, v in feed_np.items():
            ak = f"feed_{k}"
            assert ak in anchor.files, f"{name}: {ak} missing from anchor bundle"
            assert np.array_equal(v, anchor[ak]), f"{name}: {k} drifted from anchor bundle"

        meta = {
            "ref_frame": ref_nr, "target_frame": nr,
            "n_ref": len(ref_idx), "n_tgt": len(tgt_idx),
            "lowres_hw": list(lowres_hw),
            "vec_args": vars(tok_cfg.vec_args),
            "image_args": {k: v for k, v in vars(tok_cfg.image_args).items()
                           if isinstance(v, (int, float, str, bool, list, tuple))},
            "max_segments": tok_cfg.max_segments,
            "max_vec_seq_length": tok_cfg.max_vec_seq_length,
            "torch": torch.__version__,
        }
        with open(os.path.join(out_dir, "meta.json"), "w") as f:
            json.dump(meta, f, indent=1, default=str)
        print(f"{name}: {meta['n_ref']}+{meta['n_tgt']} segs, "
              f"ref svg {RECORD['vec_tokens']['ref_seg_svg'].shape}, anchor OK")

    print("all tokenizer goldens dumped + anchored to parity bundles")


if __name__ == "__main__":
    main()
