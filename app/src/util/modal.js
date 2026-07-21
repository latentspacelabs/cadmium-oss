/* eslint-disable  */
import axios from 'axios';
import { encode } from 'url-safe-base64';
import { AbortController } from "node-abort-controller";
import { Agent } from 'https';

import { i18n } from './i18nVue';
import ISRGCAs from '@/util/rootCert';
import showCustomDialog from '@/util/customDialog';
import { logError } from '@/util/error-util';
import {
  getColorizeUrl, getSegmentUrl, getPreprocessUrl, getServerBackend, BACKEND_EMBEDDED,
} from '@/util/server-config';
import { getLastSidecarStatus } from '@/util/sidecar-status';
import { ConnectivityChecker } from '@/util/connectivity-checker';

const agent = new Agent({ca: ISRGCAs});

let controller;

// Modal response constants
export const MODAL_RESPONSES = {
  CANCELED: 'canceled',           // User manually cancelled operation
  NO_INTERNET: 'no_internet',     // Network connectivity issue
  SERVER_ERROR: 'server_error',   // Server returned an error response
};

async function showErrorOnce(action, errorMessage) {
  const detail = i18n.__('Please try again or file an issue at https://github.com/latentspacelabs/cadmium-oss/issues');

  // errorMessage can be one of:
  //  - Insufficient credits. Please upgrade your license.
  //  - License is not active

  await showCustomDialog({
    title: errorMessage,
    message: i18n.__('Error occured while %s', i18n.__(action)),
    detail: detail,
    buttons: [i18n.__('OK')],
    defaultId: 0,
    cancelId: 0,
    type: 'error'
  });
}

async function showNoInternetError(action) {
  const title = i18n.__('No Internet Connection');
  const message = i18n.__('Unable to %s without an internet connection', i18n.__(action));
  const detail = i18n.__('Please check your network connection and try again.');

  await showCustomDialog({
    title: title,
    message: message,
    detail: detail,
    buttons: [i18n.__('OK')],
    defaultId: 0,
    cancelId: 0,
    type: 'error'
  });
}

async function showEmbeddedFailedError(action) {
  // The sidecar supervisor's last words (pushed over sidecar:status into the
  // renderer cache): missing binary/models, crash loop, health timeout, …
  const status = getLastSidecarStatus();
  const reason = (status && status.lastError)
    || i18n.__('The local processing engine is not responding.');
  const hint = i18n.__('Open the server settings to see details, retry, or switch to a hosted server.');

  await showCustomDialog({
    title: i18n.__('Local Processing Unavailable'),
    message: i18n.__('Unable to %s — the embedded backend is not running', i18n.__(action)),
    detail: `${reason}\n\n${hint}`,
    buttons: [i18n.__('OK')],
    defaultId: 0,
    cancelId: 0,
    type: 'error'
  });
}

// The backend didn't answer (preflight said unreachable, or the request died
// with no HTTP response). For the embedded backend "no internet" is wrong and
// actively misleading — surface the sidecar's failure instead.
async function showBackendUnreachableError(action) {
  if (getServerBackend().kind === BACKEND_EMBEDDED) {
    await showEmbeddedFailedError(action);
  } else {
    await showNoInternetError(action);
  }
}


export async function modalColorize(
  projectId,
  targetSegMapDataUri,
  targetLineDataUri,
  references,
  returnUniqueColorIds
) {
  // Check connectivity before making network request
  const isConnected = await ConnectivityChecker.checkOnce();
  if (!isConnected) {
    console.log('No internet connection detected for colorize operation');
    await showBackendUnreachableError('colorizing');
    return MODAL_RESPONSES.NO_INTERNET;
  }

  // `references` is an ordered list of reference frames — one today, the seam
  // for two-reference colorization. Each entry: { segMapUri, lineImageUri,
  // colorsRgba } (raw base64, decoded server-side with is_url_safe=false).
  const body = JSON.stringify({
    project_id: projectId,
    target_seg_map_uri: targetSegMapDataUri,
    target_line_image_uri: targetLineDataUri,
    references: references.map(r => ({
      seg_map_uri: r.segMapUri,
      line_image_uri: r.lineImageUri,
      colors_rgba: r.colorsRgba,
    })),
    unique_color_ids: returnUniqueColorIds,
  });

  controller = new AbortController();
  const colorizeUrl = getColorizeUrl();
  const res = await axios.post(colorizeUrl, body, {
    headers: {
      'Content-Type': 'application/json'
    },
    httpsAgent:agent,
    signal: controller.signal,
  }).catch(async function (error) {
    console.log('ERROR FROM MODAL COLORIZE:', error);
    
    // Check if operation was cancelled
    if (error.name === 'AbortError' || 
        error.message.includes('aborted') || 
        error.message.includes('canceled') ||
        error.code === 'ERR_CANCELED' ||
        error.message.includes('Request aborted')) {
      console.log('Colorize operation was cancelled by user');
      return MODAL_RESPONSES.CANCELED;
    }
    
    // Check if error is network-related vs server error
    if (!error.response) {
      console.log('Network error detected during colorize operation');
      await showBackendUnreachableError('colorizing');
      return MODAL_RESPONSES.NO_INTERNET;
    } else {
      const errorMessage = error.response.status === 403 ? error.response.data.error : 'An unknown error occurred';
      logError(error, 'Unknown modal error during colorization');
      await showErrorOnce('colorizing', errorMessage);
      return MODAL_RESPONSES.SERVER_ERROR;
    }
  });
  return (res === MODAL_RESPONSES.CANCELED || res === MODAL_RESPONSES.NO_INTERNET || res === MODAL_RESPONSES.SERVER_ERROR) ? res : res.data;
}


