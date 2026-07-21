/* eslint-disable  */
import { i18n } from './i18nVue';
import { getUserDataPath } from '@/platform';

const fs = require('fs');
const extract = require('png-chunks-extract');
const encode = require('png-chunks-encode');
import showCustomDialog from '@/util/customDialog';
const path = require('path');

/**
 * @external FileSystemEntry
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemEntry|FileSystemEntry}
 */

/**
 * @external File
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/File|File}
 */

/**
 * @param {external:FileSystemEntry} fileSystemEntry -
 * @returns {Promise} Resolves to a File
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/File|File}
 */
export function getFileFromFileSystemEntry(fileSystemEntry) {
  return new Promise((resolve, reject) => {
    if (!fileSystemEntry) {
      reject(new Error('Param fileSystemEntry is null.'));
      return;
    }
    fileSystemEntry.file(resolve, reject);
  });
}

export function sortByName(a, b) {
  // Use toUpperCase() to ignore character casing
  const itemA = a.name.toUpperCase();
  const itemB = b.name.toUpperCase();

  let comparison = 0;
  if (itemA > itemB) {
    comparison = 1;
  } else if (itemA < itemB) {
    comparison = -1;
  }
  return comparison;
}

/**
* Returns the file extension (always in lowercase) of a filename or path
* (e.g. foo/bar/img.png) -> png
* @param {string} filename - Filename or path
* @returns {string} - Lowercased filename (e.g. 'png')
*/
export function getFileExtension(filename) {
  if (!filename) { throw new Error('Filename is null'); }
  return filename.substring(filename.lastIndexOf('.') + 1).toLowerCase();
}

// supported file extensions in lower case
// TODO: Maybe this would be better off in the store?
// But then it would need to be passed as param to the functions using it...
const SUPPORTED_FILE_EXTENSIOMS = [
  'png',
];

/**
 * @returns {Array} - An array with supported image file extensions
 */
export function getSupportedImageFileExtensions() {
  // make shallow copy, so it cannot be edited accidentally
  return [...SUPPORTED_FILE_EXTENSIOMS];
}

/**
 * Checks if a file is a supported image file / has a fitting extension.
 * @param {String} filename - Filename (e.g. `dog.jpg`) or path (e.g. `~/images/dog.jpg`)
 * @returns {boolean} - `true` if the file is a supported image file
 */
export function hasSupportedImageFileExtension(filename) {
  if (!filename) {
    console.warn(`${filename} has no file extension.`);
    return false;
  }
  const ext = getFileExtension(filename);
  return SUPPORTED_FILE_EXTENSIOMS.some(supportedExt => supportedExt === ext);
}

export function getFileEntriesFromMenu() {
  return new Promise((resolve) => {
    const inputElement = document.getElementById('import-from-menu-button');

    function handleFiles() {
      const fileList = this.files;
      resolve(fileList);
      // console.log('FILE LIST: ', fileList)
    }

    inputElement.addEventListener('change', handleFiles, false);
  });
}

// HARRYS FUNCTION START
export async function getDirectoryEntriesAll(fileSystemDirectoryEntry) {
  return new Promise((resolve) => {
    const dirReader = fileSystemDirectoryEntry.createReader();
    const entriesAll = [];
    let k = 0;
    // let nest = 0;
    async function getEntries() {
      return new Promise((resolve2) => {
        // console.log('getEntries called');
        /* eslint-disable-next-line */
        dirReader.readEntries(function resulter(results) {
          // console.log('readEntries...');
          if (results.length) {
            let i = 0;
            for (i = 0; i < results.length; i += 1) {
              if (results[i].isFile && results[i].name !== '.DS_Store') {
                entriesAll[k] = results[i];
                // console.log("accepted entry: " + entriesAll[k].name);
                k += 1;
              }
            }
            // console.log('nest ', nest, ' results: ', entriesAll.length);
            // nest += 1;
            getEntries();
            // this next line is a hack to waits for the whole array to populate
            /* eslint-disable-next-line */
            setTimeout(function () { resolve2(entriesAll); }, 50);
          } else {
            // console.log('no entries found in nest: ', nest);
          }
        });
        // console.table(entriesAll);
      });
    }
    resolve(getEntries());
  });
}
// HARRYS FUNCTION END

