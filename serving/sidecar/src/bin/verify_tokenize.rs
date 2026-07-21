//! Golden verification harness for the AnT v2 tokenization + feed-building
//! port (`src/tokenize/`).
//!
//! Usage: cargo run --release --bin verify_tokenize -- <goldens_root> \
//!            [--robot-feeds <robot_feeds_dir>]
//!
//! For every pair directory under <goldens_root> (00_ref_svg.svg,
//! 00_tgt_svg.svg, 01_color_list.json, 02_vec_tokens.npz, 03_mask_ids.npz,
//! 04_tokenized.npz, 05_feed.npz, meta.json as dumped by
//! serving/tools/dump_tokenizer_goldens.py), runs the Rust pipeline from the recorded
//! SVG strings / color list / tokenized images and compares byte-exact
//! (f32 bitwise) per stage:
//!
//!   02_parse  SVG d-strings -> (1, S, C, 6) command tensors vs golden 02
//!   02_pack   pack_sequences -> packed + block-diagonal attn vs golden 02
//!   03_ids    palette from 01 + mask via 04 ref_seg_image vs golden 03
//!             (plus the derived ref_colors vs golden 04)
//!   05_vec    every non-image 05 array from OUR pipeline outputs: svg_pre
//!             x2, colors/ids, packed_gather_idx, packed_attn_mask
//!   05_img    image-derived 05 arrays from the 04 inputs: line feeds (f32
//!             cast), sdf_like_cupy, NEAREST_EXACT seg lowres
//!   meta      n_ref / n_tgt cross-check
//!   bucket    (with --robot-feeds) `pad_feed_to_bucket` over the pair's
//!             `feed_*` arrays from <robot_feeds>/<pair>.npz vs its
//!             `bucket_feed_*` arrays (parity_corpus.py --bucket-test dumps)
//!
//! Prints a per-pair per-stage PASS/FAIL matrix with first-mismatch
//! (flat index, got, want) details, and exits nonzero on any failure.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use cadmium_sidecar::goldens::{parse_npy_bool, parse_npy_f32, parse_npy_i32, parse_npy_i64, read_npz};
use cadmium_sidecar::tokenize::{bucket, feed, get_vec_tokens, palette, svg::Svg, Tensor};

const STAGE_NAMES: [&str; 7] = ["02_parse", "02_pack", "03_ids", "05_vec", "05_img", "meta", "bucket"];
const N_STAGES: usize = STAGE_NAMES.len();

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut root: Option<PathBuf> = None;
    let mut robot_feeds: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--robot-feeds" => {
                robot_feeds = Some(PathBuf::from(it.next().expect("--robot-feeds dir")))
            }
            _ => root = Some(PathBuf::from(a)),
        }
    }
    let Some(root) = root else {
        eprintln!("usage: verify_tokenize <goldens_root> [--robot-feeds <dir>]");
        return ExitCode::from(2);
    };

    let mut pairs: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", root.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("00_ref_svg.svg").is_file())
        .collect();
    pairs.sort();
    if pairs.is_empty() {
        eprintln!(
            "no pair directories (with 00_ref_svg.svg) under {}",
            root.display()
        );
        return ExitCode::from(2);
    }

    let mut matrix: Vec<(String, [Option<bool>; N_STAGES], f64)> = Vec::new();
    let mut all_pass = true;
    for dir in &pairs {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let (results, secs) = verify_pair(dir, robot_feeds.as_deref());
        all_pass &= results.iter().all(|&r| r != Some(false));
        matrix.push((name, results, secs));
    }

    println!();
    print!("{:14}", "pair");
    for s in STAGE_NAMES {
        print!(" {:>8}", s);
    }
    println!(" {:>9}", "time");
    for (name, results, secs) in &matrix {
        print!("{:14}", name);
        for r in results {
            print!(
                " {:>8}",
                match r {
                    Some(true) => "PASS",
                    Some(false) => "FAIL",
                    None => "-",
                }
            );
        }
        println!(" {:>8.3}s", secs);
    }
    println!();
    if all_pass {
        println!(
            "all {} pairs x {} stages byte-exact{}",
            matrix.len(),
            N_STAGES,
            if robot_feeds.is_none() {
                " (bucket stage skipped: no --robot-feeds)"
            } else {
                ""
            }
        );
        ExitCode::SUCCESS
    } else {
        println!("MISMATCHES FOUND");
        ExitCode::FAILURE
    }
}

// ---------------------------------------------------------------------------
// golden bundles

struct Npz {
    entries: Vec<(String, Vec<u8>)>,
    path: String,
}

