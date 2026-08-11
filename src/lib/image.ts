"use client";

/**
 * Turning a phone photo into something a duka can actually carry.
 *
 * This file exists because of one number: a photo straight off an Android
 * camera is 3–5 MB. Two hundred of those is roughly 800 MB, which will not fit
 * in IndexedDB, will never finish syncing on 2G, and would turn the one screen
 * that must work with no signal into the one screen that does not.
 *
 * Compressed to a 256px square in WebP, the same photo is 10–20 KB. Two hundred
 * is about 3 MB — a rounding error for IndexedDB and a few seconds on a slow
 * connection. Everything here serves that reduction, and it happens on the
 * device BEFORE the image is stored, so an oversized file never exists in the
 * app at all.
 */

/** Square, because the tile is square and cropping later would be lossy twice. */
export const IMAGE_SIZE = 256;

/**
 * Hard ceiling, enforced again in the database.
 *
 * 200 KB is roughly ten times what a good WebP thumbnail needs, so it never
 * fires for a healthy encode. It exists for the unhealthy one: a browser
 * without WebP support silently falls back to PNG, which for a photograph can
 * be an order of magnitude larger. Without a ceiling the first shop on an old
 * handset would quietly fill their own database, and nobody would find out
 * until sync started failing.
 */
export const MAX_IMAGE_BYTES = 200_000;

export interface PreparedImage {
  /** A `data:image/webp;base64,...` URL, ready to store and to render. */
  data: string;
  width: number;
  height: number;
  bytes: number;
}

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap handles EXIF orientation on modern Android Chrome, which
  // matters: a photo taken in portrait renders on its side without it, and the
  // owner blames the app rather than the camera.
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" }).catch(() =>
      loadViaElement(file),
    );
  }
  return loadViaElement(file);
}

function loadViaElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image"));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read the compressed image"));
    r.readAsDataURL(blob);
  });
}

/**
 * Compress a captured photo down to a storable thumbnail.
 *
 * Centre-cropped to a square rather than squashed: a stretched packet of unga
 * is harder to recognise than a cropped one, and recognition is the entire
 * point of the feature.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file is not an image");
  }

  const bitmap = await loadBitmap(file);
  const sw = "width" in bitmap ? bitmap.width : 0;
  const sh = "height" in bitmap ? bitmap.height : 0;
  if (!sw || !sh) throw new Error("That image appears to be empty");

  // Centre square crop from the source, then scale once into the canvas.
  const side = Math.min(sw, sh);
  const sx = Math.round((sw - side) / 2);
  const sy = Math.round((sh - side) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process images");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap as CanvasImageSource, sx, sy, side, side, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  // Step the quality down until it fits. WebP at 0.72 is already well inside
  // the ceiling for a photograph; the lower rungs are for the JPEG/PNG
  // fallback path on a browser that cannot encode WebP.
  const attempts: Array<[string, number]> = [
    ["image/webp", 0.72],
    ["image/webp", 0.55],
    ["image/jpeg", 0.7],
    ["image/jpeg", 0.5],
  ];

  for (const [type, quality] of attempts) {
    const blob = await toBlob(canvas, type, quality);
    // A browser that cannot encode the requested type hands back the canvas
    // default (PNG) with a different mime — detected here rather than trusted.
    if (!blob || blob.type !== type) continue;
    if (blob.size > MAX_IMAGE_BYTES) continue;
    return {
      data: await readAsDataUrl(blob),
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      bytes: blob.size,
    };
  }

  // Last resort: whatever the canvas will give us, but still refused if it
  // breaches the ceiling. Better a clear message than a database nobody can sync.
  const fallback = await toBlob(canvas, "image/jpeg", 0.4);
  if (!fallback || fallback.size > MAX_IMAGE_BYTES) {
    throw new Error("That photo could not be made small enough. Try taking it again.");
  }
  return {
    data: await readAsDataUrl(fallback),
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    bytes: fallback.size,
  };
}

/** Human size, for telling the owner what a photo actually costs them. */
export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.round(n / 102.4) / 10} KB`;
}
