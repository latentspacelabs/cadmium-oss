/* eslint-disable linebreak-style */
/* eslint-disable */

// Simple in-memory decoded image cache to reduce jank during playback
const decodedImageCache = new Map(); // key: src, value: HTMLImageElement
const cacheOrder = []; // simple FIFO order tracking
const MAX_CACHE_SIZE = 200;

function addToCache(src, img) {
  if (decodedImageCache.has(src)) { return; }
  decodedImageCache.set(src, img);
  cacheOrder.push(src);
  if (cacheOrder.length > MAX_CACHE_SIZE) {
    const evictSrc = cacheOrder.shift();
    decodedImageCache.delete(evictSrc);
  }
}

export function preloadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) { resolve(null); return; }
    const cached = decodedImageCache.get(src);
    if (cached && cached.complete) { resolve(cached); return; }
    const img = new Image();
    img.onload = () => { addToCache(src, img); resolve(img); };
    img.onerror = (err) => { resolve(null); };
    img.src = src;
  });
}

export function preloadImages(sources = []) {
  const unique = Array.from(new Set(sources.filter(Boolean)));
  return Promise.all(unique.map(preloadImage));
}

export function getFromCache(src) {
  return decodedImageCache.get(src) || null;
}


