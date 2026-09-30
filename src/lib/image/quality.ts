"use client";

/**
 * Lightweight, free, in-browser evidence-quality signal.
 *
 * This is NOT computer vision. It measures resolution, mean luminance,
 * clipping and a Laplacian-style edge-energy proxy for blur, and reports
 * flags. Flags downgrade evidence sufficiency; they never fail a shipment.
 */

export interface ImageQuality {
  width: number;
  height: number;
  score: number;
  flags: string[];
  meanLuminance: number;
  edgeEnergy: number;
}

export const QUALITY_FLAG_LABELS: Record<string, string> = {
  low_resolution: "Very low resolution",
  blurred: "Looks blurred or out of focus",
  too_dark: "Under-exposed",
  overexposed: "Over-exposed",
  empty_frame: "Frame looks empty or featureless",
};

/** Resize to a max edge while preserving quality, and return a JPEG blob. */
export async function prepareImage(file: File, maxEdge = 1600, quality = 0.85): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
  );
  if (!blob) throw new Error("Could not process the image in this browser.");
  return { blob, width, height };
}

export async function assessQuality(blob: Blob): Promise<ImageQuality> {
  const bitmap = await createImageBitmap(blob);
  const sample = 256;
  const canvas = document.createElement("canvas");
  canvas.width = sample;
  canvas.height = sample;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.drawImage(bitmap, 0, 0, sample, sample);
  const { data } = ctx.getImageData(0, 0, sample, sample);

  const lum = new Float32Array(sample * sample);
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < sample * sample; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = l;
    sum += l;
    if (l < 16) dark++;
    if (l > 242) bright++;
  }
  const mean = sum / (sample * sample);

  // Edge energy: mean absolute Laplacian. Low values indicate blur or an
  // empty frame; it does not distinguish between the two on its own.
  let edge = 0;
  for (let y = 1; y < sample - 1; y++) {
    for (let x = 1; x < sample - 1; x++) {
      const i = y * sample + x;
      const v = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - sample] - lum[i + sample];
      edge += Math.abs(v);
    }
  }
  edge /= (sample - 2) * (sample - 2);

  const flags: string[] = [];
  if (bitmap.width < 640 || bitmap.height < 480) flags.push("low_resolution");
  if (mean < 40) flags.push("too_dark");
  if (mean > 225 || bright / (sample * sample) > 0.35) flags.push("overexposed");
  if (edge < 3) flags.push(dark / (sample * sample) > 0.6 ? "empty_frame" : "blurred");
  else if (edge < 6) flags.push("blurred");

  const score = Math.max(0, Math.min(1, (Math.min(edge, 20) / 20) * 0.6 + (mean > 40 && mean < 225 ? 0.4 : 0.1)));

  bitmap.close?.();
  return { width: bitmap.width, height: bitmap.height, score, flags, meanLuminance: mean, edgeEnergy: edge };
}
