/* eslint-disable linebreak-style */
/* eslint-disable */
import Vue from 'vue';
import shortid from 'shortid';

// import { logError } from '@/util/error-util';
import { getHash } from '@/util/hash';

import {
  IMAGE_DATA_OBJECT_BY_HASH,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID,
  SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID,
  IMAGE_HAS_SEGMENTATION_MAP,
} from '@/store/getter-types';

import {
  defineTempDir,
} from '@/util/file-util';

import {
  ADD_NEW_IMAGE_TO_IMAGE_STORE,
  INCREMENT_IMAGE_DATA_USAGE,
  REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID,
  SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID,
  REPLACE_IMAGE_DATA_URI,
  HYDRATE_IMAGE_DATA_URI,
  INCREMENT_IMAGE_DATA_USAGE_BY_IMAGE_DATA_ID,
} from '@/store/mutation-types';

import {
  STORE_IMAGE_IN_IMAGE_STORE,
  STORE_BLANK_IMAGE_IN_IMAGE_STORE,
  OVERWRITE_IMAGE_IN_IMAGE_STORE,
} from '@/store/action-types';

const path = require('path');
/**
 * @param {Object} config
 * @param {string} [config.id] - Optional ID, if none is passed it is generated
 */
function createBlankImageDataObject({ id = shortid.generate() } = {}) {
  return {
    id,
    dataUri: null, // image data as data uri
    hash: null, // short string-hash of the image data uri
    hashDirty: true, // if the image data changed, but the hash was not re-calculated
    referenceCount: 1, // how often this image data object is being used
    segmentationMapPath: null,
  };
}

function createImageDataObject({ dataUri, hash } = {}) {
  if (typeof dataUri !== 'string' || !hash) {
    throw new Error(`Could not create image data object!, dataUri type: ${typeof dataUri}, hash: ${hash}.`);
  }
  return {
    ...createBlankImageDataObject(),
    dataUri,
    hash,
    hashDirty: false,
  };
}

