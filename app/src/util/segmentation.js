/* eslint-disable */
import { segmentationExecutablePath, cannyLineExecutablePath } from '@/binaries';
import { defineTempDir, base64EncodeInBrowser, getRawDataFromDataUri } from '@/util/file-util';
import { modalSegment, MODAL_RESPONSES } from '@/util/modal';
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
  // console.log('onlyAnalyze: ', onlyAnalyze);
  // TODO: Create checksum and only calculate segmentation map when necessary
  // Keep a map of all generated segmentation maps, then check if there already
  // is a segmentation map for the image. Maybe this should happend before calling
  // this function
  return new Promise(async (resolve, reject) => {
    const srcFileNameParts = srcFilename.split('_');
    const startTime = new Date().getTime();
    const segmentationMapFileName = `cadm_segMap_${srcFileNameParts[srcFileNameParts.length - 1]}`;
    // const segmentationMapFileName = `${startTime}_${srcFilename}`;
    // console.log('segmentationMapFileName: ', segmentationMapFileName);

    const segmentationMapPath = path.join(defineTempDir(), segmentationMapFileName);
    /* eslint-disable-next-line */
    const segmentationMapPathWithQuotes = '--outfile="' + segmentationMapPath + '"';
    // console.log('segmentationMapPathWithQuotes: ', segmentationMapPathWithQuotes);
    /* eslint-disable-next-line */
    const srcPathWithQuotes = '"' + srcPath + '"';
    // console.log('srcPathWithQuotes: ', srcPathWithQuotes);
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
    // NOTE: this variable is only used to store image in tempt dir ^,
    // it does not get sent to segmentationExec because this would be redundant
    // add quotes:
    // segmentationMapPathDescriptive = '"' + segmentationMapPathDescriptive + '"';
    // segmentationMapPathDescriptiveColor = '"' + segmentationMapPathDescriptiveColor + '"';

    // const dilateWidthArg = '--dilate_width '.concat(dilationSize);
    // const minSegSizeArg = '--min_seg_size '.concat(minSegSize);
    // console.log(dilateWidthArg);
    /* eslint-disable-next-line */
    // const segmentationArgs = [srcPathWithQuotes, segmentationMapPathWithQuotes, dilateWidthArg, minSegSizeArg, '--colorize_segmaps'];
    // console.log('segmentationArgs: ', segmentationArgs);
    /* eslint-disable-next-line */
    // const segmentationArgs = [srcPath, '--outfile', segmentationMapPath]; <<< CHANGED TO INCLUDE COLOR OUTPUT

    // if (onlyAnalyze) {
    // segmentationArgs.push('--colorize_segmaps');
    // }
    // console.log('segmap from seg: ', segmentationMapPathDescriptive);

    // read file data from srcPath, convert to data URI, pass to modalSegment, resolve
    const line_image_uri = fs.readFileSync(srcPath, { encoding: 'base64' });
    // console.log ('FILE DATA:',line_image_uri);
    // console.log('LINE THRESHOLD FROM UI', line_threshold)
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
      // console.log('THIS FRAME HAS', modalSegmented.num_segments, 'SEGMENTS');
    }
    // console.log('WROTE BOTH FILES');
    const processingTimeInSec = (new Date().getTime() - startTime) / 1000;
    // console.log("RESULT FROM SEGGER", canceled);
    resolve({
      path: segmentationMapPathDescriptive,
      processingTimeInSec,
      numSegments,
      canceled,
    });
  });
}

export async function generateCannyLine(colorPath, outPath, projectId) {
  // console.log('RUNNING CANNY LINE', colorPath.colorPath);
  try {
    // load local image file with jimp. It supports jpg, png, bmp, tiff and gif:
    //var jimpSrc = await Jimp.default.read(colorPath);
    const colorSource = fs.readFileSync(colorPath.colorPath, { encoding: 'base64' });
    const mimeType = getMimeTypeForFileExtension(getFileExtension(colorPath.colorPath));
    const dataUri = getDataUriFromBase64(colorSource, mimeType);
    const { width, height } = await getImageDimensions(dataUri);
    const { canvas, ctx } = createCanvas({ width, height });
    const colorImgCanny = await loadImage(dataUri);
    ctx.drawImage(colorImgCanny, 0, 0);
    const colorSourceImageData = await ctx.getImageData(0, 0, width, height);
    // console.log('created canny canvas', colorSourceImageData);
    // `jimpImage.bitmap` property has the decoded ImageData that we can use to create a cv:Mat
    var src = cv.matFromImageData(colorSourceImageData);
    // console.log('CV MAT FROM IMAGE', src);
    let edges = new cv.Mat();
    // cv.cvtColor(src, src, cv.COLOR_RGBA2RGB, 0);
    cv.Canny(
      src,
      edges,
      50,
      100,
      3,
      false,
    );
    let dilation = new cv.Mat();
    let M = cv.Mat.ones(2, 2, cv.CV_8U);
    let anchor = new cv.Point(-1, -1);
    cv.dilate(
      edges,
      dilation,
      M,
      anchor,
      2,
      cv.BORDER_CONSTANT,
      cv.morphologyDefaultBorderValue()
    );

    // Set only R, G, and B channels to black

    let blackChannels = new cv.Mat()
    dilation.copyTo(blackChannels);
    blackChannels.setTo(new cv.Scalar(0, 0, 0, 255));

    let vector = new cv.MatVector();
    vector.push_back(blackChannels); // r
    vector.push_back(blackChannels); // g
    vector.push_back(blackChannels); // b
    vector.push_back(dilation); // a
    // cv.cvtColor(dilation, dilation, cv.COLOR_GRAY2BGRA, 0);
    cv.merge(vector, dilation);

    // Now that we are finish, we want to write `dst` to file `output.png`. For this we create a `Jimp`
    // image which accepts the image data as a [`Buffer`](https://nodejs.org/docs/latest-v10.x/api/buffer.html).
    // `write('output.png')` will write it to disk and Jimp infers the output format from given file name:
    cv.imshow(canvas, dilation);
    const cannyDataURI = canvas.toDataURL();
    // console.log('CANNY RETURN DATA URI', cannyDataURI);
    const cannyRawImageData = getRawDataFromDataUri(cannyDataURI);
    let cannyBuffer = Buffer.from(cannyRawImageData, 'base64');
    let cannyOutputPath = path.join(defineTempDir(), colorPath.outPath);
    console.log('CANNY BUFFER PROCESSING DONE', cannyOutputPath, cannyBuffer);
    fs.writeFileSync(cannyOutputPath, cannyBuffer);

    src.delete();
    dilation.delete();
    edges.delete();
    return cannyDataURI;
  } catch (err) {
    console.log(err);
  }
}
