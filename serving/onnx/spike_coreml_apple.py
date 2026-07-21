"""Spike: run the exported Cadmium ONNX models on Apple Silicon via ORT's
CoreML EP — no MLX, no re-export; the same artifacts the CUDA backend uses.

Verdict + numbers recorded in docs/serving-backends.md §5 ("Apple silicon").
The three mechanical workarounds this spike discovered, all applied here:

1. CoreML needs STATIC shapes: the dynamic-dim graphs fail to compile
   ("Invalid tensor rank 0 inferred from ios18.squeeze" — dynamic-shape
   arithmetic that only folds away with pinned dims). Pinning the input dims
   post-hoc on the .onnx is sufficient; no re-export needed.
2. The naive fp16 AnT conversion cannot run AT ALL on this stack: fp16
   ScatterElements is rejected by both the CoreML partitioner and the CPU EP.
   Re-convert from fp32 with ScatterElements on the op_block_list.
3. ORT's SimplifiedLayerNormFusion crashes at session init on fp16 llama
   graphs (ORT 1.27) — use ORT_ENABLE_BASIC for fp16 AnT sessions.

Usage (models from export_gap_closer.py / export_ant_v2.py):

    python -m serving.onnx.spike_coreml_apple gap /path/gap_closer_fp32.onnx
    python -m serving.onnx.spike_coreml_apple ant /path/ant_v2_fp32.onnx
"""
import contextlib
import io
import os
import re
import sys
import time

import numpy as np
import onnxruntime as ort

H, W = 384, 512
LH, LW = H // 2, W // 2  # AnT encoder UNet outputs at input/2

COMPUTE_UNITS = ["ALL", "CPUAndNeuralEngine", "CPUAndGPU"]


def make_session(path, coreml=None, capture_partitions=False, basic_opt=False):
    so = ort.SessionOptions()
    so.log_severity_level = 2  # warnings: the partition report is logged here
    if basic_opt:
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    providers = ["CPUExecutionProvider"]
    if coreml is not None:
        providers = [
            ("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": coreml}),
            "CPUExecutionProvider",
        ]
    if capture_partitions:
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            sess = ort.InferenceSession(path, sess_options=so, providers=providers)
        m = re.search(r"number of partitions supported[^\n]*", buf.getvalue())
        return sess, (m.group(0) if m else "no partition log")
    return ort.InferenceSession(path, sess_options=so, providers=providers)


def bench(sess, feed, n_iter=3, warmup=1):
    for _ in range(warmup):
        sess.run(None, feed)
    t0 = time.time()
    for _ in range(n_iter):
        out = sess.run(None, feed)
    return (time.time() - t0) / n_iter * 1000, out[0]


def make_static_copy(path, feed):
    """Pin every input dim to the feed's actual shapes (workaround 1)."""
    import onnx

    m = onnx.load(path)
    for inp in m.graph.input:
        shape = feed[inp.name].shape
        for axis, d in enumerate(inp.type.tensor_type.shape.dim):
            d.ClearField("dim_param")
            d.dim_value = shape[axis]
    out = path.replace(".onnx", "_static.onnx")
    onnx.save(m, out, save_as_external_data=m.ByteSize() > 2**31 - 100)
    return out


# ---------------------------------------------------------------------------
def run_gap(path, batch=24):
    print(f"\n== GapCloser: {path} (batch {batch}) ==")
    rng = np.random.default_rng(0)
    x = (rng.random((batch, 1, 512, 512)) < 0.03).astype(np.float32)
    x = np.clip(x + rng.normal(0, 0.01, x.shape).astype(np.float32), 0, 1)
    feed = {"tiles": x}

    t_cpu, ref = bench(make_session(path), feed)
    print(f"  CPU EP: {t_cpu:.1f} ms/batch")

    static = make_static_copy(path, feed)
    for units in COMPUTE_UNITS:
        try:
            sess, report = make_session(static, coreml=units, capture_partitions=True)
            t, out = bench(sess, feed)
        except Exception as e:
            print(f"  CoreML {units}: FAILED — {str(e).splitlines()[-1][:120]}")
            continue
        # what matters downstream is the thresholded boundary, not raw UDF
        agree = ((ref < 0.2) == (out < 0.2)).mean() * 100
        print(f"  CoreML {units}: {t:.1f} ms/batch, max|diff| "
              f"{np.abs(out - ref).max():.2e}, boundary@0.2 {agree:.4f}%  [{report}]")


