/**
 * attachFilePaths — Electron ≥32 removed the nonstandard `File.path`, so the
 * helper re-attaches real filesystem paths via webUtils.getPathForFile after
 * an import builds its file queue. electron is mocked; @/platform and the
 * dialog helper are stubbed so the import stays renderer-free.
 */
jest.mock('@/platform', () => ({ getUserDataPath: jest.fn(() => '/tmp') }));
jest.mock('@/util/customDialog', () => jest.fn());
jest.mock('electron', () => ({
  webUtils: {
    getPathForFile: jest.fn((file) => (file.synthetic ? '' : `/abs/${file.name}`)),
  },
}));

const { attachFilePaths } = require('@/util/file-util');
const { webUtils } = require('electron');

describe('attachFilePaths', () => {
  it('attaches webUtils paths to pathless files and returns the same array', () => {
    const files = [{ name: 'a.png' }, { name: 'b.png' }];
    const out = attachFilePaths(files);
    expect(out).toBe(files);
    expect(files[0].path).toBe('/abs/a.png');
    expect(files[1].path).toBe('/abs/b.png');
  });

  it('leaves an existing path alone', () => {
    const file = { name: 'c.png', path: '/already/c.png' };
    attachFilePaths([file]);
    expect(file.path).toBe('/already/c.png');
    expect(webUtils.getPathForFile).not.toHaveBeenCalledWith(file);
  });

  it('skips files webUtils cannot resolve (synthetic Files)', () => {
    const file = { name: 'd.png', synthetic: true };
    attachFilePaths([file]);
    expect(file.path).toBeUndefined();
  });

  it('tolerates webUtils throwing on a file', () => {
    webUtils.getPathForFile.mockImplementationOnce(() => { throw new Error('no path'); });
    const file = { name: 'e.png' };
    expect(() => attachFilePaths([file])).not.toThrow();
    expect(file.path).toBeUndefined();
  });
});