export default {

  state: {
    imageDataById: {
      // map of imageData objects, key: shortid (uuid)
      // for content of an imageData object see createImageDataObject()
      // imageDataId1: { ... },
      // imageDataId2: { ... },
    },
  },

  /* eslint-disable no-prototype-builtins */
  getters: {

    [IMAGE_DATA_OBJECT_BY_HASH]: state => (hash) => {
      const imageDataIds = Object.keys(state.imageDataById);
      const imageDataId = imageDataIds.find(id => state.imageDataById[id].hash === hash);
      return state.imageDataById[imageDataId];
    },

    [IMAGE_DATA_URI_BY_IMAGE_DATA_ID]: state => (imageDataId) => {
      if (state.imageDataById.hasOwnProperty(imageDataId)) {
        return state.imageDataById[imageDataId].dataUri;
      }
      return null;
    },

    [IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID]: state => (id) => {
      if (state.imageDataById.hasOwnProperty(id)) {
        return state.imageDataById[id];
      }
      return null;
    },

    [SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID]: state => (id) => {
      if (
        state.imageDataById.hasOwnProperty(id)
        && state.imageDataById[id].segmentationMapPath
      ) {
        const segMapPathFromStore = state.imageDataById[id].segmentationMapPath;
        /* eslint-disable-next-line */
        const segMapPathParsed = segMapPathFromStore.split(/[\\\/]/).pop();
        const segMapLocalized = path.join(defineTempDir(), segMapPathParsed);
        return segMapLocalized;
      }
      return null;
    },

    [IMAGE_HAS_SEGMENTATION_MAP]: state => (id) => {
      if (
        state.imageDataById.hasOwnProperty(id)
        && state.imageDataById[id].segmentationMapPath
        && !state.imageDataById[id].hashDirty
      ) {
        return true;
      }
      return false;
    },

    // [COLORIZATION_SESSION_ID_OF_IMAGE_WITH_ID]: state => (id) => {
    //   if (state.imageDataById.hasOwnProperty(id)) {
    //     return state.imageDataById[id].colorizationSessionId;
    //   }
    // },
  },

  /* eslint-disable no-param-reassign */
  mutations: {

    [ADD_NEW_IMAGE_TO_IMAGE_STORE](state, imageDataObj) {
      Vue.set(state.imageDataById, imageDataObj.id, imageDataObj);
      // console.log(`Added new image to image store: ${imageDataObj.id}`);
    },

    [INCREMENT_IMAGE_DATA_USAGE](state, imageDataObj) {
      if (!imageDataObj) {
        throw new Error('Could not increment Image Data usage!');
      }
      imageDataObj.referenceCount += 1;
    },

    /* eslint-disable no-prototype-builtins */
    [INCREMENT_IMAGE_DATA_USAGE_BY_IMAGE_DATA_ID](state, imageDataId) {
      if (state.imageDataById.hasOwnProperty(imageDataId)) {
        state.imageDataById[imageDataId].referenceCount += 1;
      } else {
        throw new Error(`Could not incremenet image data usage counter. imageDataId: ${imageDataId}`);
      }
    },

    /* eslint-disable no-prototype-builtins */
    [SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID](
      state,
      { imageDataId, segmentationMapPath } = {},
    ) {
      if (state.imageDataById.hasOwnProperty(imageDataId)) {
        state.imageDataById[imageDataId].segmentationMapPath = segmentationMapPath;
      } else {
        throw new Error(`Could not set segmentation map for Image Data. imageDataId: ${imageDataId}, segmentationMapPath: ${segmentationMapPath}`);
      }
    },

    /* eslint-disable no-param-reassign */
    /* eslint-disable no-prototype-builtins */
    [REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID](state, imageDataId) {
      if (state.imageDataById.hasOwnProperty(imageDataId)) {
        if (state.imageDataById[imageDataId].referenceCount < 2) {
          // the image is only used once, therefore we can delete it
          // console.log('Image is used once only -> Deleting it.');
          // Vue.delete(state.imageDataById, imageDataId);
          // Instead of deleting the image, which caused problems with deduplication,
          // we delete the dataUri:
          state.imageDataById[imageDataId].dataUri = null;
          state.imageDataById[imageDataId].hash = null;
        } else {
          // the image is used multiple times (a.k.a. duplicate image),
          // se we just decrement the reference counter
          // console.log('Image is used multiple times -> Decrement counter.');
          state.imageDataById[imageDataId].referenceCount -= 1;
        }
      } else {
        console.warn(`Could not delete image object with ID ${imageDataId} because that ID does not exist.`);
      }
    },

    /* eslint-disable no-param-reassign */
    /* eslint-disable no-prototype-builtins */
    [REPLACE_IMAGE_DATA_URI](state, { imageDataId, dataUri }) {
      const hash = getHash(dataUri);
      if (state.imageDataById.hasOwnProperty(imageDataId)) {
        state.imageDataById[imageDataId].dataUri = dataUri;
        state.imageDataById[imageDataId].hash = hash;
        state.imageDataById[imageDataId].hashDirty = !hash;
        state.imageDataById[imageDataId].segmentationMapPath = null;
        // console.log('image replaced');
        return true;
      }
      // console.log('FAIL: Image Data Store:', state.imageDataById);
      throw new Error(`Could not replace image data URI for imageDataId: ${imageDataId}.`);
    },

    /* eslint-disable no-param-reassign */
    /* eslint-disable no-prototype-builtins */
    // Minimal rehydration mutation for the AssetStore facade: it restores
    // dataUri + hash for a record whose bytes were evicted from memory but
    // survive on the disk tier. Unlike REPLACE_IMAGE_DATA_URI it deliberately
    // does NOT null segmentationMapPath — the bytes coming back are identical
    // to what was analyzed, so a valid segmap path must survive rehydration.
    [HYDRATE_IMAGE_DATA_URI](state, { imageDataId, dataUri }) {
      const hash = getHash(dataUri);
      if (state.imageDataById.hasOwnProperty(imageDataId)) {
        state.imageDataById[imageDataId].dataUri = dataUri;
        state.imageDataById[imageDataId].hash = hash;
        state.imageDataById[imageDataId].hashDirty = !hash;
        return true;
      }
      throw new Error(`Could not hydrate image data URI for imageDataId: ${imageDataId}.`);
    },

  },

  actions: {

    /**
     * @param {Object} vuexParams
     * @param {Object} obj
     * @param {string} obj.dataUri - image as Data URI
     * @param {boolean} [obj.forceNew=false] - When true a new image
     *   object will be created, even if there is an image with the same hash
     */
    [STORE_IMAGE_IN_IMAGE_STORE](
      { getters, commit },
      { dataUri, forceNew = false },
    ) {
      const hash = getHash(dataUri);
      let imageDataObj = getters[IMAGE_DATA_OBJECT_BY_HASH](hash);
      if (imageDataObj && !forceNew) {
        commit(INCREMENT_IMAGE_DATA_USAGE, imageDataObj);
      } else {
        // console.log(dataUri);
        imageDataObj = createImageDataObject({ hash, dataUri });
        commit(ADD_NEW_IMAGE_TO_IMAGE_STORE, imageDataObj);
        console.log(imageDataObj);
      }
      // console.log(imageDataObj.id);
      return imageDataObj.id;
    },

    /**
     * @param {Object} vuexParams
     * @param {Object} obj
     * @param {string} obj.dataUri - image as Data URI
     * @param {boolean} [obj.forceNew=false] - When true a new image object
     *   will be created, even if there is an image with the same hash
     */
    [OVERWRITE_IMAGE_IN_IMAGE_STORE](
      { getters, commit },
      { dataUri, imageDataId },
    ) {
      const imageDataObj = getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](imageDataId);
      if (!imageDataObj) {
        // console.warn(`Could not overwrite image in image store: imageDataId ${imageDataId} not found!`);
        return null;
      }
      commit(REPLACE_IMAGE_DATA_URI, { imageDataId, dataUri });
      return imageDataObj.id;
    },

    /**
     * @param {Object} vuexParams
     * @param {Object} obj
     * @param {string} [obj.imageDataId] - image data ID to use / re-use.
     *   If null, new ID will be generated.
     */
    [STORE_BLANK_IMAGE_IN_IMAGE_STORE](
      { getters, commit },
      { imageDataId = shortid.generate() },
    ) {
      // console.log('imageDataId in store blank: ', imageDataId);
      let imageDataObj = getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](imageDataId);
      if (imageDataObj) {
        // console.log('image data exists: ', imageDataObj);
        commit(INCREMENT_IMAGE_DATA_USAGE, imageDataObj);
      } else {
        // console.log('image data does not exist: ', imageDataObj);
        imageDataObj = createBlankImageDataObject({ id: imageDataId });
        commit(ADD_NEW_IMAGE_TO_IMAGE_STORE, imageDataObj);
      }
      return imageDataObj.id;
    },

  },

};