// NOTE: this variable is defined twice for both render and main process, see TEMP_BUCKET_DIR in tempFileManager.js
export function defineTempDir() {
  return path.join(getUserDataPath(), 'tempBucketDir');
}

/**
 * Returns all child-files of a directory (not recursive), ignores child-directories.
 * @param {Object} fileSystemDirectoryEntry
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryEntry|FileSystemDirectoryEntry}
 * @returns {Array} - Array of FileSystemFileEntry objects
 */


/* eslint-disable no-inner-declarations */
/*
// TIM's original function
export async function getDirectoryEntries(fileSystemDirectoryEntry) {
  // const entriesAll = getDirectoryEntriesAll(fileSystemDirectoryEntry);
  // console.log('entriesAll[0]: ', entriesAll[0]);
  return new Promise((resolve, reject) => {
    if (!fileSystemDirectoryEntry || !fileSystemDirectoryEntry.isDirectory) {
      reject(new Error('Param fileSystemDirectoryEntry is null or no directory.'));
      return;
    }
    fileSystemDirectoryEntry.createReader()
      .readEntries(entries => resolve(entries.filter(entry => entry.isFile)));
  });
}
*/
/**
 * Returns the MIME type (e.g. '') for a file extension.
 * Currently only supports 'png', 'jpeg' and 'jpg'.
 * @param {string} fileExtension
 */
export function getMimeTypeForFileExtension(fileExtension) {
  if (!fileExtension) { throw new Error('Could not generate MIME type. fileExtension is null.'); }
  const lowerCasedFileExt = fileExtension.toLowerCase();
  switch (lowerCasedFileExt) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
    case 'jpe':
      return 'image/jpeg';
    default:
      throw new Error('Could not generate MIME type. File extension not supported.');
  }
}

/**
 * Generates a Data URI (e.g. 'data:image/png;base64,iVBORw0KG...')
 * from base 64 data (e.g. iVBORw0KG...).
 * Data URIs can be used as `src` attribute of a HTML image element.
 * @param {string} base64Data - base64 encoded data
 * @param {string} mimeType - mime type of the file format, e.g. 'image/png'
 */
export function getDataUriFromBase64(base64Data, mimeType) {
  if (!base64Data || !mimeType) {
    throw new Error('Could not generate Data URI, base64 data or mimeType data are null!');
  }
  return `data:${mimeType};base64,${base64Data}`;
}

/**
 * Strips the header off a data URI and returns the raw data.
 * @param {string} dataUri - the base64 data URI, e.g. `data:text/plain;base64,SGVsbG8s...`
 * @returns {string} - the raw data without data URI header, e.g. `SGVsbG8s...`
 */
export function getRawDataFromDataUri(dataUri) {
  if (!dataUri) { throw new Error('dataUri is null.'); }
  const firstCommaIndex = dataUri.indexOf(',');
  if (firstCommaIndex === -1) {
    throw new Error(`parameter dataUri seems to not be a data URI, could not find comma separating data from header. dataUri: ${dataUri}`);
  }
  return dataUri.substring(firstCommaIndex + 1);
}

/**
 * Reads a file using node.js and encodes it as base64 string.
 * @param {string} filepath - Path of the file to base64 encode
 * @param {Object} options
 * @param {boolean} [options.asDataUri=false] - When `true` a Data URI
 *   (base64 data with decoration) will be returned.
 *   (e.g. 'data:image/png;base64,iVBORw0KG...'). Data URIs can be used
 *   as direct source for an image element.
 *   When `asDataUri` is `false` (default) the raw base64 data will be
 *   returned (e.g. 'iVBORw0KG...').
 * @returns {Promise<string>} - The file content as base64 string,
 *   either raw base64 or as data URI
 */
export function base64Encode(filepath, { asDataUri = false }) {
  // console.log('asDataUri: ', asDataUri);
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filepath)) {
      resolve('noFile');
    }
    fs.readFile(filepath, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      const b64Data = Buffer.from(data).toString('base64');
      if (asDataUri) {
        const mimeType = getMimeTypeForFileExtension(getFileExtension(filepath));
        const dataUri = getDataUriFromBase64(b64Data, mimeType);
        resolve(dataUri);
      } else {
        resolve(b64Data);
      }
    });
  });
}

