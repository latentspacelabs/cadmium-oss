/* eslint-disable */
import path from 'path';
import fs from 'fs';
import {
  app,
} from 'electron';

const DEFAULT_BUCKET_NAME = 'deleteOnExitBucket';
// NOTE: this variable is defined twice for both render and main process,
// see defineTempDir() in file-util.js
const TEMP_BUCKET_DIR = path.join(app.getPath('userData'), 'tempBucketDir');

let instance = null;

export const getInstance = () => {
  if (!instance) {
    /* eslint-disable no-use-before-define */
    instance = new TempFileManager();
  }
  return instance;
};

export default class TempFileManager {
  constructor() {
    this.fileBuckets = {};
    this.createFileBucket(DEFAULT_BUCKET_NAME);
    // console.log('tempFileManager instance created');
  } //

  /**
   * @param {string} filePath - Path to the file
   * @param {string} [bucketName=DEFAULT_BUCKET_NAME] - Name of the bucket
   */
  addFilePathToBucket(filePath, bucketName = DEFAULT_BUCKET_NAME) {
    const bucket = this.getBucketByName(bucketName);
    if (bucket) {
      bucket.push(filePath);
      // console.log('Adding Temp File:', bucket.length);
    }
  }

  /* eslint-disable class-methods-use-this */
  getDefaultBucketName() { return DEFAULT_BUCKET_NAME; }

  getDefaultBucketDirName() {
    // console.log('TEMP_BUCKET_DIR: ', TEMP_BUCKET_DIR);
    return TEMP_BUCKET_DIR;
  }

  getDefaultBucket() { return this.getBucketByName(DEFAULT_BUCKET_NAME); }

  createTempDir() {
    this.createTempDirFolder();
    return this.getDefaultBucketDirName(TEMP_BUCKET_DIR);
  }

  getBucketNames() {
    return Object.keys(this.fileBuckets);
  }

  /**
   * @param {string} bucketName - Name of the bucket
   */
  getBucketByName(bucketName) {
    /* eslint-disable no-prototype-builtins */
    if (this.fileBuckets.hasOwnProperty(bucketName)) {
      return this.fileBuckets[bucketName];
    }
    return null;
  }

  /**
   * @param {string} bucketName - Name of the bucket
   */
  deleteFilesInBucket(bucketName = DEFAULT_BUCKET_NAME) {
    // console.log('deleteFilesInBucket called...');
    return new Promise(async (resolve, reject) => {
      const bucket = this.getBucketByName(bucketName);
      if (bucket) {
        // console.log('bucket: ', bucket);
        // console.log('bucketName: ', bucketName);
        /* eslint-disable no-restricted-syntax */
        for (const filePath of bucket) {
          try {
            /* eslint-disable no-use-before-define */
            /* eslint-disable no-await-in-loop */
            await deleteFile(filePath);
            // console.log('Removing Temp File: ', filePath);
          } catch (err) {
            reject(err);
          }
        }
        bucket.length = 0;
        resolve();
      }
      reject(new Error(`Could not delete files in bucket ${bucketName}. Does the bucket exist?`));
    });
  }

  deleteBucket(bucketName = DEFAULT_BUCKET_NAME) {
    // console.log('deleteBucket called');
    return new Promise(async (resolve, reject) => {
      const bucket = this.getBucketByName(bucketName);
      if (bucket) {
        bucket.length = 0;
      }
      // console.log('bucket deleted, length is now ', bucket.length);
      resolve();
      reject(new Error(`Could not delete bucket ${bucketName}. Does the bucket exist?`));
    });
  }

  deleteTempDirFolder(tempFolder = TEMP_BUCKET_DIR) {
    // console.log('deleteTempDir Folder called...');
    return new Promise(async (resolve, reject) => {
      if (fs.existsSync(tempFolder)) {
        // console.log('tempFolder exists, so we can delete: ', tempFolder);
        /* eslint-disable no-restricted-syntax */
        fs.rmdirSync(tempFolder, { recursive: true });
        console.log('tempFolder was deleted');
      }
      this.deleteBucket();
      resolve();
      reject(new Error(`Could not delete tempdir Folder. Does the folder exist?`));
    });
  }

  createTempDirFolder(tempFolder = TEMP_BUCKET_DIR) {
    // console.log('createTempDir Folder called...');
    return new Promise(async (resolve, reject) => {
      if (!fs.existsSync(tempFolder)) {
        // console.log('no temp folder exists yet');
        try {
          // console.log('creating tempDir...');
          this.createFolder(TEMP_BUCKET_DIR);
        } catch (err) {
          reject(new Error(`Could not create temp dir folder`));
        }
      } else {
        console.log('temp folder already exists...');
      }
      console.log('temp folder was created');
      resolve();
    });
  }

  createFileBucket(bucketName) {
    if (!this.fileBuckets[bucketName]) {
      this.fileBuckets[bucketName] = [];
    }
  }

  deleteFileBucket(bucketName) {
    /* eslint-disable no-prototype-builtins */
    if (this.fileBuckets.hasOwnProperty(bucketName)) {
      delete this.fileBuckets[bucketName];
    }
  }

  createFolder(folderPath) {
    if (!fs.existsSync(folderPath)) {
      // console.log('server path from tempFileManager: ', folderPath);
      fs.mkdirSync(folderPath);
    }
  }
}

function deleteFile(filePath) {
  return new Promise((resolve, reject) => {
    // To make double sure that we do not delete something important
    // we only delete certain file extensions
    const allowedFileExtensions = [
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
    ];
    const fileExt = path.extname(filePath);
    if (allowedFileExtensions.includes(fileExt)) {
      fs.unlink(filePath, (err) => {
        if (err) {
          // console.error(`Could not delete temp file ${filePath}`);
          reject(err);
          return;
        }
        // console.log(`Deleted temp file ${filePath}`);
        resolve();
      });
    } else {
      reject(new Error(`Could not delete file path with name ${filePath} because the file extension is not whitelisted to be deleted.`));
    }
  });
}
