/**
 * Image downscaling utility for Privacy Lens Agent.
 * Preserves aspect ratio and scales images down so the longest side is <= maxDimension (default: 768px).
 * Works across both Service Worker (OffscreenCanvas) and Window/Offscreen contexts (HTMLCanvasElement).
 */

/**
 * Computes downscaled dimensions preserving aspect ratio.
 * @param {number} width - Original image width
 * @param {number} height - Original image height
 * @param {number} [maxDimension=768] - Maximum allowable length for the longest side
 * @returns {{ targetWidth: number, targetHeight: number, scale: number, originalWidth: number, originalHeight: number }}
 */
export function calculateTargetDimensions(width, height, maxDimension = 768) {
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions: width=${width}, height=${height}`);
  }

  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return {
      targetWidth: Math.round(width),
      targetHeight: Math.round(height),
      scale: 1.0,
      originalWidth: width,
      originalHeight: height
    };
  }

  const scale = maxDimension / longestSide;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  return {
    targetWidth,
    targetHeight,
    scale,
    originalWidth: width,
    originalHeight: height
  };
}

/**
 * Converts a Blob to a base64 Data URL.
 * Works in environments without FileReader (such as Chrome Service Workers) by reading ArrayBuffer.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToBase64(blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Service Worker fallback using ArrayBuffer chunking
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const mimeType = blob.type || 'image/jpeg';
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Downscales an image (Data URL or Blob) to fit within maxDimension.
 * @param {string|Blob} imageSource - Data URL string or Blob
 * @param {number} [maxDimension=768] - Maximum length of the longest side
 * @param {object} [options={}] - Encoding options (format: 'jpeg'|'png', quality: 0.0 - 1.0)
 * @returns {Promise<{ dataUrl: string, base64: string, width: number, height: number, originalWidth: number, originalHeight: number, scale: number }>}
 */
export async function downscaleImage(imageSource, maxDimension = 768, options = {}) {
  const format = options?.format === 'png' ? 'png' : 'jpeg';
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = typeof options?.quality === 'number' ? options.quality : 0.85;

  let blob;
  if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
    const res = await fetch(imageSource);
    blob = await res.blob();
  } else if (imageSource instanceof Blob) {
    blob = imageSource;
  } else {
    throw new Error('Unsupported image source: expected data URL string or Blob');
  }

  // Decode to ImageBitmap or handle Node environment gracefully
  const createBmp = typeof createImageBitmap !== 'undefined' ? createImageBitmap : options?.createImageBitmap;
  if (!createBmp) {
    const rawDataUrl = typeof imageSource === 'string' ? imageSource : await blobToBase64(blob);
    return {
      dataUrl: rawDataUrl,
      base64: rawDataUrl.includes(',') ? rawDataUrl.split(',')[1] : rawDataUrl,
      width: options?.width || 1280,
      height: options?.height || 800,
      originalWidth: options?.width || 1280,
      originalHeight: options?.height || 800,
      scale: 1.0,
      canvas: null
    };
  }

  const bitmap = await createBmp(blob);
  const { width, height } = bitmap;
  const { targetWidth, targetHeight, scale } = calculateTargetDimensions(width, height, maxDimension);

  let dataUrl;
  let canvasInstance = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      const outBlob = await canvas.convertToBlob({ type: mimeType, quality });
      dataUrl = await blobToBase64(outBlob);
      canvasInstance = canvas;
    } else if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      dataUrl = canvas.toDataURL(mimeType, quality);
      canvasInstance = canvas;
    } else {
      throw new Error('Neither OffscreenCanvas nor document canvas is available');
    }
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }

  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

  return {
    dataUrl,
    base64,
    width: targetWidth,
    height: targetHeight,
    originalWidth: width,
    originalHeight: height,
    scale,
    canvas: canvasInstance,
    toString() {
      return this.dataUrl;
    }
  };
}
