//! Byte-exact port of the vtracer-SVG parser and command-tensor builder:
//! `colorize/vectorization/lib/svg.py::SVG.from_str`/`to_tensor`/`_to_tensor`,
//! `svg_path.py::SVGPath.from_str`/`split_path_str`/`to_tensor`, and
//! `svg_command.py::SVGCommandMove/Bezier.to_tensor`.
//!
//! Production quirks preserved:
//!   - `Z` commands are silently DROPPED: `split_path_str` only yields
//!     (cmd, coords) when the coordinate list is non-empty, and `Z` is never
//!     followed by coordinates in vtracer output. If it ever were, production
//!     raises (`SVGCommandType("Z")` is not a member) — we panic.
//!   - Coordinate chunks are gated by `utils.py::contains_only_fp`
//!     (`^[0-9\s.-]+$`): a chunk containing `+` or `e` raises in production
//!     BEFORE the float regex (which would accept them) runs — we panic.
//!   - Command point tensors are (<=3, 2) f32, zero-padded to (3, 2)
//!     (`SVGPath.to_tensor`; a Move has 1 point, so rows 1-2 are 0.0).
//!   - Normalization divides x by the viewbox width and y by the height in
//!     f32 (`SVG._to_tensor`), BEFORE row padding, so the Move zero rows stay
//!     `0.0/w = +0.0` while pad rows are exactly -100.0.
//!   - Paths are padded to the per-SVG max command count with -100 rows built
//!     as a `torch.LongTensor` that `torch.cat` type-promotes into f32.
//!   - viewbox = `int(float(width_attr))` x `int(float(height_attr))`
//!     (`SVG.from_str`; float parse then truncation toward zero).
//!   - `transform="translate(x,y)"` is applied eagerly to every unique point
//!     (`SVGPath.from_xml`/`translate`) as an f32 `pos += vec` — vtracer DOES
//!     emit these, including `translate(0,0)`, which rewrites `-0.0`
//!     coordinates (vtracer emits `-0`) to `+0.0`.

use super::{Tensor, PAD_VALUE};

/// One parsed path command. Only M and C occur in vtracer spline output
/// (`svg_path.py::COMMANDS` is "MZC" and Z is dropped, see module docs).
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// end point (`SVGCommandMove.to_tensor` emits just this one row)
    Move([f32; 2]),
    /// control1, control2, end (`SVGCommandBezier.to_tensor` row order)
    Bezier([[f32; 2]; 3]),
}