impl Npz {
    fn load(path: &Path) -> Npz {
        Npz {
            entries: read_npz(path),
            path: path.display().to_string(),
        }
    }

    fn raw(&self, key: &str) -> &[u8] {
        &self
            .entries
            .iter()
            .find(|(n, _)| n == &format!("{key}.npy"))
            .unwrap_or_else(|| panic!("{}: missing key {key}", self.path))
            .1
    }

    fn f32(&self, key: &str) -> Tensor<f32> {
        let (data, shape) = parse_npy_f32(self.raw(key));
        Tensor::new(shape, data)
    }

    fn i32(&self, key: &str) -> Tensor<i32> {
        let (data, shape) = parse_npy_i32(self.raw(key));
        Tensor::new(shape, data)
    }

    fn i64(&self, key: &str) -> Tensor<i64> {
        let (data, shape) = parse_npy_i64(self.raw(key));
        Tensor::new(shape, data)
    }

    fn boolean(&self, key: &str) -> Tensor<bool> {
        let (data, shape) = parse_npy_bool(self.raw(key));
        Tensor::new(shape, data)
    }

    fn u8(&self, key: &str) -> Tensor<u8> {
        let (data, shape) =
            cadmium_sidecar::goldens::parse_npy_u8(self.raw(key));
        Tensor::new(shape, data)
    }
}

// ---------------------------------------------------------------------------
// per-pair verification

