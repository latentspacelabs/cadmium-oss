//! Shared golden-file loaders for the verification harnesses
//! (`verify_segment`, `verify_gapclose`): the RGBA line.png alpha plane,
//! a minimal .npy parser (v1.0, C-order, little-endian scalars) and a
//! minimal .npz reader (np.savez writes STORED zip entries, so no
//! decompression is needed).

use std::path::Path;

use crate::imageprep::Rgba;
use crate::segment::Gray;

// ---------------------------------------------------------------------------
// PNG

/// Load the alpha plane of an 8-bit RGBA (or gray+alpha) PNG.
pub fn load_alpha_png(path: &Path) -> Gray {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().expect("bad PNG");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("bad PNG frame");
    assert_eq!(info.bit_depth, png::BitDepth::Eight, "expected 8-bit PNG");
    let (w, h) = (info.width as usize, info.height as usize);
    let stride = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::GrayscaleAlpha => 2,
        other => panic!("expected an alpha channel, got {:?}", other),
    };
    let mut alpha = Gray::new(w, h, 0);
    for (dst, px) in alpha
        .data
        .iter_mut()
        .zip(buf[..w * h * stride].chunks_exact(stride))
    {
        *dst = px[stride - 1];
    }
    alpha
}

/// Load an 8-bit RGBA PNG in full (the `np.array(Image.open(p)
/// .convert("RGBA"))` corpus inputs — every corpus/golden png is already
/// RGBA, so the convert is the identity).
pub fn load_rgba_png(path: &Path) -> Rgba {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().expect("bad PNG");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("bad PNG frame");
    assert_eq!(info.bit_depth, png::BitDepth::Eight, "expected 8-bit PNG");
    assert_eq!(
        info.color_type,
        png::ColorType::Rgba,
        "{}: expected an RGBA PNG",
        path.display()
    );
    let (w, h) = (info.width as usize, info.height as usize);
    buf.truncate(w * h * 4);
    Rgba::new(w, h, buf)
}

// ---------------------------------------------------------------------------
// npy

/// Parse a v1.0 npy header; returns (payload offset, shape). Asserts the
/// dtype descr and C order.
pub fn parse_npy_header(bytes: &[u8], expect_descr: &str) -> (usize, Vec<usize>) {
    assert_eq!(&bytes[..6], b"\x93NUMPY", "not an npy file");
    assert_eq!(bytes[6], 1, "only npy format v1 supported");
    let hlen = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let header = std::str::from_utf8(&bytes[10..10 + hlen]).expect("bad npy header");
    assert!(
        header.contains(&format!("'descr': '{expect_descr}'")),
        "expected descr {expect_descr}, header: {header}"
    );
    assert!(
        header.contains("'fortran_order': False"),
        "expected C-order, header: {header}"
    );
    let shape_part = header
        .split("'shape': (")
        .nth(1)
        .expect("no shape in npy header")
        .split(')')
        .next()
        .unwrap();
    let dims: Vec<usize> = shape_part
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().expect("bad shape"))
        .collect();
    (10 + hlen, dims)
}

macro_rules! npy_loader {
    ($parse:ident, $load:ident, $ty:ty, $descr:literal, $size:literal) => {
        /// Parse an in-memory npy buffer into (data, shape).
        pub fn $parse(bytes: &[u8]) -> (Vec<$ty>, Vec<usize>) {
            let (off, shape) = parse_npy_header(bytes, $descr);
            let n: usize = shape.iter().product();
            assert_eq!(bytes.len() - off, n * $size, "npy payload size mismatch");
            let data = bytes[off..]
                .chunks_exact($size)
                .map(|c| <$ty>::from_le_bytes(c.try_into().unwrap()))
                .collect();
            (data, shape)
        }

        /// Load an npy file into (data, shape).
        pub fn $load(path: &Path) -> (Vec<$ty>, Vec<usize>) {
            let bytes =
                std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            $parse(&bytes)
        }
    };
}

npy_loader!(parse_npy_u8, load_npy_u8, u8, "|u1", 1);
npy_loader!(parse_npy_i32, load_npy_i32, i32, "<i4", 4);
npy_loader!(parse_npy_u32, load_npy_u32, u32, "<u4", 4);
npy_loader!(parse_npy_f32, load_npy_f32, f32, "<f4", 4);
npy_loader!(parse_npy_i64, load_npy_i64, i64, "<i8", 8);

