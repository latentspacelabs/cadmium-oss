// Tests for the AssetStore facade (architecture doc §3.2, bug factory F2).
//
// The memory tier is a REAL, non-namespaced Vuex store built from the actual
// ImageStore module, so the dedupe-by-hash action semantics and the new
// HYDRATE_IMAGE_DATA_URI mutation are exercised for real. The disk tier is a
// REAL temp directory (fs.promises), injected via `opts.diskDir` so nothing
// touches Electron / <userData>. We only reach for jest spies to force a disk
// write failure and to assert the memory tier never reads disk.
//
// ImageStore transitively imports @/util/file-util (for defineTempDir), which
// pulls a Vue-component dialog chain we don't need here; we mock file-util down
// to the one symbol the module actually imports.
jest.mock('@/util/file-util', () => ({ defineTempDir: () => '/tmp/tempBucketDir' }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import Vue from 'vue';
import Vuex from 'vuex';

import ImageStore from '@/store/modules/ImageStore';
import {
  getAsset,
  tryGetAsset,
  putAsset,
  replaceAsset,
  writeAssetThrough,
  AssetMissingError,
} from '@/services/asset-store';
import {
  IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID,
} from '@/store/getter-types';
import {
  STORE_IMAGE_IN_IMAGE_STORE,
  STORE_BLANK_IMAGE_IN_IMAGE_STORE,
} from '@/store/action-types';
import {
  SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID,
} from '@/store/mutation-types';

Vue.use(Vuex);

const PNG_PREFIX = 'data:image/png;base64,';
// The bytes don't need to be a real PNG — the facade just base64-decodes on
// write and re-encodes on read; using the canonical prefix keeps the disk
// round-trip byte-identical to the in-memory dataUri.
const uri = b64 => PNG_PREFIX + b64;
const DATA_A = uri('aGVsbG8gd29ybGQ='); // "hello world"
const DATA_B = uri('Z29vZGJ5ZQ==');     // "goodbye"

// ImageStore.state is a plain object literal, so registering the same module in
// several stores would SHARE that state object. Give each store a fresh state so
// tests are isolated (refcounts, ids, etc. don't leak between them).
const makeStore = () => new Vuex.Store({
  modules: { ImageStore: { ...ImageStore, state: { imageDataById: {} } } },
});
const recordOf = (store, id) => store.getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](id);

// Fire-and-forget disk writes settle off the hot path; poll for the file.
const waitForFile = async (filePath) => {
  for (let i = 0; i < 50; i += 1) {
    if (fs.existsSync(filePath)) { return true; }
    /* eslint-disable-next-line no-await-in-loop */
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
};

describe('asset-store facade', () => {
  let diskDir;
  let opts;

  beforeEach(() => {
    diskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-'));
    opts = { diskDir };
  });

  afterEach(async () => {
    // Let any fire-and-forget write-throughs drain before removing the dir,
    // otherwise a still-pending write races the cleanup and warns spuriously.
    await new Promise(resolve => setTimeout(resolve, 40));
    fs.rmSync(diskDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('getAsset — memory tier', () => {
    it('returns the in-memory dataUri without touching disk', async () => {
      const store = makeStore();
      const id = await store.dispatch(STORE_IMAGE_IN_IMAGE_STORE, { dataUri: DATA_A });
      const readSpy = jest.spyOn(fs.promises, 'readFile');

      expect(await getAsset(store, id, opts)).toBe(DATA_A);
      expect(readSpy).not.toHaveBeenCalled();
    });
  });

  describe('getAsset — disk tier rehydration', () => {
    it('hydrates from disk, commits back, and does NOT clobber segmentationMapPath', async () => {
      const store = makeStore();
      // A record whose bytes were evicted (dataUri null, hash retained) but
      // that still carries a valid segmentation map path — the exact clobber
      // hazard the dedicated HYDRATE mutation exists to avoid.
      const id = await putAsset(store, DATA_A, opts);
      expect(await waitForFile(path.join(diskDir, `${id}.png`))).toBe(true);
      store.commit(SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID, {
        imageDataId: id,
        segmentationMapPath: 'some/seg/path_seg.png',
      });
      recordOf(store, id).dataUri = null; // evict bytes, keep hash

      expect(await getAsset(store, id, opts)).toBe(DATA_A);

      const rec = recordOf(store, id);
      expect(rec.dataUri).toBe(DATA_A);
      expect(rec.hash).toBeTruthy();
      expect(rec.hashDirty).toBe(false);
      // The load-bearing assertion: rehydration preserved the segmap path.
      expect(rec.segmentationMapPath).toBe('some/seg/path_seg.png');
    });

    it('refuses a disk copy whose bytes no longer hash-match the record, and drops the file', async () => {
      const store = makeStore();
      const id = await putAsset(store, DATA_A, opts);
      const filePath = path.join(diskDir, `${id}.png`);
      expect(await waitForFile(filePath)).toBe(true);

      // A writer that bypasses the facade replaces the bytes in memory
      // (REPLACE_IMAGE_DATA_URI-style: new dataUri + new hash, disk untouched),
      // then the bytes get evicted. The stale disk copy must NOT resurrect.
      const rec = recordOf(store, id);
      rec.hash = 'someOtherHash';
      rec.dataUri = null;

      await expect(getAsset(store, id, opts)).rejects.toThrow(AssetMissingError);
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(filePath)).toBe(false); // stale file dropped
    });

    it('refuses an orphan disk file whose record hash was nulled (deleted image)', async () => {
      const store = makeStore();
      const id = await store.dispatch(STORE_BLANK_IMAGE_IN_IMAGE_STORE, {});
      fs.writeFileSync(path.join(diskDir, `${id}.png`), Buffer.from('hello world'));

      // Record exists but carries no hash (REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID
      // nulls dataUri AND hash): the file is not evidence of anything.
      expect(await tryGetAsset(store, id, opts)).toBeNull();
    });
  });

  describe('getAsset / tryGetAsset — miss', () => {
    it('throws AssetMissingError(evicted-no-disk-copy) for an evicted record', async () => {
      const store = makeStore();
      const id = await store.dispatch(STORE_BLANK_IMAGE_IN_IMAGE_STORE, {});

      await expect(getAsset(store, id, opts)).rejects.toThrow(AssetMissingError);
      try {
        await getAsset(store, id, opts);
      } catch (err) {
        expect(err.imageDataId).toBe(id);
        expect(err.reason).toBe('evicted-no-disk-copy');
      }
      expect(await tryGetAsset(store, id, opts)).toBeNull();
    });

    it('throws AssetMissingError(never-existed) for an unknown id', async () => {
      const store = makeStore();
      try {
        await getAsset(store, 'no-such-id', opts);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AssetMissingError);
        expect(err.reason).toBe('never-existed');
      }
      expect(await tryGetAsset(store, 'no-such-id', opts)).toBeNull();
    });
  });

  describe('ghost images', () => {
    it('a ghost _color id returns null (tryGet) / throws (get) and has no disk file', async () => {
      const store = makeStore();
      // Ghost frames are created via STORE_BLANK (never putAsset), so no disk
      // write ever happens for them — same observable behaviour as today's null.
      const ghostId = await store.dispatch(STORE_BLANK_IMAGE_IN_IMAGE_STORE, {
        imageDataId: 'abc123_color',
      });
      const readSpy = jest.spyOn(fs.promises, 'writeFile');

      expect(await tryGetAsset(store, ghostId, opts)).toBeNull();
      await expect(getAsset(store, ghostId, opts)).rejects.toThrow(AssetMissingError);

      expect(fs.existsSync(path.join(diskDir, `${ghostId}.png`))).toBe(false);
      expect(readSpy).not.toHaveBeenCalled();
    });
  });

  describe('putAsset', () => {
    it('dedupes via the existing action and writes through to disk', async () => {
      const store = makeStore();
      const id1 = await putAsset(store, DATA_A, opts);
      const id2 = await putAsset(store, DATA_A, opts); // identical bytes

      // Dedupe-by-hash is inherited from STORE_IMAGE_IN_IMAGE_STORE.
      expect(id2).toBe(id1);
      expect(recordOf(store, id1).referenceCount).toBe(2);

      const filePath = path.join(diskDir, `${id1}.png`);
      expect(await waitForFile(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).toString()).toBe('hello world');
    });

    it('forceNew is forwarded to the action (new id for identical bytes)', async () => {
      const store = makeStore();
      const id1 = await putAsset(store, DATA_A, opts);
      const id2 = await putAsset(store, DATA_A, { ...opts, forceNew: true });
      expect(id2).not.toBe(id1);
    });

    it('a freshly put asset is then hydratable from disk after eviction', async () => {
      const store = makeStore();
      const id = await putAsset(store, DATA_B, opts);
      expect(await waitForFile(path.join(diskDir, `${id}.png`))).toBe(true);

      // Simulate eviction: null the in-memory bytes, then read again.
      recordOf(store, id).dataUri = null;
      expect(await getAsset(store, id, opts)).toBe(DATA_B);
    });
  });

  describe('replaceAsset', () => {
    it('overwrites existing bytes and returns null for an unknown id', async () => {
      const store = makeStore();
      const id = await putAsset(store, DATA_A, opts);

      expect(await replaceAsset(store, id, DATA_B, opts)).toBe(id);
      expect(recordOf(store, id).dataUri).toBe(DATA_B);

      expect(await replaceAsset(store, 'no-such-id', DATA_A, opts)).toBeNull();
    });
  });

  describe('disk write failure', () => {
    it('writeAssetThrough only warns (never rejects) when the write fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

      await expect(writeAssetThrough(diskDir, 'someid', DATA_A)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('someid'));
    });

    it('putAsset still returns the id when the disk write fails', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error('disk full'));

      const store = makeStore();
      const id = await putAsset(store, DATA_A, opts);
      expect(id).toBeTruthy();
      expect(recordOf(store, id).dataUri).toBe(DATA_A);
    });
  });
});