impl Command {
    fn points_mut(&mut self) -> &mut [[f32; 2]] {
        match self {
            Command::Move(p) => std::slice::from_mut(p),
            Command::Bezier(p) => p,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SvgPath {
    pub commands: Vec<Command>,
}

/// `svg.py::SVG` restricted to what `SVG.from_str` keeps: the path list plus
/// the width/height viewbox.
pub struct Svg {
    pub width: i64,
    pub height: i64,
    pub paths: Vec<SvgPath>,
}

// ---------------------------------------------------------------------------
// d-string parsing

/// `utils.py::contains_only_fp`: `^[0-9\s.-]+$` (str pattern, so `\s` is
/// unicode whitespace).
fn contains_only_fp(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_digit() || c.is_whitespace() || c == '.' || c == '-')
}

/// `FLOAT_RE.findall` for chunks that already passed `contains_only_fp`
/// (alphabet [0-9 whitespace . -]), replicating the backtracking of
/// `[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?`: an optional sign, digits, and
/// a fractional part only when digits follow the dot (so `"1."` matches as
/// `"1"`, and a lone `-` or `.` matches nothing).
fn find_floats(chunk: &str) -> Vec<f64> {
    let b = chunk.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let mut j = i;
        if j < b.len() && b[j] == b'-' {
            j += 1;
        }
        let int_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let int_digits = j - int_start;
        let mut end = None;
        if j < b.len() && b[j] == b'.' {
            let mut m = j + 1;
            while m < b.len() && b[m].is_ascii_digit() {
                m += 1;
            }
            if m > j + 1 {
                end = Some(m); // sign? digits* '.' digits+
            } else if int_digits > 0 {
                end = Some(j); // regex backtracks: drop the dot, keep digits
            }
        } else if int_digits > 0 {
            end = Some(j);
        }
        match end {
            Some(e) => {
                let tok = &chunk[start..e];
                out.push(tok.parse::<f64>().unwrap_or_else(|err| {
                    panic!("float parse failed for {tok:?}: {err}")
                }));
                i = e;
            }
            None => i += 1, // no match at this position; advance the scan
        }
    }
    out
}

/// `svg_path.py::SVGPath.split_path_str`: split on M/Z/C, track the current
/// command, and yield (cmd, coords) only for non-empty coordinate lists —
/// which is what silently drops `Z`.
fn split_path_str(d: &str) -> Vec<(char, Vec<f64>)> {
    let mut out = Vec::new();
    let mut cmd: Option<char> = None;
    let mut chunk_start = 0;
    let bytes = d.as_bytes();
    let flush = |cmd: Option<char>, chunk: &str, out: &mut Vec<(char, Vec<f64>)>| {
        if chunk.is_empty() {
            return;
        }
        assert!(
            contains_only_fp(chunk),
            "invalid path command chunk {chunk:?} (production raises ValueError)"
        );
        let coords = find_floats(chunk);
        if let (Some(c), false) = (cmd, coords.is_empty()) {
            out.push((c, coords));
        }
    };
    for (i, &ch) in bytes.iter().enumerate() {
        if ch == b'M' || ch == b'Z' || ch == b'C' {
            flush(cmd, &d[chunk_start..i], &mut out);
            cmd = Some(ch as char);
            chunk_start = i + 1;
        }
    }
    flush(cmd, &d[chunk_start..], &mut out);
    out
}

/// `svg_path.py::SVGPath.from_str` (+ `svg_command.py::SVGCommand.from_str`).
/// Coordinates go through Python `float` (f64) then `geom.py::Point`'s
/// `np.float32` cast.
fn path_from_str(d: &str) -> SvgPath {
    let mut commands = Vec::new();
    for (cmd, coords) in split_path_str(d) {
        let num_args = match cmd {
            'M' => 1,
            'C' => 3,
            // SVGCommandType("Z") raises ValueError in production — only
            // reachable if a Z were followed by coordinates.
            other => panic!("coordinates after unsupported command {other:?}"),
        };
        assert_eq!(
            coords.len(),
            num_args * 2,
            "Expected {} arguments for command {cmd}: {} given",
            num_args * 2,
            coords.len()
        );
        let pts: Vec<[f32; 2]> = coords
            .chunks_exact(2)
            .map(|c| [c[0] as f32, c[1] as f32])
            .collect();
        commands.push(match cmd {
            'M' => Command::Move(pts[0]),
            _ => Command::Bezier([pts[0], pts[1], pts[2]]),
        });
    }
    assert!(
        matches!(commands.first(), Some(Command::Move(_))),
        "path must start with a MOVE_TO (SVGPath.from_str assert)"
    );
    SvgPath { commands }
}

/// `svg_path.py::SVGPath._parse_transform`: only `translate(x,y)` with
/// exactly two comma-separated numbers is supported.
fn parse_translate(transform: &str) -> [f32; 2] {
    assert!(
        transform.starts_with("translate"),
        "Transform {transform:?} not supported"
    );
    let inner = transform.trim().replace("translate(", "").replace(')', "");
    let parts: Vec<&str> = inner.split(',').collect();
    assert_eq!(parts.len(), 2, "Invalid translate: {transform:?}");
    // Python float() then Point's np.float32 cast.
    [
        parts[0].trim().parse::<f64>().unwrap_or_else(|e| panic!("Invalid translate: {transform:?}: {e}")) as f32,
        parts[1].trim().parse::<f64>().unwrap_or_else(|e| panic!("Invalid translate: {transform:?}: {e}")) as f32,
    ]
}

// ---------------------------------------------------------------------------
// XML extraction (stand-in for `xml.dom.expatbuilder`)

/// Attribute lookup inside one start tag; mirrors `getAttribute` (returns ""
/// when absent). Assumes plain quoted values, which vtracer emits — entity
/// references would need the DOM decode production gets from expat, so we
/// refuse them rather than silently diverge.
fn get_attribute<'a>(tag: &'a str, name: &str) -> &'a str {
    let bytes = tag.as_bytes();
    let mut from = 0;
    while let Some(rel) = tag[from..].find(name) {
        let p = from + rel;
        from = p + name.len();
        // the tag starts with '<', so p > 0 always holds for real attributes
        let before_ok = p > 0 && bytes[p - 1].is_ascii_whitespace();
        let after = tag[p + name.len()..].trim_start();
        if before_ok && after.starts_with('=') {
            let v = after[1..].trim_start();
            let quote = v.as_bytes().first().copied();
            if quote == Some(b'"') || quote == Some(b'\'') {
                let q = quote.unwrap() as char;
                let val = &v[1..v[1..].find(q).expect("unterminated attribute") + 1];
                assert!(
                    !val.contains('&'),
                    "entity references in attributes are not supported: {val:?}"
                );
                return val;
            }
        }
    }
    ""
}

/// Strip `<!-- -->` comments so tags inside them are not extracted
/// (vtracer's generator banner is a comment).
fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find("<!--") {
        out.push_str(&rest[..p]);
        match rest[p..].find("-->") {
            Some(q) => rest = &rest[p + q + 3..],
            None => return out, // unterminated comment: drop the tail
        }
    }
    out.push_str(rest);
    out
}

