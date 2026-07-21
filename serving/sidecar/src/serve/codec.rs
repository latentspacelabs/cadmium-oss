//! Base64 PNG data-URI codecs replicating the two Python serialization paths
//! (`segmentation/trapped_ball/serialization.py`):
//!
//! - `base64_png_uri_to_img` / `img_to_base64_png_uri` go through **cv2**,
//!   which stores color images channel-swapped: an RGBA PNG DECODES to a
//!   B,G,R,A array, and an R,G,B,A array ENCODES to a PNG whose stored pixels
//!   are B/R-swapped. Grayscale is unaffected. The swap is load-bearing —
//!   the production /colorize pipeline consumes cv2-order arrays end to end
//!   and its response renders go back out through cv2.
//! - `base64_png_uri_to_img_pil` / `img_to_base64_png_uri_pil` go through
//!   PIL and preserve channel order (used by /preprocess).
//!
//! PNG encoder bytes are NOT part of the contract (responses compare by
//! decoded pixels); only decoded channel layout and pixel values are.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use crate::imageprep::Rgba;
use crate::segment::Gray;

/// A decoded PNG in its natural channel layout (8-bit only): `channels` is
/// 1 (gray), 2 (gray+alpha), 3 (RGB) or 4 (RGBA); `data` is interleaved
/// row-major, len = w * h * channels.
pub struct DecodedPng {
    pub w: usize,
    pub h: usize,
    pub channels: usize,
    pub data: Vec<u8>,
}

fn strip_data_prefix(uri: &str) -> &str {
    // Python: `img_uri.split(',')[1]` when the string starts with "data:".
    if let Some(rest) = uri.strip_prefix("data:") {
        rest.split_once(',').map(|(_, b64)| b64).unwrap_or(rest)
    } else {
        uri
    }
}

/// Decode a base64 PNG data URI to raw 8-bit pixels (no channel swapping).
///
/// `url_safe` replicates Python's `base64.urlsafe_b64decode`, which merely
/// TRANSLATES `-`/`_` to `+`/`/` and then standard-decodes — so it accepts
/// standard-alphabet input too (the app feeds /segment's standard-base64
/// seg_map_uri straight into the URL-safe /preprocess contract).
pub fn decode_png_uri(uri: &str, url_safe: bool) -> Result<DecodedPng, String> {
    let b64 = strip_data_prefix(uri).trim();
    let translated;
    let b64 = if url_safe {
        translated = b64.replace('-', "+").replace('_', "/");
        translated.as_str()
    } else {
        b64
    };
    let bytes = STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    decode_png_bytes(&bytes)
}

/// Decode raw PNG bytes to 8-bit pixels in the file's channel layout.
pub fn decode_png_bytes(bytes: &[u8]) -> Result<DecodedPng, String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| format!("bad PNG: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("bad PNG frame: {e}"))?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err(format!("expected 8-bit PNG, got {:?}", info.bit_depth));
    }
    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        other => return Err(format!("unsupported PNG color type {other:?}")),
    };
    let (w, h) = (info.width as usize, info.height as usize);
    buf.truncate(w * h * channels);
    Ok(DecodedPng {
        w,
        h,
        channels,
        data: buf,
    })
}

/// `base64_png_uri_to_img` (cv2.imdecode IMREAD_UNCHANGED + `.astype(u8)`):
/// color images come back CHANNEL-SWAPPED (RGB PNG -> B,G,R array, RGBA ->
/// B,G,R,A), grayscale stays single-channel.
pub fn decode_png_uri_cv2(uri: &str, url_safe: bool) -> Result<DecodedPng, String> {
    let mut img = decode_png_uri(uri, url_safe)?;
    if img.channels >= 3 {
        for px in img.data.chunks_exact_mut(img.channels) {
            px.swap(0, 2);
        }
    }
    Ok(img)
}

/// `base64_png_uri_to_img_pil`: channel order preserved.
pub fn decode_png_uri_pil(uri: &str, url_safe: bool) -> Result<DecodedPng, String> {
    decode_png_uri(uri, url_safe)
}

/// All response URIs use STANDARD base64: the cv2 helpers' `url_safe`
/// parameter defaults to False everywhere the handlers encode, and the PIL
/// helper likewise.
fn to_data_uri(png_bytes: Vec<u8>) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(png_bytes))
}

