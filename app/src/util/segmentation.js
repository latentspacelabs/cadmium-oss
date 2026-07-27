/* eslint-disable */
import { segmentationExecutablePath, cannyLineExecutablePath } from '@/binaries';
import { defineTempDir, base64EncodeInBrowser, getRawDataFromDataUri } from '@/util/file-util';
import { modalSegment, MODAL_RESPONSES } from '@/util/server-client';
import cv from '@techstark/opencv-js';

import {
  getImageDimensions,
  loadImage,
} from '@/util/image-util';

import {
  getMimeTypeForFileExtension,
  getFileExtension,
  getDataUriFromBase64,
} from '@/util/file-util';

import {
  createCanvas,
} from '@/util/canvas-util';
import { addTempFile } from '@/platform';

const fs = require('fs');

/* eslint-disable import/no-extraneous-dependencies */
const path = require('path');
const spawn = require('await-spawn');

/* eslint-disable import/prefer-default-export */
export async function generateSegmentationMap({ projectId, srcFilename, srcPath, imageId, aiDilationSize, tbDilationSize, line_threshold, is_auto_alpha, minSegSize, canvSize }) {
  // Caching lives at the callers, which is the right place: both
  // ANALYZE_CURRENT_FRAME (store/actions.js) and ensureSegMap
  // (services/colorize-run.js) build a content-addressed filename from the image
  // hash + every analyze param (buildSegMapFileName) and skip this call entirely
  // when that file already exists. So this only runs when the result would
  // differ — no unconditional recompute.
  //
  // NOTE: plain async body on purpose — a throw here (e.g. the srcPath read
  // failing) must reject so callers get an error dialog. This used to be a
  // `new Promise(async ...)` wrapper, which turned any throw into a promise
  // that never settles and left the analyze overlay up forever.
  const srcFileNameParts = srcFilename.split('_');
  const startTime = new Date().getTime();
  const segmentationMapFileName = `cadm_segMap_${srcFileNameParts[srcFileNameParts.length - 1]}`;

  let tbDilationSizeFormatted;
  let aiDilationSizeFormatted;
  let canceled = false;

  // add zero to dilation under 10 like 01, 02...etc
  if (tbDilationSize < 10) {
    const zero = '0';
    tbDilationSizeFormatted = zero.concat(tbDilationSize);
  } else {
    tbDilationSizeFormatted = tbDilationSize;
  }
  if (aiDilationSize < 10) {
    const zero = '0';
    aiDilationSizeFormatted = zero.concat(aiDilationSize);
  } else {
    aiDilationSizeFormatted = aiDilationSize;
  }
  // add dilation and color tags to file names:
  const segFileNameParts = segmentationMapFileName.split('.');
  let segmentationMapFileNameDescriptive;
  let segmentationMapFileNameColorDescriptive;
  if (is_auto_alpha) {
    /* eslint-disable-next-line */
    segmentationMapFileNameDescriptive = segFileNameParts[0].concat('_line_threshold_', 'auto', '_tbDilate_', tbDilationSizeFormatted, '_aiDilate_', aiDilationSizeFormatted, '_minSegSize_', minSegSize, '.', segFileNameParts[1]);
    /* eslint-disable-next-line */
    segmentationMapFileNameColorDescriptive = segFileNameParts[0].concat('_line_threshold_', 'auto', '_tbDilate_', tbDilationSizeFormatted, '_aiDilate_', aiDilationSizeFormatted, '_minSegSize_', minSegSize, '_color_seg.', segFileNameParts[1]);
  } else {
    /* eslint-disable-next-line */
    segmentationMapFileNameDescriptive = segFileNameParts[0].concat('_line_threshold_', line_threshold, '_tbDilate_', tbDilationSizeFormatted, '_aiDilate_', aiDilationSizeFormatted, '_minSegSize_', minSegSize, '.', segFileNameParts[1]);
    /* eslint-disable-next-line */
    segmentationMapFileNameColorDescriptive = segFileNameParts[0].concat('_line_threshold_', line_threshold, '_tbDilate_', tbDilationSizeFormatted, '_aiDilate_', aiDilationSizeFormatted, '_minSegSize_', minSegSize, '_color_seg.', segFileNameParts[1]);
  }
  /* eslint-disable-next-line */
  let segmentationMapPathDescriptive = path.join(defineTempDir(), segmentationMapFileNameDescriptive);
  /* eslint-disable-next-line */
  let segmentationMapPathDescriptiveColor = path.join(defineTempDir(), segmentationMapFileNameColorDescriptive);

  // read file data from srcPath, convert to data URI, pass to modalSegment
  const line_image_uri = fs.readFileSync(srcPath, { encoding: 'base64' });
  let return_colorized = true;
  let return_unmerged = false;
  let big_ball = tbDilationSize;
  let med_ball = tbDilationSize - 1;
  if (med_ball < 0) {
    med_ball = 0;
  }
  let sml_ball = med_ball - 1;
  if (sml_ball < 0) {
    sml_ball = 0;
  }
  let tb_sizes = [big_ball, med_ball, sml_ball];
  aiDilationSize = (aiDilationSize / 10);
  let modalSegmented = await modalSegment(projectId, line_image_uri, line_threshold, imageId, is_auto_alpha, return_colorized, return_unmerged, tb_sizes, minSegSize, aiDilationSize);

  // update the usage counter
  if (modalSegmented === MODAL_RESPONSES.CANCELED ||
      modalSegmented === MODAL_RESPONSES.NO_INTERNET ||
      modalSegmented === MODAL_RESPONSES.SERVER_ERROR) {
    canceled = true;
  } else if (modalSegmented.num_segments < 255) {
    // OSS: no licensing/usage reporting (server returns no `license` field).
    const segRawImageData = getRawDataFromDataUri(modalSegmented.seg_map_uri);
    let segBuffer = Buffer.from(segRawImageData, 'base64');
    fs.writeFileSync(segmentationMapPathDescriptive, segBuffer);
    if (modalSegmented.colorized_seg_map_uri && modalSegmented.num_segments < 255) {
      const segRawImageDataColor = getRawDataFromDataUri(modalSegmented.colorized_seg_map_uri);
      let segBufferColor = Buffer.from(segRawImageDataColor, 'base64');
      fs.writeFileSync(segmentationMapPathDescriptiveColor, segBufferColor);
      // add paths to temp dir
      addTempFile(segmentationMapPathDescriptive);
      addTempFile(segmentationMapPathDescriptiveColor);
    }
  }
  let numSegments;
  if (modalSegmented.num_segments) {
    numSegments = modalSegmented.num_segments;
  }
  const processingTimeInSec = (new Date().getTime() - startTime) / 1000;
  return {
    path: segmentationMapPathDescriptive,
    processingTimeInSec,
    numSegments,
    canceled,
  };
}

