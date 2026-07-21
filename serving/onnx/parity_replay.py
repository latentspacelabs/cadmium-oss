"""Replay parity_corpus.py's dumped feed bundles on this machine's EPs.

Each .npz carries every ONNX graph input plus the production GPU/bf16
reference logits/color-ids, so this needs no CUDA, no checkpoint, and no
Python pipeline — it is how non-NVIDIA targets (Apple silicon CoreML EP,
plain CPU) get verified against true production outputs.

    python -m serving.onnx.parity_replay --onnx ant_v2.onnx --feeds /tmp/robot_feeds
    python -m serving.onnx.parity_replay --onnx ant_v2.onnx --feeds /tmp/robot_feeds \\
        --coreml ALL          # macOS: also run the CoreML EP

CoreML requires static shapes. The replay first tries pinning ONLY the image
dims (constant across a corpus — the varying dims are segment counts): if
that compiles, one session serves every pair. Otherwise it falls back to
pinning all dims per pair (slow: one CoreML compile each).
"""
import argparse
import glob
import os
import sys
import time

import numpy as np


def make_session(path, coreml=None, basic_opt=False, dml=False, enable_profiling=False):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3
    if basic_opt:
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    if enable_profiling:
        # dumps a chrome-trace JSON (per-node dur + args.provider) next to the
        # model — feed it to serving/onnx/dml_profile.py or dml_bench.py to see
        # the DML-vs-CPU op split and where the wall-clock goes.
        so.enable_profiling = True
        so.profile_file_prefix = os.path.join(os.path.dirname(path) or ".", "antprof")
    providers = ["CPUExecutionProvider"]
    if coreml is not None:
        providers = [
            ("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": coreml}),
            "CPUExecutionProvider",
        ]
    elif dml:
        # Windows DirectML (onnxruntime-directml wheel)
        providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
    return ort.InferenceSession(path, sess_options=so, providers=providers)


def make_iobinding_runner(sess):
    """Return run(feed)->logits that uses IOBinding: inputs bound from CPU,
    outputs bound to the session's device, output copied back once. On DML this
    only removes the SESSION-boundary host<->device copies (small here); it does
    NOT touch the internal MemcpyToHost around the CPU-fallback ScatterElements,
    which is where the DML wall-clock actually goes (see the ORT profile)."""
    out_names = [o.name for o in sess.get_outputs()]

    def run(feed):
        io = sess.io_binding()
        for name, arr in feed.items():
            io.bind_cpu_input(name, arr)
        for name in out_names:
            io.bind_output(name)
        sess.run_with_iobinding(io)
        return io.copy_outputs_to_cpu()[0]

    return run


def pin_dims(src, dst, feed, only=None):
    """Copy of the model with input dims pinned to this feed's shapes.
    `only`: restrict pinning to input names for which only(name) is True."""
    import onnx

    m = onnx.load(src)
    for inp in m.graph.input:
        if only and not only(inp.name):
            continue
        shape = feed[inp.name].shape
        for axis, d in enumerate(inp.type.tensor_type.shape.dim):
            d.ClearField("dim_param")
            d.dim_value = shape[axis]
    onnx.save(m, dst, save_as_external_data=m.ByteSize() > 2**31 - 100)
    return dst


def load_pairs(feeds_dir, bucketed=False):
    prefix = "bucket_feed_" if bucketed else "feed_"
    pairs = []
    for p in sorted(glob.glob(os.path.join(feeds_dir, "pair_*.npz"))):
        z = np.load(p)
        feed = {k[len(prefix):]: z[k] for k in z.files if k.startswith(prefix)}
        if bucketed and not feed:
            sys.exit(f"{p} has no bucket_feed_* arrays — re-dump with --bucket-test")
        pairs.append({
            "name": os.path.basename(p).replace(".npz", ""),
            "feed": feed,
            "ref_ids": z["ref_ids"], "n_ref": int(z["n_ref"]), "n_tgt": int(z["n_tgt"]),
        })
    if not pairs:
        sys.exit(f"no pair_*.npz in {feeds_dir}")
    return pairs


