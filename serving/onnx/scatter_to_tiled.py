"""DirectML-native, MEMORY-BOUNDED replacement for the AnT v2 pool/SVG
`ScatterElements(reduction='add')` sites — checkpoint-free ONNX surgery.

Approved variant "C1" (bounded tiled one-hot MatMul). The DML EP has no
scatter-add kernel (DirectML's ScatterElements is overwrite-only), so the
scatters fall back to CPU + force ~1 GB of PCIe MemcpyToHost per forward
(~95% of the DML wall-clock; see the profile). A dense one-hot MatMul fixes
that but materializes O(L * num_slots) and can OOM the 16 GB WDDM T4 for
high-segment inputs (max_segments=512, L=262144 -> 536 MB/site) — vetoed.

THE BOUND (the whole point): the two image super-pixel pools scatter over
L=262144 pixels into K = num_slots slots. We compute the segment sum in fixed
SLOT TILES of width T: for each tile we build only a (1, L, T) one-hot,
MatMul it against src, and concat the (1, C, T) partials. Peak intermediate is
O(L * T) — INDEPENDENT of num_slots / max_segments (only the tile COUNT grows,
and each tile's big one-hot is freed before the next). Never materialize the
dense O(L * num_slots) one-hot.

The SVG-slot scatters aggregate V commands into S slots (V, S both small — the
big axis L is absent), so they use a single un-tiled one-hot MatMul; still
bounded (O(S * V)) and DML-native. Result: ZERO ScatterElements remain.

Math is exact fp32 (a fixed-order MatMul reduction), so argmax parity holds
(gate: parity_replay 11/11). Output tensor names are preserved, so the
downstream Clip/Div super-pixel mean is untouched.

    python -m serving.onnx.scatter_to_tiled --in ant_v2_fp32_v3.onnx \\
        --out ant_v2_fp32_tiledscatter.onnx --tile 64 --max-slots 512
"""
import argparse
import os
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


# Image pool sites (axis=2): (sums_scatter, counts_scatter, seg_index_tensor).
IMAGE_SITES = [
    ("/ScatterElements",   "/ScatterElements_1", "/Cast_2_output_0"),  # ref
    ("/ScatterElements_2", "/ScatterElements_3", "/Cast_5_output_0"),  # target
]
# SVG slot sites (axis=0): (sums_scatter,). counts come from a model INPUT.
SVG_SITES = ["/ScatterElements_4", "/ScatterElements_5"]


def const_i64(name, arr):
    return numpy_helper.from_array(np.asarray(arr, dtype=np.int64), name=name)