export async function generateCannyLine({ colorPath, colorDataUri, outPath }) {
  // Prefer the in-memory data URI: imported Files carry no `.path` on
  // Electron ≥32, so the color-import analyze path passes the frame's data
  // URI straight from the image store. Reading `colorPath` from disk is the
  // fallback for callers that only have a path. Throws on failure — quietly
  // returning undefined here used to strand the caller waiting on a canny
  // temp file that never materializes.
  let dataUri = colorDataUri;
  if (!dataUri) {
    if (!colorPath) {
      throw new Error('generateCannyLine: no color image source (need colorDataUri or colorPath)');
    }
    const colorSource = fs.readFileSync(colorPath, { encoding: 'base64' });
    const mimeType = getMimeTypeForFileExtension(getFileExtension(colorPath));
    dataUri = getDataUriFromBase64(colorSource, mimeType);
  }
  const { width, height } = await getImageDimensions(dataUri);
  const { canvas, ctx } = createCanvas({ width, height });
  const colorImgCanny = await loadImage(dataUri);
  ctx.drawImage(colorImgCanny, 0, 0);
  const colorSourceImageData = await ctx.getImageData(0, 0, width, height);
  const src = cv.matFromImageData(colorSourceImageData);
  const edges = new cv.Mat();
  const dilation = new cv.Mat();
  const blackChannels = new cv.Mat();
  const M = cv.Mat.ones(2, 2, cv.CV_8U);
  const vector = new cv.MatVector();
  try {
    cv.Canny(
      src,
      edges,
      50,
      100,
      3,
      false,
    );
    const anchor = new cv.Point(-1, -1);
    cv.dilate(
      edges,
      dilation,
      M,
      anchor,
      2,
      cv.BORDER_CONSTANT,
      cv.morphologyDefaultBorderValue()
    );

    // Set only R, G, and B channels to black; edges become the alpha plane.
    dilation.copyTo(blackChannels);
    blackChannels.setTo(new cv.Scalar(0, 0, 0, 255));
    vector.push_back(blackChannels); // r
    vector.push_back(blackChannels); // g
    vector.push_back(blackChannels); // b
    vector.push_back(dilation); // a
    cv.merge(vector, dilation);
    cv.imshow(canvas, dilation);
  } finally {
    src.delete();
    edges.delete();
    dilation.delete();
    blackChannels.delete();
    M.delete();
    vector.delete();
  }
  const cannyDataURI = canvas.toDataURL();
  const cannyRawImageData = getRawDataFromDataUri(cannyDataURI);
  const cannyBuffer = Buffer.from(cannyRawImageData, 'base64');
  const cannyOutputPath = path.join(defineTempDir(), outPath);
  fs.writeFileSync(cannyOutputPath, cannyBuffer);
  return cannyDataURI;
}
