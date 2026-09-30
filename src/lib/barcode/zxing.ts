"use client";

/**
 * Free, local barcode / QR detection (ZXing, runs in the browser).
 * Supporting evidence only. An empty result is normal and never an error.
 */
export async function readBarcode(blob: Blob): Promise<string[]> {
  try {
    const { BrowserMultiFormatReader } = await import("@zxing/browser");
    const reader = new BrowserMultiFormatReader();
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const result = await reader.decodeFromImageElement(image);
      const text = result.getText();
      return text ? [text] : [];
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return [];
  }
}
