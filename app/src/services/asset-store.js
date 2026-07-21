/**
 * asset-store — a facade over the Vuex ImageStore that gives image-byte access
 * an explicit contract (architecture doc §3.2, bug factory F2).
 *
 * IMPORTANT: during this migration phase the facade does NOT own a copy of the
 * bytes. The memory tier IS the Vuex ImageStore — it stays the single source of
 * truth. What this module adds on top of it is:
 *
 *   1. a disk tier (`<diskDir>/<imageDataId>.png`) written through on `put`,
 *   2. an async, never-null accessor (`getAsset`) that hydrates from disk when
 *      the in-memory `dataUri` was nulled (deletion / not-yet-loaded), and
 *   3. a typed `AssetMissingError` so callers stop conflating "no drawing"
 *      with "not loaded".
 *
 * The `store` argument is anything with Vuex `.getters`, `.commit` and
 * `.dispatch` — a real `Vuex.Store`, or the `{ getters, commit, dispatch }`
 * context object handed to an action.
 *
 * Disk-tier location (see report / LOAD_FILE analysis): the per-project temp
 * dir `defineTempDir()` = `<userData>/tempBucketDir` is wiped wholesale on every
 * project load — `LOAD_FILE` (actions.js) calls `clearTempFiles()`, whose main
 * handler `rmdirSync(tempBucketDir, { recursive: true })` (TempFileManager
 * `deleteTempDirFolder`). So the asset cache is placed BESIDE it at
 * `<userData>/assetCache`, NOT inside it, and therefore survives project
 * switching.
 *
 * All disk IO goes through `fs.promises` behind a lazy `require`, matching the
 * platform-seam style (`@/platform`), so importing this module never touches
 * Electron at load time and the disk dir can be injected in tests.
 */

import {
  IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID,
} from '@/store/getter-types';

import {
  HYDRATE_IMAGE_DATA_URI,
} from '@/store/mutation-types';

import {
  STORE_IMAGE_IN_IMAGE_STORE,
  OVERWRITE_IMAGE_IN_IMAGE_STORE,
} from '@/store/action-types';

import { getHash } from '@/util/hash';

const DATA_URI_PNG_PREFIX = 'data:image/png;base64,';

/**
 * Thrown by `getAsset` when neither the memory tier nor the disk tier can
 * supply bytes for an id.
 *
 * `reason` distinguishes the two cases we CAN tell apart from the ImageStore:
 *  - `'never-existed'`      — no ImageStore record for this id at all.
 *  - `'evicted-no-disk-copy'` — a record exists (it once held, or was allocated
 *    to hold, bytes: a real image whose dataUri was nulled on delete, or a ghost
 *    color/line frame that never had bytes) but neither memory nor disk has the
 *    data. We fold the ghost case into this reason rather than adding a third:
 *    from the byte tiers' point of view "record present, no bytes anywhere" is
 *    one situation, and the observable get/tryGet behaviour is identical.
 */
export class AssetMissingError extends Error {
  constructor(imageDataId, reason) {
    super(`Asset ${imageDataId} is not available (${reason}).`);
    this.name = 'AssetMissingError';
    this.imageDataId = imageDataId;
    this.reason = reason;
  }
}

// --- disk tier (lazy fs, injectable dir) ---

function defaultDiskDir() {
  const path = require('path');
  const { getUserDataPath } = require('@/platform');
  return path.join(getUserDataPath(), 'assetCache');
}

function diskPathFor(diskDir, imageDataId) {
  const path = require('path');
  return path.join(diskDir, `${imageDataId}.png`);
}

function rawBase64FromDataUri(dataUri) {
  const commaIndex = dataUri.indexOf(',');
  return commaIndex === -1 ? dataUri : dataUri.substring(commaIndex + 1);
}

async function readFromDisk(diskDir, imageDataId) {
  const fs = require('fs').promises;
  try {
    const buffer = await fs.readFile(diskPathFor(diskDir, imageDataId));
    return DATA_URI_PNG_PREFIX + buffer.toString('base64');
  } catch (err) {
    // ENOENT (never persisted) or any read error is a disk-tier miss.
    return null;
  }
}

/**
 * Delete an id's disk-tier file. Fire-and-forget: resolves quietly whether the
 * file existed or not. Used when a disk copy fails hash validation (stale) and
 * by delete flows that retire an id for good.
 */
export function removeAssetFile(diskDir, imageDataId) {
  const fs = require('fs').promises;
  return fs.unlink(diskPathFor(diskDir, imageDataId)).catch(() => {});
}

/**
 * Persist raw decoded PNG bytes for an id to the disk tier. Returns a promise
 * that NEVER rejects — a failed write only warns, so callers can fire-and-forget
 * it off the hot path without an unhandled rejection.
 */