fn verify_pair(dir: &Path, robot_feeds: Option<&Path>) -> ([Option<bool>; N_STAGES], f64) {
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    let read = |f: &str| {
        std::fs::read_to_string(dir.join(f)).unwrap_or_else(|e| panic!("{name}/{f}: {e}"))
    };
    let ref_svg_str = read("00_ref_svg.svg");
    let tgt_svg_str = read("00_tgt_svg.svg");
    let color_list: Vec<i64> = serde_json::from_str(&read("01_color_list.json"))
        .unwrap_or_else(|e| panic!("{name}/01: {e}"));
    let meta: serde_json::Value =
        serde_json::from_str(&read("meta.json")).unwrap_or_else(|e| panic!("{name}/meta: {e}"));
    let g02 = Npz::load(&dir.join("02_vec_tokens.npz"));
    let g03 = Npz::load(&dir.join("03_mask_ids.npz"));
    let g04 = Npz::load(&dir.join("04_tokenized.npz"));
    let g05 = Npz::load(&dir.join("05_feed.npz"));

    let t0 = Instant::now();
    let mut results = [Some(false); N_STAGES];

    // stage a: SVG d-strings -> per-path command tensors
    let ref_svg = Svg::from_str(&ref_svg_str);
    let tgt_svg = Svg::from_str(&tgt_svg_str);
    let vec_tokens = get_vec_tokens(&ref_svg, &tgt_svg);
    results[0] = Some(cmp_f32(&name, "02_parse/ref_seg_svg", &vec_tokens.ref_seg_svg, &g02.f32("ref_seg_svg"))
        & cmp_f32(&name, "02_parse/target_seg_svg", &vec_tokens.target_seg_svg, &g02.f32("target_seg_svg")));

    // stage b: packing
    results[1] = Some(cmp_f32(&name, "02_pack/ref_packed", &vec_tokens.ref_seg_svg_packed, &g02.f32("ref_seg_svg_packed"))
        & cmp_bool(&name, "02_pack/ref_attn", &vec_tokens.ref_seg_svg_attn_mask_packed, &g02.boolean("ref_seg_svg_attn_mask_packed"))
        & cmp_f32(&name, "02_pack/target_packed", &vec_tokens.target_seg_svg_packed, &g02.f32("target_seg_svg_packed"))
        & cmp_bool(&name, "02_pack/target_attn", &vec_tokens.target_seg_svg_attn_mask_packed, &g02.boolean("target_seg_svg_attn_mask_packed")));

    // stage c: palette -> color ids -> null-mask via the ref seg image
    let pal = palette::palette_from_color_list(&color_list);
    let in_ids = Tensor::new(vec![pal.color_ids.len()], pal.color_ids.clone());
    let ref_seg_image = g04.i32("ref_seg_image");
    let masked = palette::mask_null_color_ids(&ref_seg_image.data, &pal.color_ids);
    let out_ids = Tensor::new(vec![masked.len()], masked.clone());
    // ref_colors as production stores them in the tokenized dict: RGBA of
    // the MASKED ids as a FloatTensor (exact f32 for these magnitudes)
    let ref_colors = palette::color_ids_to_colors(&pal.color_list, &masked);
    let ref_colors_f32 = Tensor::new(
        vec![1, ref_colors.len(), 4],
        ref_colors.iter().flatten().map(|&v| v as f32).collect(),
    );
    results[2] = Some(cmp_i64(&name, "03_ids/in_ids", &in_ids, &g03.i64("in_ids"))
        & cmp_i64(&name, "03_ids/out_ids", &out_ids, &g03.i64("out_ids"))
        & cmp_f32(&name, "03_ids/ref_colors(04)", &ref_colors_f32, &g04.f32("ref_colors")));

    // stage d: every non-image 05 array, from OUR pipeline outputs
    {
        let mut ok = true;
        for (side, seg_svg, packed, attn) in [
            ("ref", &vec_tokens.ref_seg_svg, &vec_tokens.ref_seg_svg_packed, &vec_tokens.ref_seg_svg_attn_mask_packed),
            ("target", &vec_tokens.target_seg_svg, &vec_tokens.target_seg_svg_packed, &vec_tokens.target_seg_svg_attn_mask_packed),
        ] {
            let pre = feed::svg_pre(seg_svg, packed, attn);
            let v = pre.flat_idx.len();
            let s = pre.slot_counts.len();
            ok &= cmp_f32(&name, &format!("05_vec/{side}_svg_packed_nopad"), &pre.packed_nopad, &g05.f32(&format!("{side}_svg_packed_nopad")))
                & cmp_bool(&name, &format!("05_vec/{side}_svg_attn_nopad"), &pre.attn_nopad, &g05.boolean(&format!("{side}_svg_attn_nopad")))
                & cmp_i64(&name, &format!("05_vec/{side}_svg_flat_idx"), &Tensor::new(vec![v], pre.flat_idx), &g05.i64(&format!("{side}_svg_flat_idx")))
                & cmp_i64(&name, &format!("05_vec/{side}_svg_cmd_slot_idx"), &Tensor::new(vec![v], pre.cmd_slot_idx), &g05.i64(&format!("{side}_svg_cmd_slot_idx")))
                & cmp_f32(&name, &format!("05_vec/{side}_svg_slot_counts"), &Tensor::new(vec![s], pre.slot_counts), &g05.f32(&format!("{side}_svg_slot_counts")));
        }

        // colors / ids (feed casts everything to long)
        let s_ref = vec_tokens.ref_seg_svg.shape[1];
        let s_tgt = vec_tokens.target_seg_svg.shape[1];
        let ref_colors_i64 = Tensor::new(
            vec![1, s_ref, 4],
            ref_colors.iter().flatten().copied().collect(),
        );
        ok &= cmp_i64(&name, "05_vec/ref_colors", &ref_colors_i64, &g05.i64("ref_colors"))
            & cmp_i64(&name, "05_vec/ref_color_ids", &Tensor::new(vec![1, s_ref], masked.clone()), &g05.i64("ref_color_ids"))
            // target side: all-null sentinels sized by the target path count
            & cmp_i64(&name, "05_vec/target_colors", &Tensor::full(vec![1, s_tgt, 4], -100i64), &g05.i64("target_colors"))
            & cmp_i64(&name, "05_vec/target_color_ids", &Tensor::full(vec![1, s_tgt], -100i64), &g05.i64("target_color_ids"));

        // packed layout over the concatenated [ref..., target...] slot axis
        let ref_idx = feed::nonpad_slot_indices(&vec_tokens.ref_seg_svg);
        let tgt_idx = feed::nonpad_slot_indices(&vec_tokens.target_seg_svg);
        let gather = feed::packed_gather_idx(&ref_idx, &tgt_idx, s_ref);
        let n_packed = gather.len();
        ok &= cmp_i64(&name, "05_vec/packed_gather_idx", &Tensor::new(vec![n_packed], gather), &g05.i64("packed_gather_idx"))
            & cmp_bool(&name, "05_vec/packed_attn_mask", &Tensor::full(vec![1, n_packed], true), &g05.boolean("packed_attn_mask"));
        results[3] = Some(ok);

        // meta cross-check: the packed layout sizes the dumper recorded
        let n_ref = meta["n_ref"].as_u64().unwrap_or(u64::MAX) as usize;
        let n_tgt = meta["n_tgt"].as_u64().unwrap_or(u64::MAX) as usize;
        results[5] = Some(ref_idx.len() == n_ref && tgt_idx.len() == n_tgt);
        if results[5] == Some(false) {
            println!(
                "{name}/meta: packed layout {}+{} but meta says {n_ref}+{n_tgt}",
                ref_idx.len(),
                tgt_idx.len()
            );
        }
    }

    // stage e: image-derived 05 arrays from the 04 tokenized images
    {
        let lowres_hw = (
            meta["lowres_hw"][0].as_u64().expect("meta lowres_hw") as usize,
            meta["lowres_hw"][1].as_u64().expect("meta lowres_hw") as usize,
        );
        let mut ok = true;
        for side in ["ref", "target"] {
            let line_u8 = g04.u8(&format!("{side}_line_image"));
            // build_feed: tok line image .float()
            let line_f32 = Tensor::new(
                line_u8.shape.clone(),
                line_u8.data.iter().map(|&v| v as f32).collect(),
            );
            ok &= cmp_f32(&name, &format!("05_img/{side}_line_image"), &line_f32, &g05.f32(&format!("{side}_line_image")));

            // sdf_like_cupy(line.float() / 255)
            let scaled = Tensor::new(
                line_f32.shape.clone(),
                line_f32.data.iter().map(|&v| v / 255.0).collect(),
            );
            let sdf = feed::sdf_like_cupy(&scaled);
            ok &= cmp_f32(&name, &format!("05_img/{side}_sdf"), &sdf, &g05.f32(&format!("{side}_sdf")));

            // lowres_seg(tok seg .long(), lowres_hw)
            let seg = g04.i32(&format!("{side}_seg_image"));
            let low = feed::lowres_seg(&seg, lowres_hw);
            ok &= cmp_i64(&name, &format!("05_img/{side}_seg_lowres"), &low, &g05.i64(&format!("{side}_seg_lowres")));
        }
        results[4] = Some(ok);
    }

    // stage f: pad_feed_to_bucket over the robot-feed dump (feed_* arrays)
    // vs its recorded bucket_feed_* arrays
    results[6] = robot_feeds.map(|dir| verify_bucket(&name, &dir.join(format!("{name}.npz"))));

    (results, t0.elapsed().as_secs_f64())
}