def build(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--tile", type=int, default=64, help="slot tile width T (the memory bound)")
    ap.add_argument("--max-slots", type=int, default=512,
                    help="config max_segments; graph unrolls ceil((max_slots+1)/T) tiles")
    ap.add_argument("--skip-svg", action="store_true", help="leave the 2 tiny SVG scatters on CPU")
    args = ap.parse_args(argv)

    T = args.tile
    n_tiles = (args.max_slots + 1 + T - 1) // T   # cover slots [0, max_slots]
    m = onnx.load(args.inp)
    g = m.graph
    byname = {n.name: n for n in g.node}

    # ---- shared constants ----
    shared = {
        "s2t_start0": const_i64("s2t_start0", [0]),
        "s2t_axis2": const_i64("s2t_axis2", [2]),
        "s2t_axis0": const_i64("s2t_axis0", [0]),
        "s2t_axis3_shape": const_i64("s2t_axis3_shape", [1, -1, 1]),   # seg -> (1,L,1)
        "s2t_reduce_L": const_i64("s2t_reduce_L", [1]),                # counts reduce over L (axis 1 of (1,L,T))
    }
    for t in range(n_tiles):
        shared[f"s2t_rng_{t}"] = const_i64(
            f"s2t_rng_{t}", np.arange(t * T, t * T + T).reshape(1, 1, T))
    for tt in shared.values():
        g.initializer.append(tt)

    new_before = {}   # sums_scatter_name -> list[node] to emit in place of it
    drop = set()

    def tiled_image_site(i, sums_node, counts_node, seg):
        p = f"s2ti{i}"
        sums_data = sums_node.input[0]     # zeros (1,C,K) -> K
        src = sums_node.input[2]           # (1,C,L) fp32
        sums_out = sums_node.output[0]     # reuse name
        counts_out = counts_node.output[0]
        nodes = []
        # seg (1,1,L) int64 -> (1,L,1)
        nodes.append(helper.make_node("Reshape", [seg, "s2t_axis3_shape"], [f"{p}_seg"], name=f"{p}_ReshapeSeg"))
        part_sums, part_cnts = [], []
        for t in range(n_tiles):
            nodes.append(helper.make_node("Equal", [f"{p}_seg", f"s2t_rng_{t}"], [f"{p}_eq{t}"], name=f"{p}_Eq{t}"))
            nodes.append(helper.make_node("Cast", [f"{p}_eq{t}"], [f"{p}_oh{t}"], name=f"{p}_Cast{t}", to=TensorProto.FLOAT))
            nodes.append(helper.make_node("MatMul", [src, f"{p}_oh{t}"], [f"{p}_ps{t}"], name=f"{p}_MM{t}"))      # (1,C,T)
            nodes.append(helper.make_node("ReduceSum", [f"{p}_oh{t}", "s2t_reduce_L"], [f"{p}_pc{t}"],
                                          name=f"{p}_RS{t}", keepdims=1))                                        # (1,1,T)
            part_sums.append(f"{p}_ps{t}")
            part_cnts.append(f"{p}_pc{t}")
        nodes.append(helper.make_node("Concat", part_sums, [f"{p}_sums_full"], name=f"{p}_ConcatS", axis=2))     # (1,C,nT*T)
        nodes.append(helper.make_node("Concat", part_cnts, [f"{p}_cnts_full"], name=f"{p}_ConcatC", axis=2))     # (1,1,nT*T)
        # K (dynamic) as a 1-D [K] for Slice end
        nodes.append(helper.make_node("Shape", [sums_data], [f"{p}_dshape"], name=f"{p}_Shape"))
        nodes.append(helper.make_node("Slice", [f"{p}_dshape", "s2t_axis2", "s2t_axis0_end"], [f"{p}_Kvec"],
                                      name=f"{p}_SliceK"))   # Shape[2:3] -> [K]
        nodes.append(helper.make_node("Slice", [f"{p}_sums_full", "s2t_start0", f"{p}_Kvec", "s2t_axis2"],
                                      [sums_out], name=f"{p}_SliceSums"))                                        # (1,C,K)
        nodes.append(helper.make_node("Slice", [f"{p}_cnts_full", "s2t_start0", f"{p}_Kvec", "s2t_axis2"],
                                      [counts_out], name=f"{p}_SliceCnts"))                                      # (1,1,K)
        return nodes

    # a shared [3] const to slice Shape[2:3]
    g.initializer.append(const_i64("s2t_axis0_end", [3]))

    for i, (sname, cname, seg) in enumerate(IMAGE_SITES):
        new_before[sname] = tiled_image_site(i, byname[sname], byname[cname], seg)
        drop.add(sname); drop.add(cname)

    def svg_site(i, sums_node):
        p = f"s2tv{i}"
        sums_data = sums_node.input[0]      # zeros (S,F) -> S
        idx_exp = sums_node.input[1]        # (V,F) int64 = cmd_slot_idx expanded
        sel = sums_node.input[2]            # (V,F) fp32
        sums_out = sums_node.output[0]
        nodes = []
        # cmd_slot (V,) from column 0 of the (V,F) expanded index -> (1,V)
        nodes.append(helper.make_node("Slice", [idx_exp, "s2t_start0", "s2t_one_1d", "s2t_axis1_1d"],
                                      [f"{p}_col"], name=f"{p}_SliceCol"))     # (V,1)
        nodes.append(helper.make_node("Reshape", [f"{p}_col", "s2t_shape_1m1"], [f"{p}_cmd"], name=f"{p}_RCmd"))  # (1,V)
        # S (dynamic) and range [0,S) as (S,1)
        nodes.append(helper.make_node("Shape", [sums_data], [f"{p}_sh"], name=f"{p}_Shape"))
        nodes.append(helper.make_node("Gather", [f"{p}_sh", "s2t_scalar0"], [f"{p}_S"], name=f"{p}_GatherS"))     # scalar S
        nodes.append(helper.make_node("Range", ["s2t_scalar0", f"{p}_S", "s2t_scalar1"], [f"{p}_rngS"], name=f"{p}_Range"))  # (S,)
        nodes.append(helper.make_node("Reshape", [f"{p}_rngS", "s2t_shape_m11"], [f"{p}_rngScol"], name=f"{p}_RRng"))  # (S,1)
        nodes.append(helper.make_node("Equal", [f"{p}_rngScol", f"{p}_cmd"], [f"{p}_eq"], name=f"{p}_Eq"))        # (S,V)
        nodes.append(helper.make_node("Cast", [f"{p}_eq"], [f"{p}_oh"], name=f"{p}_Cast", to=TensorProto.FLOAT))  # (S,V)
        nodes.append(helper.make_node("MatMul", [f"{p}_oh", sel], [sums_out], name=f"{p}_MM"))                    # (S,F)
        return nodes

    if not args.skip_svg:
        for extra in [
            const_i64("s2t_one_1d", [1]), const_i64("s2t_axis1_1d", [1]),
            const_i64("s2t_shape_1m1", [1, -1]), const_i64("s2t_shape_m11", [-1, 1]),
            numpy_helper.from_array(np.array(0, dtype=np.int64), "s2t_scalar0"),
            numpy_helper.from_array(np.array(1, dtype=np.int64), "s2t_scalar1"),
        ]:
            g.initializer.append(extra)
        for i, sname in enumerate(SVG_SITES):
            new_before[sname] = svg_site(i, byname[sname])
            drop.add(sname)

    # ---- rebuild node list, replacing in place ----
    out_nodes = []
    for node in g.node:
        if node.name in new_before:
            out_nodes.extend(new_before[node.name])
        elif node.name in drop:
            continue
        else:
            out_nodes.append(node)
    del g.node[:]
    g.node.extend(out_nodes)

    onnx.checker.check_model(m, full_check=False)
    try:
        m = onnx.shape_inference.infer_shapes(m)
    except Exception as e:
        print(f"(shape-inference warning: {str(e)[:120]})")
    onnx.save(m, args.out, save_as_external_data=m.ByteSize() > 2**31 - 100)

    remaining = sum(1 for n in m.graph.node if n.op_type == "ScatterElements")
    print(f"T={T} n_tiles={n_tiles} (bound O(L*{T}))  saved -> {args.out} "
          f"({os.path.getsize(args.out)/1e6:.1f} MB)")
    print(f"remaining ScatterElements: {remaining}")
    return m


if __name__ == "__main__":
    build()