export function writeAssetThrough(diskDir, imageDataId, dataUri) {
  const fs = require('fs').promises;
  const raw = rawBase64FromDataUri(dataUri);
  const buffer = Buffer.from(raw, 'base64');
  return fs.mkdir(diskDir, { recursive: true })
    .then(() => fs.writeFile(diskPathFor(diskDir, imageDataId), buffer))
    .catch((err) => {
      console.warn(`AssetStore: disk write-through failed for ${imageDataId}: ${err && err.message}`);
    });
}

// --- accessors ---

/**
 * Resolve the dataUri for an id, hydrating from disk if the memory tier was
 * evicted. Resolution order: (1) in-memory dataUri; (2) disk copy — on hit it
 * is committed back into the ImageStore via HYDRATE_IMAGE_DATA_URI (which does
 * NOT clobber segmentationMapPath) so subsequent sync readers see it; (3) throw.
 *
 * @param {Object} store - Vuex store or action context ({ getters, commit }).
 * @param {string} imageDataId
 * @param {Object} [opts]
 * @param {string} [opts.diskDir] - disk-tier dir (defaults to <userData>/assetCache).
 * @returns {Promise<string>} the dataUri — never null.
 * @throws {AssetMissingError}
 */
export async function getAsset(store, imageDataId, opts = {}) {
  const { diskDir = defaultDiskDir() } = opts;

  const record = store.getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](imageDataId);

  // 1. memory tier
  if (record && record.dataUri) {
    return record.dataUri;
  }

  // 2. disk tier — trusted ONLY when the bytes hash-match the record. The disk
  // copy is written by putAsset/replaceAsset, but other byte-writers (canvas
  // paint REPLACE_IMAGE_DATA_URI, recolorPalette, deletion nulling the record)
  // never touch disk, so an unvalidated read could resurrect stale, undone, or
  // deleted bytes into renders and saves. No record, no record.hash, or a hash
  // mismatch means the file is not evidence of anything: drop it and miss.
  const fromDisk = await readFromDisk(diskDir, imageDataId);
  if (fromDisk) {
    if (record && record.hash && getHash(fromDisk) === record.hash) {
      store.commit(HYDRATE_IMAGE_DATA_URI, { imageDataId, dataUri: fromDisk });
      return fromDisk;
    }
    removeAssetFile(diskDir, imageDataId);
  }

  // 3. miss
  throw new AssetMissingError(imageDataId, record ? 'evicted-no-disk-copy' : 'never-existed');
}

/**
 * Same resolution as getAsset, but returns null instead of throwing on a miss.
 * The behaviour-preserving adapter for call sites that used to read the nullable
 * IMAGE_DATA_URI_BY_IMAGE_DATA_ID getter.
 *
 * @returns {Promise<string|null>}
 */
export async function tryGetAsset(store, imageDataId, opts = {}) {
  try {
    return await getAsset(store, imageDataId, opts);
  } catch (err) {
    if (err instanceof AssetMissingError) { return null; }
    throw err;
  }
}

/**
 * Store new bytes: delegates to STORE_IMAGE_IN_IMAGE_STORE (keeping its
 * dedupe-by-hash semantics and returning the id), then fire-and-forget
 * write-through to the disk tier.
 *
 * @param {Object} store
 * @param {string} dataUri
 * @param {Object} [opts]
 * @param {boolean} [opts.forceNew=false] - forwarded to the action.
 * @param {string} [opts.diskDir]
 * @returns {Promise<string>} the image data id.
 */
export async function putAsset(store, dataUri, opts = {}) {
  const { forceNew = false, diskDir = defaultDiskDir() } = opts;
  const imageDataId = await store.dispatch(STORE_IMAGE_IN_IMAGE_STORE, { dataUri, forceNew });
  writeAssetThrough(diskDir, imageDataId, dataUri); // fire-and-forget
  return imageDataId;
}

/**
 * Replace the bytes of an existing record: delegates to
 * OVERWRITE_IMAGE_IN_IMAGE_STORE (which returns null when the id is unknown,
 * preserved here), then fire-and-forget write-through on success.
 *
 * @returns {Promise<string|null>} the image data id, or null if not found.
 */
export async function replaceAsset(store, imageDataId, dataUri, opts = {}) {
  const { diskDir = defaultDiskDir() } = opts;
  const id = await store.dispatch(OVERWRITE_IMAGE_IN_IMAGE_STORE, { imageDataId, dataUri });
  if (id) {
    writeAssetThrough(diskDir, id, dataUri); // fire-and-forget
  }
  return id;
}
