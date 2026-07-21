import fs from 'fs';
import os from 'os';
import path from 'path';
import TempFileManager from '@/util/TempFileManager';

describe('TempFileManager.js', () => {
  it('creates a new default bucket in constructor', () => {
    const tmpFileMgr = new TempFileManager();
    expect(tmpFileMgr.getBucketNames().length).toBe(1);
  });

  it('add an entry to the default bucket and retrieve it', () => {
    const tmpFileMgr = new TempFileManager();
    const testFilePath = '/foo/bar.png';
    tmpFileMgr.addFilePathToBucket(testFilePath);
    const defaultBucket = tmpFileMgr.getDefaultBucket();
    expect(defaultBucket[0]).toMatch(testFilePath);
  });

  it('delete an image file', async () => {
    const tmpFileMgr = new TempFileManager();
    const testFilePath = path.join(os.tmpdir(), 'foo.png');
    fs.writeFileSync(testFilePath, 'foo test 123');
    expect(fs.existsSync(testFilePath)).toBe(true);
    tmpFileMgr.addFilePathToBucket(testFilePath);
    await tmpFileMgr.deleteFilesInBucket();
    expect(fs.existsSync(testFilePath)).toBe(false);
  });

  it('reject to delete a non-image file', async () => {
    const tmpFileMgr = new TempFileManager();
    const testFilePath = path.join(os.tmpdir(), 'foo.bar');
    fs.writeFileSync(testFilePath, 'foo test 123');
    expect(fs.existsSync(testFilePath)).toBe(true);
    tmpFileMgr.addFilePathToBucket(testFilePath);
    let errMessage = null;
    try {
      await tmpFileMgr.deleteFilesInBucket();
    } catch (err) {
      errMessage = err.message;
    }
    expect(errMessage).toBeTruthy();
    expect(fs.existsSync(testFilePath)).toBe(true);
  });
});
