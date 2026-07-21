"""Dump per-stage goldens for AnT v2 postprocess (R2f port gate).

Feeds the PRODUCTION reference logits from the parity_corpus bundles
(the same arrays every ONNX backend is verified against) through an
unmodified `pipeline.postprocess` — assembling model_output exactly as
`_forward` does — and dumps every stage. preprocess is re-run (CPU) to
rebuild the palette / frame objects postprocess consumes; its feed is
asserted against the bundle first, so the inputs provably match.

Runs on wallace:

    PYTHONPATH=. python serving/tools/dump_postprocess_goldens.py /tmp/robot_corpus /tmp/postprocess_goldens \
        --checkpoint /home/evan/dev/cadmium-vision/checkpoints/colorizer/v2-encoder-pretrained-large-tb-aug-7750 \
        --feeds /tmp/robot_feeds

Layout per pair (pair_f<ref>_f<tgt>/):
    01_ids.npz            in_ids (raw argmax predictions), clamped_ids
                          (>= len(color_list) -> -100)
    02_colors.json        target_colors_rgba (palette.color_ids_to_colors)
    03_entropy.npz        num_classes, norm_entropy, entropy_conf_scores
    04_ref_render.png     ref_key_frame.render_color_image()
    05_target_render.png  target_frame.render_as_image(dense colors)
    06_dense_colors.npy   palette.color_ids_to_dense_colors(clamped) array
    meta.json
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from serving.onnx.export_ant_v2 import build_feed, seg_map_for
from serving.onnx.parity_corpus import find_corpus, load_rgba


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("corpus_dir")
    ap.add_argument("out_root")
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--feeds", required=True)
    args = ap.parse_args()

    from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline
    from colorize.common.ops import compute_normalized_entropy

    pipeline = AnTV2Pipeline.from_pretrained(checkpoint=args.checkpoint, verbose=False, device="cpu")
    pipeline.model.eval()

    ref_nr, ref_line_p, ref_color_p, targets = find_corpus(args.corpus_dir, None)
    line_ref, color_ref = load_rgba(ref_line_p), load_rgba(ref_color_p)
    seg_cache = {ref_line_p: seg_map_for(line_ref)}

    anchor0 = np.load(sorted(glob.glob(os.path.join(args.feeds, "pair_*.npz")))[0])
    lowres_hw = tuple(anchor0["feed_ref_seg_lowres"].shape[-2:])

    for nr, tgt_p in targets.items():
        name = f"pair_f{ref_nr}_f{nr}"
        out_dir = os.path.join(args.out_root, name)
        os.makedirs(out_dir, exist_ok=True)
        bundle = np.load(os.path.join(args.feeds, f"{name}.npz"))

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

        # prove this preprocess run matches the bundle the logits came from
        tok = {k: v.cpu() for k, v in prep["tokenized"].items()}
        feed_t, _, _ = build_feed(tok, lowres_hw)
        for k, v in feed_t.items():
            assert np.array_equal(v.numpy(), bundle[f"feed_{k}"]), f"{name}: feed {k} drifted"

        # model_output exactly as _forward assembles it, with the bundle's
        # production logits/ids standing in for the forward pass
        logits = torch.from_numpy(bundle["ref_logits"])   # (1, n_tgt, palette)
        ids = torch.from_numpy(bundle["ref_ids"])         # (1, n_tgt)
        prep["return_colorized"] = True
        model_output = {
            "input": prep,
            "target_color_id_predictions": ids,
            "target_color_logits": logits,
        }
        out = pipeline.postprocess(model_output)

        palette = prep["palette"]
        clamped = [i if i < len(palette.color_list) else -100
                   for i in ids.squeeze(0).tolist()]
        np.savez(os.path.join(out_dir, "01_ids.npz"),
                 in_ids=ids.squeeze(0).numpy(),
                 clamped_ids=np.asarray(clamped, dtype=np.int64))
        with open(os.path.join(out_dir, "02_colors.json"), "w") as f:
            json.dump([[int(x) for x in c] for c in out.target_colors_rgba], f)

        num_classes = len(np.unique(palette.frame_idx_to_color_ids[str(0)]))
        norm_entropy = compute_normalized_entropy(logits, num_classes).squeeze(0)
        np.savez(os.path.join(out_dir, "03_entropy.npz"),
                 num_classes=np.int64(num_classes),
                 norm_entropy=norm_entropy.numpy(),
                 entropy_conf_scores=out.entropy_conf_scores.numpy())

        out.ref_color_image.save(os.path.join(out_dir, "04_ref_render.png"))
        out.target_color_image.save(os.path.join(out_dir, "05_target_render.png"))
        dense = np.array(palette.color_ids_to_dense_colors(out.target_color_ids))
        np.save(os.path.join(out_dir, "06_dense_colors.npy"), dense)

        assert out.target_color_ids == clamped, f"{name}: clamp mismatch"
        meta = {"ref_frame": ref_nr, "target_frame": nr,
                "n_tgt": int(ids.shape[1]), "palette_len": len(palette.color_list),
                "num_classes": num_classes,
                "ref_render_size": list(out.ref_color_image.size),
                "target_render_size": list(out.target_color_image.size)}
        with open(os.path.join(out_dir, "meta.json"), "w") as f:
            json.dump(meta, f, indent=1)
        print(f"{name}: {meta['n_tgt']} segs, num_classes {num_classes}, "
              f"render {out.target_color_image.size}")

    print("all postprocess goldens dumped (inputs feed-asserted against parity bundles)")


if __name__ == "__main__":
    main()