export async function modalPreprocess(
  projectId,
  references,
  imgReturn,
  is_auto_alpha,
  line_threshold
) {
  // Check connectivity before making network request
  const isConnected = await ConnectivityChecker.checkOnce();
  if (!isConnected) {
    console.log('No internet connection detected for preprocess operation');
    await showBackendUnreachableError('preprocessing');
    return MODAL_RESPONSES.NO_INTERNET;
  }

  const alphaParams = autoThreshold(is_auto_alpha, line_threshold);
  // `references` is an ordered list (one entry today, the two-reference seam).
  // Each entry: { segMapUri, colorImageUri, lineImageUri }. The seg map and
  // color image are url-safe base64 (server decodes with is_url_safe=true); the
  // line image is forwarded as-is, matching the prior contract.
  const encodedRefs = references.map(r => ({
    seg_map_uri: encode(r.segMapUri),
    color_image_uri: encode(r.colorImageUri),
    line_image_uri: r.lineImageUri,
  }));
  const body = JSON.stringify({
    project_id: projectId,
    references: encodedRefs,
    return_filled: imgReturn,
    line_threshold_params: alphaParams
  });
  controller = new AbortController();
  const res = await axios.post(getPreprocessUrl(), body, {
    headers: {
      'Content-Type': 'application/json'
    },
    httpsAgent:agent,
    signal: controller.signal,
  }).catch(async function (error) {
    console.log("RAW ERROR FROM MODAL PREPROCESS: ", error);
    
    // Check if operation was cancelled
    if (error.name === 'AbortError' || 
        error.message.includes('aborted') || 
        error.message.includes('canceled') ||
        error.code === 'ERR_CANCELED' ||
        error.message.includes('Request aborted')) {
      console.log('Preprocess operation was cancelled by user');
      return MODAL_RESPONSES.CANCELED;
    }
    
    // Check if error is network-related vs server error
    if (!error.response) {
      console.log('Network error detected during preprocess operation');
      await showBackendUnreachableError('preprocessing');
      return MODAL_RESPONSES.NO_INTERNET;
    } else {
      console.log("RAW ERROR FROM MODAL PREPROCESS: ", error.response.data.error);
      const errorMessage = error.response.status === 403 ? error.response.data.error : 'An unknown error occurred';
      logError(error, 'Unknown modal error during preprocessing');
      await showErrorOnce('preprocessing', errorMessage);
      return MODAL_RESPONSES.SERVER_ERROR;
    }
  });
  return (res === MODAL_RESPONSES.CANCELED || res === MODAL_RESPONSES.NO_INTERNET || res === MODAL_RESPONSES.SERVER_ERROR) ? res : res.data;
}

export async function modalSegment(
  projectId,
  line_image_uri,
  line_threshold,
  imageId,
  is_auto_alpha,
  return_colorized,
  return_unmerged,
  tb_sizes,
  minSegSize,
  gap_closer_strength
) {
  // Check connectivity before making network request
  const isConnected = await ConnectivityChecker.checkOnce();
  if (!isConnected) {
    console.log('No internet connection detected for segment operation');
    await showBackendUnreachableError('analyzing');
    return MODAL_RESPONSES.NO_INTERNET;
  }

  const alphaParams = autoThreshold(is_auto_alpha, line_threshold);
  const body = JSON.stringify({
    project_id: projectId,
    image_id: imageId,
    line_image_uri: line_image_uri,
    line_threshold_params: alphaParams,
    return_colorized: return_colorized,
    return_unmerged: return_unmerged,
    tb_sizes: tb_sizes,
    min_seg_size: minSegSize,
    gap_closer_strength: gap_closer_strength
  });
  controller = new AbortController();
  const res = await axios.post(getSegmentUrl(), body, {
    headers: {
      'Content-Type': 'application/json'
    },
    httpsAgent:agent,
    signal: controller.signal,
  }).catch(async function (error) {
    console.log('ERROR FROM MODAL SEGMENT:', error);
    
    // Check if operation was cancelled
    if (error.name === 'AbortError' || 
        error.message.includes('aborted') || 
        error.message.includes('canceled') ||
        error.code === 'ERR_CANCELED' ||
        error.message.includes('Request aborted')) {
      console.log('Segment operation was cancelled by user');
      return MODAL_RESPONSES.CANCELED;
    }
    
    // Check if error is network-related vs server error
    if (!error.response) {
      console.log('Network error detected during segment operation');
      await showBackendUnreachableError('analyzing');
      return MODAL_RESPONSES.NO_INTERNET;
    } else {
      console.log('ERROR FROM MODAL SEGMENT:', error.response.data.error);
      const errorMessage = error.response.status === 403 ? error.response.data.error : 'An unknown error occurred';
      logError(error, 'Unknown modal error during segmentation');
      await showErrorOnce('analyzing', errorMessage);
      return MODAL_RESPONSES.SERVER_ERROR;
    }
  });
  return (res === MODAL_RESPONSES.CANCELED || res === MODAL_RESPONSES.NO_INTERNET || res === MODAL_RESPONSES.SERVER_ERROR) ? res : res.data;
}

export function cancelModal() {
  controller.abort()
}

function autoThreshold(auto, line_thresh) {
  let alphaParams;
  if (auto) {
    alphaParams = { "type": "adaptive_mean" };
  } else {
    alphaParams = { "type": "manual", "threshold": line_thresh };
  }
  return alphaParams;
}