impl Svg {
    /// `svg.py::SVG.from_str`: single `<svg>` root, its `width`/`height`
    /// attributes as `int(float(...))`, and every `<path>` in document order
    /// via `SVGPath.from_xml` (empty `d` yields an empty path and skips the
    /// transform; a non-empty `d` parses then applies `translate`).
    pub fn from_str(svg_str: &str) -> Svg {
        let s = strip_comments(svg_str);
        let svg_tags: Vec<&str> = find_tags(&s, "svg");
        assert!(svg_tags.len() < 2, "Too many <svg> tags found");
        let root = *svg_tags.first().expect("no <svg> tag found");

        let parse_dim = |attr: &str| -> i64 {
            let f: f64 = attr
                .trim()
                .parse()
                .unwrap_or_else(|e| panic!("bad svg dimension {attr:?}: {e}"));
            f as i64 // Python int(float(...)) truncates toward zero
        };
        let width = parse_dim(get_attribute(root, "width"));
        let height = parse_dim(get_attribute(root, "height"));

        let mut paths = Vec::new();
        for tag in find_tags(&s, "path") {
            let d = get_attribute(tag, "d");
            if d.is_empty() {
                // SVGPath.from_xml: empty d -> SVGPath([]), transform unread
                paths.push(SvgPath { commands: Vec::new() });
                continue;
            }
            let mut path = path_from_str(d);
            let transform = get_attribute(tag, "transform");
            if !transform.is_empty() {
                let vec = parse_translate(transform);
                // SVGPath.translate: f32 `pos += vec` on every unique Point.
                // Points shared between commands (an end_pos doubling as the
                // next start_pos) are translated once; every coordinate that
                // reaches to_tensor belongs to exactly one such Point, so
                // adding to each stored point once is equivalent.
                for cmd in &mut path.commands {
                    for p in cmd.points_mut() {
                        p[0] += vec[0];
                        p[1] += vec[1];
                    }
                }
            }
            paths.push(path);
        }
        Svg { width, height, paths }
    }

    /// `svg.py::SVG.to_tensor(pad_val=-100, normalize=True,
    /// return_point_dim=False)` for the inference path (`id_map` unset):
    /// (S, C, 6) f32 where C is the max command count over paths.
    pub fn to_tensor(&self) -> Tensor<f32> {
        assert!(!self.paths.is_empty(), "SVG has no paths (max() would raise)");
        let target_shape = self
            .paths
            .iter()
            .map(|p| p.commands.len())
            .max()
            .unwrap();
        let (w, h) = (self.width as f32, self.height as f32);
        let s = self.paths.len();
        let mut data = Vec::with_capacity(s * target_shape * 6);
        for path in &self.paths {
            // SVGPath.to_tensor: (cmds, 3, 2) with Move rows zero-padded,
            // then SVG._to_tensor normalizes x/=w, y/=h in f32 and pads to
            // target_shape with -100 rows (LongTensor pad, promoted to f32
            // by torch.cat).
            for cmd in &path.commands {
                let rows: [[f32; 2]; 3] = match cmd {
                    Command::Move(p) => [*p, [0.0, 0.0], [0.0, 0.0]],
                    Command::Bezier(p) => *p,
                };
                for r in rows {
                    data.push(r[0] / w);
                    data.push(r[1] / h);
                }
            }
            for _ in path.commands.len()..target_shape {
                data.extend_from_slice(&[PAD_VALUE; 6]);
            }
        }
        Tensor::new(vec![s, target_shape, 6], data)
    }
}

