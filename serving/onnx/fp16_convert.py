"""Checkpoint-free fp16 mixed-precision conversion of an existing fp32 AnT v2 ONNX.

Post-hoc `convert_float_to_float16(keep_io_types=True)` with a curated
`op_block_list` that keeps the numerically-sensitive / unconvertible ops in
fp32 while letting the heavy tensor-core ops (MatMul / Conv / Gemm) run fp16.

  python -m serving.onnx.fp16_convert --in ant_v2_fp32_v3.onnx --out ant_v2_fp16_blk.onnx
  python -m serving.onnx.fp16_convert --in ... --out ... --block ScatterElements LayerNormalization ...

`keep_io_types=True` -> the graph still takes/returns FLOAT at the boundary
(feed fp32, same as GapCloser fp16). Parity is judged downstream by
`parity_replay` (argmax must stay 11/11).
"""
import argparse
import collections
import os

import onnx
from onnx import TensorProto
from onnxruntime.transformers.float16 import convert_float_to_float16, DEFAULT_OP_BLOCK_LIST

# Sensitive / unconvertible ops kept in fp32 on top of the ORT default list.
# ScatterElements: scatter-mean super-pixel pool + svg slot scatter (the known
#   unconvertible op; the mean division is precision-sensitive).
# LayerNormalization / InstanceNormalization / ReduceMean: reductions.
# Softmax: attention (mask uses fp32-min sentinel).
# Resize: UNet up/down-sampling (not in this ORT's default list).
# Div: scatter-mean and normalization divisions.
EXTRA_BLOCK = [
    "ScatterElements",
    "LayerNormalization",
    "InstanceNormalization",
    "ReduceMean",
    "Softmax",
    "Resize",
    "Div",
]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--block", nargs="*", default=None,
                    help="op types to keep fp32 ON TOP OF the ORT default list "
                         "(default: the curated EXTRA_BLOCK)")
    ap.add_argument("--node-block", nargs="*", default=None,
                    help="specific node NAMES to keep fp32")
    args = ap.parse_args()

    extra = args.block if args.block is not None else EXTRA_BLOCK
    block_list = sorted(set(DEFAULT_OP_BLOCK_LIST) | set(extra))
    print(f"loading {args.inp}")
    m = onnx.load(args.inp)

    before = collections.Counter(n.op_type for n in m.graph.node)
    print(f"fp32 nodes: {sum(before.values())}")
    print(f"op_block_list (kept fp32, extra beyond ORT default): {sorted(set(extra))}")

    m16 = convert_float_to_float16(
        m,
        keep_io_types=True,
        op_block_list=block_list,
        node_block_list=args.node_block,
    )

    # The float16 tool can emit, for one fp16 tensor feeding several fp32-blocked
    # consumers, MULTIPLE identical boundary Cast nodes that all PRODUCE THE SAME
    # output tensor name (deterministic "<input>_cast_to_fp32" naming) -> ORT
    # rejects the model ("Duplicate definition of name"). Since those casts are
    # bit-identical (same input, same target dtype), keep the first and drop the
    # rest; consumers already reference the shared output name.
    nodes = m16.graph.node
    producers = {}  # output tensor name -> first producing node index
    to_remove = []
    for i, n in enumerate(nodes):
        for out in n.output:
            if out in producers:
                j = producers[out]
                prev = nodes[j]
                identical = (
                    n.op_type == prev.op_type == "Cast"
                    and list(n.input) == list(prev.input)
                    and [(a.name, a.i) for a in n.attribute] == [(a.name, a.i) for a in prev.attribute]
                )
                if identical:
                    to_remove.append(i)
                else:
                    raise SystemExit(
                        f"non-identical duplicate producer for tensor {out!r} "
                        f"({n.op_type} vs {prev.op_type}) — needs rewiring, not merge")
            else:
                producers[out] = i
    for i in sorted(set(to_remove), reverse=True):
        del nodes[i]
    if to_remove:
        print(f"merged {len(set(to_remove))} duplicate boundary Cast nodes")

    # Also ensure node NAMES are unique (belt and suspenders).
    seen = set()
    for i, n in enumerate(nodes):
        name = n.name or f"node_{i}"
        if name in seen:
            new = f"{name}__dedup{i}"
            while new in seen:
                new += "_x"
            n.name = new
            name = new
        seen.add(name)

    # Report the resulting precision split.
    g = m16.graph
    idt = collections.Counter(TensorProto.DataType.Name(i.data_type) for i in g.initializer)
    casts = collections.Counter()
    for n in g.node:
        if n.op_type == "Cast":
            for a in n.attribute:
                if a.name == "to":
                    casts[TensorProto.DataType.Name(a.i)] += 1
    print(f"initializer dtypes after: {dict(idt)}")
    print(f"cast targets after: {dict(casts)}  (total nodes {len(g.node)})")

    onnx.save(m16, args.out, save_as_external_data=m16.ByteSize() > 2**31 - 100)
    print(f"saved -> {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