IMAGE_INPUTS = ("line_image", "sdf", "seg_lowres")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--feeds", required=True)
    ap.add_argument("--coreml", default=None,
                    help="also run the CoreML EP with these compute units (ALL / CPUAndGPU / CPUAndNeuralEngine)")
    ap.add_argument("--dml", action="store_true",
                    help="also run the DirectML EP (Windows, onnxruntime-directml)")
    ap.add_argument("--basic-opt", action="store_true",
                    help="ORT_ENABLE_BASIC (needed for fp16 llama graphs)")
    ap.add_argument("--skip-cpu", action="store_true")
    ap.add_argument("--bucketed", action="store_true",
                    help="use the bucket_feed_* arrays — every pair shares one shape, "
                         "so CoreML compiles ONCE for the whole corpus")
    ap.add_argument("--iobinding", action="store_true",
                    help="DML: run via IOBinding (bind I/O to device) instead of run()")
    ap.add_argument("--profile", action="store_true",
                    help="DML: enable ORT profiling (dumps antprof_*.json next to the model)")
    args = ap.parse_args()

    pairs = load_pairs(args.feeds, bucketed=args.bucketed)
    print(f"{len(pairs)} pairs from {args.feeds}{' (bucketed)' if args.bucketed else ''}")

    runners = {}  # name -> callable(pair) -> logits
    if not args.skip_cpu:
        cpu = make_session(args.onnx, basic_opt=args.basic_opt)
        runners["cpu"] = lambda pair: cpu.run(None, pair["feed"])[0]

    if args.dml:
        dml_sess = make_session(args.onnx, dml=args.dml, basic_opt=args.basic_opt,
                                enable_profiling=args.profile)
        if args.iobinding:
            _iorun = make_iobinding_runner(dml_sess)
            runners["dml"] = lambda pair: _iorun(pair["feed"])
        else:
            runners["dml"] = lambda pair: dml_sess.run(None, pair["feed"])[0]

    coreml_pinned_model = None
    if args.coreml and args.bucketed:
        # bucketed pairs all share one shape: pin EVERYTHING once, compile once
        pinned = args.onnx.replace(".onnx", "_bucketpin.onnx")
        pin_dims(args.onnx, pinned, pairs[0]["feed"])
        sess = make_session(pinned, coreml=args.coreml, basic_opt=args.basic_opt)
        t0 = time.time()
        sess.run(None, pairs[0]["feed"])  # compile happens here
        print(f"CoreML {args.coreml}: bucket-pinned model compiled in {time.time() - t0:.1f} s "
              f"— one session for all pairs")
        runners["coreml"] = lambda pair: sess.run(None, pair["feed"])[0]
        coreml_pinned_model = pinned
    elif args.coreml:
        img_pinned = args.onnx.replace(".onnx", "_imgpin.onnx")
        try:
            pin_dims(args.onnx, img_pinned, pairs[0]["feed"],
                     only=lambda n: any(s in n for s in IMAGE_INPUTS))
            sess = make_session(img_pinned, coreml=args.coreml, basic_opt=args.basic_opt)
            sess.run(None, pairs[0]["feed"])  # compile + smoke here, not in the loop
            runners["coreml"] = lambda pair: sess.run(None, pair["feed"])[0]
            coreml_pinned_model = img_pinned
            print(f"CoreML {args.coreml}: image-dims-only pinning works — one session for all pairs")
        except Exception as e:
            print(f"CoreML image-only pinning failed ({str(e).splitlines()[-1][:100]}); "
                  f"falling back to per-pair pinning")
            pair_pinned = args.onnx.replace(".onnx", "_pairpin.onnx")

            def coreml_per_pair(pair):
                pin_dims(args.onnx, pair_pinned, pair["feed"])
                sess = make_session(pair_pinned, coreml=args.coreml, basic_opt=args.basic_opt)
                return sess.run(None, pair["feed"])[0]

            runners["coreml"] = coreml_per_pair
            coreml_pinned_model = pair_pinned

    results = []
    for pair in pairs:
        row = {"name": pair["name"], "segs": f'{pair["n_ref"]}+{pair["n_tgt"]}'}
        for name, run in runners.items():
            t0 = time.time()
            try:
                logits = run(pair)[:, pair["n_ref"]:pair["n_ref"] + pair["n_tgt"], :]
            except Exception as e:
                print(f"{pair['name']} {name}: FAILED — {str(e).splitlines()[-1][:110]}")
                row[name] = 0.0
                continue
            agree = (logits.argmax(-1) == pair["ref_ids"]).mean() * 100
            row[name] = agree
            row[f"{name}_ms"] = (time.time() - t0) * 1000
        results.append(row)
        scores = "  ".join(
            f"{k} {row[k]:6.2f}% ({row.get(f'{k}_ms', 0):5.0f} ms)" for k in runners if k in row)
        print(f"{row['name']} ({row['segs']:>7} segs): {scores}")

    if coreml_pinned_model and os.path.exists(coreml_pinned_model):
        os.remove(coreml_pinned_model)

    worst = min((row[k] for row in results for k in runners if k in row), default=0.0)
    print(f"\nworst argmax agreement vs production reference: {worst:.2f}%")
    if worst < 100.0:
        sys.exit("PARITY GATE FAILED")
    print("ALL PAIRS EXACT")


if __name__ == "__main__":
    main()