/// Start tags `<name ...>` (or `<name/>`), in document order. Enough XML for
/// vtracer output; `getElementsByTagName` semantics (any depth).
fn find_tags<'a>(s: &'a str, name: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let open = format!("<{name}");
    let mut rest = s;
    let mut base = 0;
    while let Some(p) = rest.find(&open) {
        let after = rest.as_bytes().get(p + open.len()).copied();
        let is_tag = matches!(after, Some(b) if b.is_ascii_whitespace() || b == b'>' || b == b'/');
        if is_tag {
            let end = rest[p..].find('>').expect("unterminated tag") + p;
            out.push(&s[base + p..base + end]);
            base += end;
            rest = &s[base..];
        } else {
            base += p + open.len();
            rest = &s[base..];
        }
    }
    out
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_floats_matches_float_re() {
        assert_eq!(find_floats("448 60"), vec![448.0, 60.0]);
        assert_eq!(find_floats("16 -0 23"), vec![16.0, -0.0, 23.0]);
        assert!(find_floats("16 -0 23")[1].is_sign_negative());
        assert_eq!(find_floats("0.5 .5"), vec![0.5, 0.5]);
        assert_eq!(find_floats("1."), vec![1.0]); // regex backtracks off the dot
        assert_eq!(find_floats("1.2.3"), vec![1.2, 0.3]);
        assert_eq!(find_floats(" - . "), Vec::<f64>::new());
        assert_eq!(find_floats("12-34"), vec![12.0, -34.0]);
    }

    #[test]
    fn z_commands_are_dropped() {
        let p = path_from_str("M1 2 C3 4 5 6 7 8 Z ");
        assert_eq!(p.commands.len(), 2);
        assert_eq!(p.commands[0], Command::Move([1.0, 2.0]));
    }

    #[test]
    fn multiple_subpaths_parse_as_extra_moves() {
        let p = path_from_str("M1 2 C3 4 5 6 7 8 Z M9 10 C1 1 2 2 3 3 Z ");
        assert_eq!(p.commands.len(), 4);
        assert_eq!(p.commands[2], Command::Move([9.0, 10.0]));
    }

    #[test]
    #[should_panic(expected = "unsupported command")]
    fn z_with_coordinates_panics_like_production() {
        path_from_str("M1 2 Z3 4");
    }

    #[test]
    #[should_panic(expected = "invalid path command chunk")]
    fn scientific_notation_rejected_before_float_re() {
        // contains_only_fp rejects 'e' even though FLOAT_RE would accept it
        path_from_str("M1e3 4");
    }

    #[test]
    #[should_panic(expected = "must start with a MOVE_TO")]
    fn first_command_must_be_move() {
        path_from_str("C1 2 3 4 5 6");
    }

    #[test]
    #[should_panic(expected = "Expected 6 arguments")]
    fn wrong_arity_panics() {
        path_from_str("M1 2 C3 4 5 6");
    }

    fn svg(body: &str, w: &str, h: &str) -> Svg {
        Svg::from_str(&format!(
            "<?xml version=\"1.0\"?><!-- <path d=\"M9 9\"/> -->\
             <svg xmlns=\"x\" width=\"{w}\" height=\"{h}\">{body}</svg>"
        ))
    }

    #[test]
    fn viewbox_truncates_toward_zero() {
        let s = svg("<path d=\"M1 2 Z\"/>", "1014.9", "1024");
        assert_eq!((s.width, s.height), (1014, 1024));
    }

    #[test]
    fn comments_and_attribute_order_handled() {
        let s = svg(
            "<path fill=\"#000\" d=\"M2 4 Z\" transform=\"translate(0,0)\"/>",
            "4",
            "8",
        );
        assert_eq!(s.paths.len(), 1);
        let t = s.to_tensor();
        assert_eq!(t.shape, vec![1, 1, 6]);
        // normalized by w=4 / h=8, Move zero-pad rows
        assert_eq!(t.data, vec![0.5, 0.5, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn translate_zero_rewrites_negative_zero() {
        let s = svg(
            "<path d=\"M-0 2 Z\" transform=\"translate(0,0)\"/>\
             <path d=\"M-0 2 Z\"/>",
            "2",
            "2",
        );
        let t = s.to_tensor();
        // translated path: -0.0 + 0.0 = +0.0
        assert_eq!(t.data[0].to_bits(), 0.0f32.to_bits());
        // untranslated path keeps -0.0, and -0.0/2.0 = -0.0
        assert_eq!(t.data[6].to_bits(), (-0.0f32).to_bits());
    }

    #[test]
    fn translate_applies_to_all_points() {
        let s = svg(
            "<path d=\"M1 1 C2 2 3 3 4 4 Z\" transform=\"translate(10,20)\"/>",
            "1",
            "1",
        );
        let t = s.to_tensor();
        assert_eq!(
            t.data,
            vec![11.0, 21.0, 0.0, 0.0, 0.0, 0.0, 12.0, 22.0, 13.0, 23.0, 14.0, 24.0]
        );
    }

    #[test]
    fn pad_rows_are_minus_100_after_normalization() {
        let s = svg(
            "<path d=\"M1 1 C2 2 3 3 4 4 Z\"/><path d=\"M1 1 Z\"/>",
            "2",
            "2",
        );
        let t = s.to_tensor();
        assert_eq!(t.shape, vec![2, 2, 6]);
        assert_eq!(&t.data[18..24], &[PAD_VALUE; 6]); // second path, row 1
        assert_eq!(&t.data[12..14], &[0.5, 0.5]); // normalized, not padded
    }

    #[test]
    fn empty_d_yields_all_pad_slot() {
        let s = svg("<path d=\"M1 1 Z\"/><path d=\"\"/>", "2", "2");
        let t = s.to_tensor();
        assert_eq!(t.shape, vec![2, 1, 6]);
        assert_eq!(&t.data[6..12], &[PAD_VALUE; 6]);
    }
}