fn encode_png(w: usize, h: usize, color: png::ColorType, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(color);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().expect("png header");
        writer.write_image_data(data).expect("png data");
    }
    out
}

/// `img_to_base64_png_uri` of a 2-D uint8 array: cv2.imwrite writes an 8-bit
/// grayscale PNG (no channel semantics involved). Standard base64.
pub fn encode_gray_uri_cv2(img: &Gray) -> String {
    to_data_uri(encode_png(img.w, img.h, png::ColorType::Grayscale, &img.data))
}

/// `img_to_base64_png_uri` of an H x W x 4 array holding R,G,B,A values:
/// cv2.imwrite interprets it as B,G,R,A, so the stored PNG has R and B
/// swapped. Replicated so DECODED pixels match production's. Standard base64.
pub fn encode_rgba_uri_cv2(img: &Rgba) -> String {
    let mut swapped = img.data.clone();
    for px in swapped.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    to_data_uri(encode_png(img.w, img.h, png::ColorType::Rgba, &swapped))
}

/// `img_to_base64_png_uri` of an H x W x 3 array (cv2: B,G,R interpretation,
/// stored swapped). Used only by the colorized seg-map visualization.
pub fn encode_rgb_uri_cv2(w: usize, h: usize, rgb: &[u8]) -> String {
    let mut swapped = rgb.to_vec();
    for px in swapped.chunks_exact_mut(3) {
        px.swap(0, 2);
    }
    to_data_uri(encode_png(w, h, png::ColorType::Rgb, &swapped))
}

/// `img_to_base64_png_uri_pil(img)` for an RGBA render: channel order
/// preserved; url_safe defaults to False in Python, so standard base64.
pub fn encode_rgba_uri_pil(img: &Rgba) -> String {
    to_data_uri(encode_png(img.w, img.h, png::ColorType::Rgba, &img.data))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cv2_roundtrip_swaps_channels_twice() {
        let img = Rgba::new(2, 1, vec![10, 20, 30, 40, 50, 60, 70, 80]);
        let uri = encode_rgba_uri_cv2(&img);
        // decoding with PIL semantics shows the stored (swapped) pixels
        let pil = decode_png_uri_pil(&uri, false).unwrap();
        assert_eq!(pil.data, vec![30, 20, 10, 40, 70, 60, 50, 80]);
        // decoding with cv2 semantics swaps back to the original array
        let cv2 = decode_png_uri_cv2(&uri, false).unwrap();
        assert_eq!(cv2.data, img.data);
    }

    #[test]
    fn gray_roundtrip_is_identity() {
        let img = Gray {
            w: 3,
            h: 1,
            data: vec![0, 128, 255],
        };
        let uri = encode_gray_uri_cv2(&img);
        let dec = decode_png_uri_cv2(&uri, false).unwrap();
        assert_eq!(dec.channels, 1);
        assert_eq!(dec.data, img.data);
    }

    #[test]
    fn data_prefix_and_urlsafe() {
        let img = Gray {
            w: 1,
            h: 1,
            data: vec![7],
        };
        let uri = encode_gray_uri_cv2(&img);
        let b64 = uri.strip_prefix("data:image/png;base64,").unwrap();
        // bare base64 (no prefix) also decodes, like the Python helper
        assert_eq!(decode_png_uri(b64, false).unwrap().data, vec![7]);
    }

    #[test]
    fn urlsafe_decode_accepts_standard_alphabet() {
        // Python's urlsafe_b64decode translates -_ to +/ and standard-decodes,
        // so STANDARD-encoded input must pass the URL-safe path (the app feeds
        // /segment's standard-base64 seg map into /preprocess).
        let img = Gray {
            w: 64,
            h: 1,
            data: (0..64).map(|i| (i * 4) as u8).collect(),
        };
        let uri = encode_gray_uri_cv2(&img); // standard base64 ('+'/'/')
        assert_eq!(decode_png_uri(&uri, true).unwrap().data, img.data);
        // and genuine URL-safe input decodes too
        let urlsafe = uri.replace('+', "-").replace('/', "_");
        assert_eq!(decode_png_uri(&urlsafe, true).unwrap().data, img.data);
    }
}