/// Load a full `AntFeed` from a robot-feed npz under the given key prefix
/// (`feed_` for the dynamic arrays, `bucket_feed_` for the padded goldens).
fn ant_feed_from_npz(z: &Npz, prefix: &str) -> feed::AntFeed {
    let f32k = |k: &str| z.f32(&format!("{prefix}{k}"));
    let i64k = |k: &str| z.i64(&format!("{prefix}{k}"));
    let boolk = |k: &str| z.boolean(&format!("{prefix}{k}"));
    feed::AntFeed {
        ref_line_image: f32k("ref_line_image"),
        ref_sdf: f32k("ref_sdf"),
        ref_seg_lowres: i64k("ref_seg_lowres"),
        target_line_image: f32k("target_line_image"),
        target_sdf: f32k("target_sdf"),
        target_seg_lowres: i64k("target_seg_lowres"),
        ref_svg_packed_nopad: f32k("ref_svg_packed_nopad"),
        ref_svg_attn_nopad: boolk("ref_svg_attn_nopad"),
        ref_svg_flat_idx: i64k("ref_svg_flat_idx"),
        ref_svg_cmd_slot_idx: i64k("ref_svg_cmd_slot_idx"),
        ref_svg_slot_counts: f32k("ref_svg_slot_counts"),
        target_svg_packed_nopad: f32k("target_svg_packed_nopad"),
        target_svg_attn_nopad: boolk("target_svg_attn_nopad"),
        target_svg_flat_idx: i64k("target_svg_flat_idx"),
        target_svg_cmd_slot_idx: i64k("target_svg_cmd_slot_idx"),
        target_svg_slot_counts: f32k("target_svg_slot_counts"),
        ref_colors: i64k("ref_colors"),
        ref_color_ids: i64k("ref_color_ids"),
        target_colors: i64k("target_colors"),
        target_color_ids: i64k("target_color_ids"),
        packed_gather_idx: i64k("packed_gather_idx"),
        packed_attn_mask: boolk("packed_attn_mask"),
    }
}

