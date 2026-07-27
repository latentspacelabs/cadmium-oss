/* eslint-disable  */
import { modalColorize, modalPreprocess, MODAL_RESPONSES } from '@/util/server-client';

/* eslint-disable import/prefer-default-export */
export async function colorizeOnServer({
  projectId,
  references,
  targetLineDataUri,
  targetSegMapDataUri,
  returnUniqueColorIds,
} = {}) {
  // `references`: ordered list of { segMapUri, lineImageUri, colorsRgba }.
  const colorizeResponse = await modalColorize(
      projectId,
      targetSegMapDataUri,
      targetLineDataUri,
      references,
      returnUniqueColorIds,
  );
  console.log('RESULT FROM predict:', colorizeResponse);
  return colorizeResponse;
}

// preprocess
export async function raaOnServer({
  projectId,
  references,
  imgReturn,
  is_auto_alpha,
  line_threshold
} = {}) {
  // `references`: ordered list of { segMapUri, colorImageUri, lineImageUri }.
  let preprocessedResponse = await modalPreprocess(
    projectId,
    references,
    imgReturn,
    is_auto_alpha,
    line_threshold
  );

  console.log('RESULT FROM preprocess:', preprocessedResponse);
  
  if (!preprocessedResponse || 
      preprocessedResponse === MODAL_RESPONSES.CANCELED || 
      preprocessedResponse === MODAL_RESPONSES.NO_INTERNET || 
      preprocessedResponse === MODAL_RESPONSES.SERVER_ERROR) {
    return preprocessedResponse;
  }

  const response = {
    ref_palette_rgba: preprocessedResponse.palette_rgba,
    ref_preprocessed: preprocessedResponse.preprocessed_uri,
  }
  return response;
}