# ---------------------------------------------------------------------------
def ant_feed(sess, n_slots=16, n_valid=12, seed=0):
    """Synthesize a semantically valid feed from the session's input specs.
    (Synthetic — for EP viability/latency; argmax parity on real drawings is
    the golden corpus's job: parity_corpus.py + parity_replay.py.)
    Layout: one segment per packed row with k = C//2 valid commands each."""
    rng = np.random.default_rng(seed)
    onnx2np = {"tensor(float)": np.float32, "tensor(int64)": np.int64,
               "tensor(bool)": np.bool_, "tensor(float16)": np.float16}
    c = next(i.shape[1] for i in sess.get_inputs() if "svg_packed" in i.name)
    if not isinstance(c, int):
        c = 14  # command dim is dynamic in current exports; any value works
    k = c // 2  # valid commands per segment
    feed = {}
    for inp in sess.get_inputs():
        name, dt = inp.name, onnx2np[inp.type]
        if "line_image" in name:
            img = np.zeros((1, 4, H, W), dtype=np.float32)
            img[:, 3, 50:220, 60:260] = 255
            img[:, 3, 55:215, 65:255] = 0
            feed[name] = img.astype(dt)
        elif "sdf" in name:
            feed[name] = rng.random((1, 1, H, W), dtype=np.float32).astype(dt)
        elif "seg_lowres" in name:
            seg = rng.integers(0, n_slots, (1, 1, LH, LW))
            seg[rng.random((1, 1, LH, LW)) < 0.05] = -100
            feed[name] = seg.astype(dt)
        elif "svg_packed" in name:
            feed[name] = rng.integers(0, 100, (n_valid, c, 6)).astype(dt)
        elif "svg_attn" in name:
            feed[name] = np.ones((n_valid, c, c)).astype(dt)
        elif "flat_idx" in name:
            feed[name] = np.array(
                [r * c + j for r in range(n_valid) for j in range(k)]).astype(dt)
        elif "cmd_slot_idx" in name:
            feed[name] = np.repeat(np.arange(n_valid), k).astype(dt)
        elif "slot_counts" in name:
            counts = np.zeros(n_slots, dtype=np.float32)
            counts[:n_valid] = k
            feed[name] = counts.astype(dt)
        elif "packed_gather_idx" in name:
            feed[name] = np.concatenate(
                [np.arange(n_valid), n_slots + np.arange(n_valid)]).astype(dt)
        elif "packed_attn_mask" in name:
            feed[name] = np.ones((1, 2 * n_valid)).astype(dt)
        elif "scatter_idx" in name or "gather_idx" in name:
            feed[name] = np.arange(n_valid).astype(dt)
        elif name.endswith("color_ids"):
            feed[name] = rng.integers(0, 8, (1, n_slots)).astype(dt)
        elif name.endswith("colors"):
            feed[name] = rng.integers(0, 256, (1, n_slots, 4)).astype(dt)
        else:
            raise ValueError(f"unhandled input {name} {inp.shape} {inp.type}")
    return feed


def convert_fp16_blocked(fp32_path, out_path):
    """Workaround 2: fp16 with ScatterElements kept fp32."""
    import onnx
    from onnxruntime.transformers import float16

    m = onnx.load(fp32_path)
    block = list(getattr(float16, "DEFAULT_OP_BLOCK_LIST", [])) + ["ScatterElements"]
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=block)
    onnx.save(m16, out_path)
    return out_path


def run_ant(fp32_path):
    print(f"\n== AnT v2: {fp32_path} ==")
    cpu = make_session(fp32_path)
    feed = ant_feed(cpu)
    t_cpu, ref = bench(cpu, feed)
    print(f"  fp32 CPU EP: {t_cpu:.1f} ms/forward")
    del cpu

    static32 = make_static_copy(fp32_path, feed)
    for units in ["ALL", "CPUAndGPU"]:  # fp32 never runs on the ANE
        try:
            sess, report = make_session(static32, coreml=units, capture_partitions=True)
            t, out = bench(sess, feed)
        except Exception as e:
            print(f"  fp32 CoreML {units}: FAILED — {str(e).splitlines()[-1][:120]}")
            continue
        agree = (out.argmax(-1) == ref.argmax(-1)).mean() * 100
        print(f"  fp32 CoreML {units}: {t:.1f} ms/forward, argmax vs CPU {agree:.1f}%  [{report}]")
        del sess

    fp16b = convert_fp16_blocked(fp32_path, fp32_path.replace(".onnx", "_fp16_blocked.onnx"))
    print(f"  blocked-fp16: {os.path.getsize(fp16b) / 1e6:.1f} MB")
    static16 = make_static_copy(fp16b, feed)
    for units in COMPUTE_UNITS:
        try:
            sess, report = make_session(static16, coreml=units,
                                        capture_partitions=True, basic_opt=True)
            t, out = bench(sess, feed)
        except Exception as e:
            print(f"  fp16b CoreML {units}: FAILED — {str(e).splitlines()[-1][:120]}")
            continue
        agree = (out.argmax(-1) == ref.argmax(-1)).mean() * 100
        print(f"  fp16b CoreML {units}: {t:.1f} ms/forward, argmax vs fp32 CPU {agree:.1f}%, "
              f"max|dlogit| {np.abs(out - ref).max():.3f}  [{report}]")
        del sess


if __name__ == "__main__":
    which, paths = sys.argv[1], sys.argv[2:]
    for p in paths:
        run_gap(p) if which == "gap" else run_ant(p)
