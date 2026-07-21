/**
 * Deterministic cache filenames for segmentation maps.
 *
 * The name encodes every parameter that affects the segmentation result, so an
 * identical request re-uses the file already on disk instead of re-segmenting.
 * Shared by COLORIZE (target + reference frames) and ANALYZE_CURRENT_FRAME —
 * keep this the single source of truth for the format so the three call sites
 * can never drift apart.
 *
 * Example:
 *   cadm_segMap_<hash>_line_threshold_auto_tbDilate_04_aiDilate_00_minSegSize_2.png
 *
 * Pure: no Electron, filesystem or DOM access.
 */

/* eslint-disable import/prefer-default-export */
export function buildSegMapFileName({
  hash,
  lineThreshold,
  isAutoAlpha,
  tbDilationSize,
  aiDilationSize,
  minSegSize,
}) {
  const tb = String(tbDilationSize).padStart(2, '0');
  const ai = String(aiDilationSize).padStart(2, '0');
  const threshold = isAutoAlpha ? 'auto' : lineThreshold;
  return [
    'cadm_segMap_', hash,
    '_line_threshold_', threshold,
    '_tbDilate_', tb,
    '_aiDilate_', ai,
    '_minSegSize_', minSegSize,
    '.png',
  ].join('');
}