/// `pad_feed_to_bucket(feed_*, CORPUS_BUCKET)` must reproduce the pair's
/// `bucket_feed_*` arrays byte-exact.
fn verify_bucket(name: &str, npz_path: &Path) -> bool {
    if !npz_path.is_file() {
        println!("{name}/bucket: missing robot feed {}", npz_path.display());
        return false;
    }
    let z = Npz::load(npz_path);
    let dynamic = ant_feed_from_npz(&z, "feed_");
    let want = ant_feed_from_npz(&z, "bucket_feed_");
    let got = match bucket::pad_feed_to_bucket(&dynamic, &bucket::CORPUS_BUCKET) {
        Ok(got) => got,
        Err(e) => {
            println!("{name}/bucket: pad_feed_to_bucket failed: {e}");
            return false;
        }
    };
    let c = |k: &str| format!("bucket/{k}");
    cmp_f32(name, &c("ref_line_image"), &got.ref_line_image, &want.ref_line_image)
        & cmp_f32(name, &c("ref_sdf"), &got.ref_sdf, &want.ref_sdf)
        & cmp_i64(name, &c("ref_seg_lowres"), &got.ref_seg_lowres, &want.ref_seg_lowres)
        & cmp_f32(name, &c("target_line_image"), &got.target_line_image, &want.target_line_image)
        & cmp_f32(name, &c("target_sdf"), &got.target_sdf, &want.target_sdf)
        & cmp_i64(name, &c("target_seg_lowres"), &got.target_seg_lowres, &want.target_seg_lowres)
        & cmp_f32(name, &c("ref_svg_packed_nopad"), &got.ref_svg_packed_nopad, &want.ref_svg_packed_nopad)
        & cmp_bool(name, &c("ref_svg_attn_nopad"), &got.ref_svg_attn_nopad, &want.ref_svg_attn_nopad)
        & cmp_i64(name, &c("ref_svg_flat_idx"), &got.ref_svg_flat_idx, &want.ref_svg_flat_idx)
        & cmp_i64(name, &c("ref_svg_cmd_slot_idx"), &got.ref_svg_cmd_slot_idx, &want.ref_svg_cmd_slot_idx)
        & cmp_f32(name, &c("ref_svg_slot_counts"), &got.ref_svg_slot_counts, &want.ref_svg_slot_counts)
        & cmp_f32(name, &c("target_svg_packed_nopad"), &got.target_svg_packed_nopad, &want.target_svg_packed_nopad)
        & cmp_bool(name, &c("target_svg_attn_nopad"), &got.target_svg_attn_nopad, &want.target_svg_attn_nopad)
        & cmp_i64(name, &c("target_svg_flat_idx"), &got.target_svg_flat_idx, &want.target_svg_flat_idx)
        & cmp_i64(name, &c("target_svg_cmd_slot_idx"), &got.target_svg_cmd_slot_idx, &want.target_svg_cmd_slot_idx)
        & cmp_f32(name, &c("target_svg_slot_counts"), &got.target_svg_slot_counts, &want.target_svg_slot_counts)
        & cmp_i64(name, &c("ref_colors"), &got.ref_colors, &want.ref_colors)
        & cmp_i64(name, &c("ref_color_ids"), &got.ref_color_ids, &want.ref_color_ids)
        & cmp_i64(name, &c("target_colors"), &got.target_colors, &want.target_colors)
        & cmp_i64(name, &c("target_color_ids"), &got.target_color_ids, &want.target_color_ids)
        & cmp_i64(name, &c("packed_gather_idx"), &got.packed_gather_idx, &want.packed_gather_idx)
        & cmp_bool(name, &c("packed_attn_mask"), &got.packed_attn_mask, &want.packed_attn_mask)
}

// ---------------------------------------------------------------------------
// bitwise comparison

fn cmp_slices<T, U, F>(name: &str, stage: &str, got: &Tensor<T>, want: &Tensor<T>, to_cmp: F) -> bool
where
    T: std::fmt::Display + Copy,
    U: PartialEq,
    F: Fn(T) -> U,
{
    if got.shape != want.shape {
        println!(
            "{name}/{stage}: shape mismatch: got {:?} want {:?}",
            got.shape, want.shape
        );
        return false;
    }
    let mut first = None;
    let mut total = 0usize;
    for (i, (g, w)) in got.data.iter().zip(want.data.iter()).enumerate() {
        if to_cmp(*g) != to_cmp(*w) {
            total += 1;
            if first.is_none() {
                first = Some(i);
            }
        }
    }
    match first {
        None => true,
        Some(i) => {
            println!(
                "{name}/{stage}: {total} differing values; first at flat index {i}: got {} want {}",
                got.data[i], want.data[i]
            );
            false
        }
    }
}

fn cmp_f32(name: &str, stage: &str, got: &Tensor<f32>, want: &Tensor<f32>) -> bool {
    cmp_slices(name, stage, got, want, |v: f32| v.to_bits())
}

fn cmp_i64(name: &str, stage: &str, got: &Tensor<i64>, want: &Tensor<i64>) -> bool {
    cmp_slices(name, stage, got, want, |v: i64| v)
}

fn cmp_bool(name: &str, stage: &str, got: &Tensor<bool>, want: &Tensor<bool>) -> bool {
    cmp_slices(name, stage, got, want, |v: bool| v)
}
