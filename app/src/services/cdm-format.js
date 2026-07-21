/**
 * cdm-format — the pure serializer/parser for the .cdm project-file format.
 *
 * A .cdm file is three JSON blobs glued together by two literal marker strings:
 *
 *   <metadataJSON>BEGINSAVESTATE<saveStateJSON>BEGINTEMPIMAGES<tempImagesJSON>
 *
 * where metadata is `[{ version }]`, saveState is the Vuex save-state object,
 * and tempImages is `[{ filename, data }, ...]` (data being a base64 data URI).
 *
 * The CREATE_SAVED_FILE / LOAD_FILE actions used to build and tear apart this
 * string inline, mixed in with fs reads/writes, base64 encoding, temp-path
 * rewriting and store bookkeeping. Only the format concerns live here — free of
 * fs/Vuex/Electron — so the fragile marker offset arithmetic can be locked down
 * by golden tests. The actions keep all I/O and state bookkeeping.
 *
 * This is a behaviour-preserving extraction: parseProject reproduces the
 * original offset logic exactly, quirks and all (see the notes on parseProject).
 *
 * ── .cdm v2 (phase 6b) ──────────────────────────────────────────────────────
 * v2 adds a fourth, APPENDED section carrying the serialized exposure-sheet
 * Document (cels + exposures + palette), guarded by a new BEGINDOCUMENT marker:
 *
 *   <metadata>BEGINSAVESTATE<saveState>BEGINTEMPIMAGES<tempImages>BEGINDOCUMENT<document>
 *
 * Appending (rather than reshaping the container) keeps v1 parsing byte-for-byte
 * unchanged: a v1 file has no BEGINDOCUMENT marker, so `search` returns -1,
 * tempImages still slices to end-of-string, and `document` comes back `null`.
 *
 * The Document is DERIVED from the legacy save-state at save time (`deriveDocument`
 * via xsheet.js celAt), and the legacy `saveState` is still serialized in full
 * and remains the LOAD source of truth for now. The document section is
 * forward-looking + a validation seam:
 *
 *   THE FLIP SEAM — LOAD_FILE hydrates from `saveState` exactly as today, then
 *   (dev-mode) VALIDATEs the derived document against the loaded state
 *   (`validateDocument`). When a future phase flips storage, the document
 *   section becomes the source and `saveState` is dropped; until then the two
 *   are kept in lock-step and the validation warns if they ever drift.
 *
 * v1 files (no document section) load exactly as today: the migration IS
 * "derive the document on the next save". `isProjectTooOld` is unchanged — the
 * app-version gate (MIN_SUPPORTED_VERSION) still decides openability; a file's
 * v2-ness is self-declared by the presence of the BEGINDOCUMENT section.
 *
 * MARKER-COLLISION QUIRK (parity): like the two original markers, BEGINDOCUMENT
 * is located by a first-occurrence `search`, so a literal "BEGINDOCUMENT" inside
 * the (JSON-encoded) saveState/tempImages would mis-split the file. This is the
 * same latent fragility BEGINSAVESTATE/BEGINTEMPIMAGES already carry; it is
 * documented and locked by a QUIRK test rather than defended against.
 */
import { compareVersions } from 'compare-versions';
import { celAt, LINE_LAYER_ID, COLOR_LAYER_ID } from '@/services/xsheet';
import { INVALID_FRAME_NR } from '@/store/general-types';

// Literal markers separating the sections. Their lengths are baked into the
// parser's offsets (14 / 15 / 13), so they must not change without updating
// every historical file on disk.
const SAVE_STATE_MARKER = 'BEGINSAVESTATE';
const TEMP_IMAGES_MARKER = 'BEGINTEMPIMAGES';
const DOCUMENT_MARKER = 'BEGINDOCUMENT';

// The .cdm payload format version carried by the (appended) document section.
// Present (document !== null) === format v2; absent === legacy v1.
export const SAVE_FORMAT_VERSION = 2;

// Files authored before this app version predate the current save format and
// cannot be opened.
export const MIN_SUPPORTED_VERSION = '0.3.0';