/// Parse an in-memory npy buffer of numpy bools (descr `|b1`, one byte per
/// element, 0/1) into (data, shape).
pub fn parse_npy_bool(bytes: &[u8]) -> (Vec<bool>, Vec<usize>) {
    let (off, shape) = parse_npy_header(bytes, "|b1");
    let n: usize = shape.iter().product();
    assert_eq!(bytes.len() - off, n, "npy payload size mismatch");
    (bytes[off..].iter().map(|&b| b != 0).collect(), shape)
}

// ---------------------------------------------------------------------------
// npz (zip, as written by np.savez / np.savez_compressed)

/// Read the entries of an npz zip file: sequential local file headers with
/// sizes present (numpy writes to a seekable file, so no data descriptors).
/// Entries are STORED (np.savez) or raw-DEFLATE (np.savez_compressed), which
/// is inflated here. Modern numpy opens members with `force_zip64` — the
/// 32-bit size fields then hold the 0xFFFFFFFF sentinel and the real sizes
/// live in a ZIP64 extra field (id 0x0001). Returns (name, raw bytes) pairs
/// in file order; entry names keep their ".npy" suffix.
pub fn read_npz(path: &Path) -> Vec<(String, Vec<u8>)> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut entries = Vec::new();
    let mut off = 0usize;
    while off + 30 <= bytes.len() && bytes[off..off + 4] == [0x50, 0x4b, 0x03, 0x04] {
        let flags = u16::from_le_bytes([bytes[off + 6], bytes[off + 7]]);
        let method = u16::from_le_bytes([bytes[off + 8], bytes[off + 9]]);
        let mut csize = u32::from_le_bytes(bytes[off + 18..off + 22].try_into().unwrap()) as usize;
        let usize32 = u32::from_le_bytes(bytes[off + 22..off + 26].try_into().unwrap());
        let name_len = u16::from_le_bytes([bytes[off + 26], bytes[off + 27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[off + 28], bytes[off + 29]]) as usize;
        assert_eq!(
            flags & 0x08,
            0,
            "{}: zip data descriptors not supported",
            path.display()
        );
        let name = String::from_utf8(bytes[off + 30..off + 30 + name_len].to_vec())
            .expect("bad zip entry name");
        if csize == 0xFFFF_FFFF {
            // ZIP64: [id 0x0001][len][uncompressed u64][compressed u64] — the
            // local-header variant carries both u64s (APPNOTE 4.5.3), the
            // uncompressed size first.
            let extra_start = off + 30 + name_len;
            let extra = &bytes[extra_start..extra_start + extra_len];
            let mut e = 0usize;
            let mut found = false;
            while e + 4 <= extra.len() {
                let id = u16::from_le_bytes([extra[e], extra[e + 1]]);
                let sz = u16::from_le_bytes([extra[e + 2], extra[e + 3]]) as usize;
                if id == 0x0001 {
                    // Skip the uncompressed u64 if it is also sentineled in.
                    let c_off = if usize32 == 0xFFFF_FFFF { e + 12 } else { e + 4 };
                    csize = u64::from_le_bytes(
                        extra[c_off..c_off + 8].try_into().unwrap(),
                    ) as usize;
                    found = true;
                    break;
                }
                e += 4 + sz;
            }
            assert!(found, "{}: {name}: ZIP64 sizes but no 0x0001 extra", path.display());
        }
        let data_start = off + 30 + name_len + extra_len;
        let raw = &bytes[data_start..data_start + csize];
        let data = match method {
            0 => raw.to_vec(),
            8 => miniz_oxide::inflate::decompress_to_vec(raw).unwrap_or_else(|e| {
                panic!("{}: inflate failed for {name}: {e:?}", path.display())
            }),
            other => panic!(
                "{}: unsupported zip compression method {other}",
                path.display()
            ),
        };
        entries.push((name, data));
        off = data_start + csize;
    }
    assert!(!entries.is_empty(), "{}: no zip entries found", path.display());
    entries
}