/**
 * @param {Object} file - The file to read as base64 string, either of type `Blob` or `File`
 * @param {Object} options
 * @param {boolean} options.asDataUri - When `true` is passed a data URI will be returned
 *   (e.g. `data:text/plain;base64,SGVsbG8s...`). When `false` the raw base 64 will be returned.
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/FileReader/readAsDataURL|readAsDataURL}
 * @returns {Promise<string>} - The file as base64 string, either as data URI or raw base64
 */
/* eslint-disable no-inner-declarations */
export function base64EncodeInBrowser(file, { asDataUri = false }) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (!file) {
      reject(new Error('Param file is null'));
      return;
    }
    reader.readAsDataURL(file);
    // readAsDataURL returns a data URI
    reader.addEventListener('loadend', (event) => {
      const dataUri = event.target.result;
      if (asDataUri) {
        resolve(dataUri);
      } else {
        resolve(getRawDataFromDataUri(dataUri));
      }
    });
    reader.addEventListener('error', reject);
  });
}

/**
 * Writes Base64 encoded data to file using Node.js.
 * @param {string} filePath - path of the file to write
 * @param {string} base64Data
 * @see {@link https://nodejs.org/api/fs.html#fs_fs_writefile_file_data_options_callback|fs.writeFile}
 */
export function writeBase64DataToFile(filePath, base64Data) {
  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, base64Data, 'base64', (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function stripMetaData(filePath) {
  // DEFINE TEMP PATH TO PUT PROCESSED PNG:
  // this step doesn't seem necessary, commenting out for now...
  /* eslint-disable-next-line */
  // const processedFileName = filePath.replace(/^.*[\\\/]/, '');
  // console.log('processedFileName: ', processedFileName);
  // CREATE BUFFER to get CHUNKS
  const buffer = fs.readFileSync(filePath);
  let hasNoAlphaChannel = false;
  // ENSURE THAT THE PNG HAS ALPHA CHANNEL
  if (buffer[25] != 6){
    hasNoAlphaChannel = true;
  }

  const chunks = extract(buffer);
  // TO DO: wrap in conditional that only creates new object
  // if we find iTxt chunk, otherwise, return original fileOBJ
  // REMOVE iTXt Chunk
  /* eslint-disable-next-line */
  const processedChunks = chunks.filter(function filterChunks(removeITXt) {
    return removeITXt.name !== 'iTXt';
  });
  // BUILD NEW PNG FROM chunks
  const imageBufferData = encode(processedChunks);
  // CREATE NEW FILE OBJECT WITHOUT THE ADOBE BS
  const fileWithoutMetaData = new File([imageBufferData], filePath, {
    type: 'image/png',
  });
  // console.log('fileWithoutMetaData: ', fileWithoutMetaData);
  return [fileWithoutMetaData, hasNoAlphaChannel];
}

export function exportSVGOptions() {
  return new Promise((resolve) => {
    showCustomDialog({
      title: i18n.__('SVG Export Options'),
      message: i18n.__('What quality level do you want to export your SVG? \n (NOTE: SVG will only export the colors in your color palette. For best results, turn off Outlines layer'),
      buttons: [i18n.__('High Quality (slower)'), i18n.__('Medium Quality'), i18n.__('Low Quality (faster)'), i18n.__('Cancel')],
      defaultId: 2,
      cancelId: 3,
      type: 'info'
    }).then(result => {
      resolve(result);
    });
  });
}

export function saveOptions() {
  return new Promise((resolve) => {
    showCustomDialog({
      title: i18n.__('Save Your Work'),
      message: i18n.__('Would you like to save your changes?'),
      buttons: [i18n.__('Yes'), i18n.__('No'), i18n.__('Cancel')],
      defaultId: 0,
      cancelId: 2,
      type: 'warning'
    }).then(result => {
      resolve(result);
    });
  });
}

/*
export function convertBase64ToBinary(base64) {
  //const BASE64_MARKER = ';base64,';
  //const base64Index = dataURI.indexOf(BASE64_MARKER) + BASE64_MARKER.length;
  //const base64 = dataURI.substring(base64Index);
  const raw = window.atob(base64);
  const rawLength = raw.length;
  const array = new Uint8Array(new ArrayBuffer(rawLength));
  for(let i = 0; i < rawLength; i += 1) {
    array[i] = raw.charCodeAt(i);
  }
  const outputArray = Array.from(array);
  return outputArray;
}
*/