/**
 * Serialize the project parts into the exact on-disk .cdm string.
 *
 * Without a `document` this is byte-identical to what CREATE_SAVED_FILE built
 * (v1 layout: the two markers, JSON.stringify each part). With a `document` it
 * appends the BEGINDOCUMENT section (v2 layout). Passing no document — or a
 * falsy one — yields the exact v1 string, so nothing about v1 changes.
 *
 * @param {object}   p
 * @param {object[]} p.metadata    e.g. [{ version: appVersion }]
 * @param {object}   p.saveState   the Vuex save-state object
 * @param {object[]} p.tempImages  [{ filename, data }, ...] (data = data URI)
 * @param {object}   [p.document]  the derived exposure-sheet document (v2 only)
 * @returns {string} the .cdm file contents
 */
export function serializeProject({
  metadata, saveState, tempImages, document,
}) {
  const base = JSON.stringify(metadata).concat(
    SAVE_STATE_MARKER, JSON.stringify(saveState),
    TEMP_IMAGES_MARKER, JSON.stringify(tempImages),
  );
  if (!document) { return base; }
  return base.concat(DOCUMENT_MARKER, JSON.stringify(document));
}

/**
 * Parse a .cdm file string back into its three parts plus the extracted
 * version.
 *
 * Reproduces the original LOAD_FILE arithmetic exactly:
 *  - metadata: from the first '[' to the first ']', sliced as
 *    `substr(firstOpen, firstClose + 1)`. Note `substr`'s second arg is a
 *    LENGTH, not an end index, so this actually takes `firstClose + 1`
 *    characters starting at `firstOpen`. For a well-formed file the metadata
 *    section begins at index 0 (firstOpen === 0), so length `firstClose + 1`
 *    lands exactly on the closing ']' — but the arithmetic is fragile if the
 *    file's leading bytes ever shift (see report notes).
 *  - saveState: from just after the BEGINSAVESTATE marker to the start of the
 *    BEGINTEMPIMAGES marker.
 *  - tempImages: from just after the BEGINTEMPIMAGES marker to end of string.
 *
 * v2 files additionally carry a BEGINDOCUMENT section at the end; `document` is
 * that parsed object, or `null` for a v1 file (no marker). Detecting the marker
 * also bounds the tempImages slice — v1 (marker absent, position -1) slices
 * tempImages to end-of-string exactly as before.
 *
 * @param {string} fileDataString
 * @returns {{ metadata: object[], version: string, saveState: object,
 *             tempImages: object[], document: (object|null) }}
 */
export function parseProject(fileDataString) {
  const firstOpen = fileDataString.indexOf('[');
  const firstClose = fileDataString.indexOf(']');
  const metadata = JSON.parse(fileDataString.substr(firstOpen, firstClose + 1));
  const version = metadata[0].version;

  const statePosition = fileDataString.search(SAVE_STATE_MARKER) + SAVE_STATE_MARKER.length;
  const tempFilesPosition = fileDataString.search(TEMP_IMAGES_MARKER);
  const saveState = JSON.parse(fileDataString.slice(statePosition, tempFilesPosition));

  // v2: the appended document section. Absent (position -1) in a v1 file, in
  // which case tempImages still runs to end-of-string (v1 parity).
  const documentPosition = fileDataString.search(DOCUMENT_MARKER);
  const tempImagesEnd = documentPosition === -1 ? fileDataString.length : documentPosition;
  const tempImages = JSON.parse(
    fileDataString.slice(tempFilesPosition + TEMP_IMAGES_MARKER.length, tempImagesEnd),
  );
  const document = documentPosition === -1
    ? null
    : JSON.parse(fileDataString.slice(documentPosition + DOCUMENT_MARKER.length));

  return {
    metadata, version, saveState, tempImages, document,
  };
}

/**
 * Whether a project of the given version predates MIN_SUPPORTED_VERSION and is
 * too old to open. Mirrors the original `compareVersions(version, '0.3.0') < 0`
 * gate.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isProjectTooOld(version) {
  return compareVersions(version, MIN_SUPPORTED_VERSION) < 0;
}

/**
 * Infer a cel's color provenance from the legacy model (best-effort, since the
 * current model does not store provenance explicitly). No color -> 'none'; an
 * imported/reference color frame (isOriginal) -> 'reference'; anything else with
 * color -> 'colorized'. This is derived data used for the v2 document + the
 * validation seam, not (yet) a load source.
 */
function deriveColorProvenance(layers, frameNr, colorImageId) {
  if (!colorImageId) { return 'none'; }
  const colorLayer = layers[COLOR_LAYER_ID];
  const colorFrame = colorLayer && colorLayer.frames && colorLayer.frames[frameNr];
  return colorFrame && colorFrame.isOriginal ? 'reference' : 'colorized';
}

/**
 * Derive the exposure-sheet Document from a legacy save-state (the whole Vuex
 * state), purely. Cels are the unique (lineImageId, colorImageId) pairs exposed
 * across [firstReal, lastReal] — identity answered by xsheet.celAt (bug factory
 * F3, one home for dupe answers). Exposures map each track's frameNr to its cel.
 * Deterministic (cel ids `c1, c2, …` assigned by first occurrence), so
 * serialize -> parse -> deep-equal holds.
 *
 * @param {object} saveState - the Vuex save-state (SAVE_STATE getter = state).
 * @returns {{ canvasSize: {width:number,height:number}, palette: object[],
 *   cels: Array<{id:string,lineImageId:?string,colorImageId:?string,colorProvenance:string}>,
 *   exposures: { line: Object<string,string>, color: Object<string,string> },
 *   firstReal: number, lastReal: number }}
 */
export function deriveDocument(saveState) {
  const layers = (saveState && saveState.layers) || {};
  const firstReal = saveState ? saveState.firstRealFrameNumber : INVALID_FRAME_NR;
  const lastReal = saveState ? saveState.lastRealFrameNumber : INVALID_FRAME_NR;
  const canvasSize = {
    width: saveState ? saveState.canvasWidth : 0,
    height: saveState ? saveState.canvasHeight : 0,
  };
  const palette = (saveState && saveState.colorPalette) || [];

  const cels = [];
  const celIdByKey = new Map();
  const exposures = { line: {}, color: {} };

  const hasFrames = firstReal !== INVALID_FRAME_NR
    && lastReal !== INVALID_FRAME_NR
    && lastReal >= firstReal;

  const imageDataById = (saveState && saveState.ImageStore
    && saveState.ImageStore.imageDataById) || {};
  // An id whose image record carries no bytes is a ghost placeholder (imports
  // fabricate `<lineId>_color` / `<colorId>_line` blanks) — it contributes no
  // pixels, so the document must not record it as art: the cel side becomes
  // null (and color provenance 'none') instead of a phantom 'colorized'.
  const hasBytes = (imageId) => {
    const record = imageId && imageDataById[imageId];
    return !!(record && record.dataUri);
  };

  if (hasFrames) {
    for (let frameNr = firstReal; frameNr <= lastReal; frameNr += 1) {
      const cel = celAt(layers, frameNr);
      if (!cel) { continue; } // eslint-disable-line no-continue
      const lineImageId = hasBytes(cel.lineImageId) ? cel.lineImageId : null;
      const colorImageId = hasBytes(cel.colorImageId) ? cel.colorImageId : null;
      const key = `${lineImageId || ''}||${colorImageId || ''}`;
      let celId = celIdByKey.get(key);
      if (!celId) {
        celId = `c${cels.length + 1}`;
        celIdByKey.set(key, celId);
        cels.push({
          id: celId,
          lineImageId: lineImageId || null,
          colorImageId: colorImageId || null,
          colorProvenance: deriveColorProvenance(layers, frameNr, colorImageId),
        });
      }
      if (lineImageId) { exposures.line[frameNr] = celId; }
      if (colorImageId) { exposures.color[frameNr] = celId; }
    }
  }

  return {
    canvasSize, palette, cels, exposures, firstReal, lastReal,
  };
}

/**
 * The flip seam's validation: compare the document DERIVED from a freshly loaded
 * save-state against the document that was serialized alongside it. When a v2
 * save/load round-trips faithfully they are deep-equal; any drift names the
 * differing top-level fields so a future storage flip can trust the section.
 *
 * @param {object} saveState        the loaded save-state.
 * @param {object} expectedDocument the parsed document section (v2 file).
 * @returns {{ ok: boolean, mismatches: string[] }}
 */
export function validateDocument(saveState, expectedDocument) {
  const derived = deriveDocument(saveState);
  const expected = expectedDocument || {};
  const mismatches = [];
  ['canvasSize', 'palette', 'cels', 'exposures', 'firstReal', 'lastReal'].forEach((k) => {
    if (JSON.stringify(derived[k]) !== JSON.stringify(expected[k])) {
      mismatches.push(k);
    }
  });
  return { ok: mismatches.length === 0, mismatches };
}
