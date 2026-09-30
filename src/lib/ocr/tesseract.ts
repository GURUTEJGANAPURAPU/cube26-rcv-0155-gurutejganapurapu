"use client";

/**
 * Free, local OCR (Tesseract.js, WASM, runs in the browser).
 * Supporting evidence only — never authoritative on its own, and never a
 * separate model call.
 */
export async function extractText(blob: Blob, signal?: AbortSignal): Promise<string> {
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      if (signal?.aborted) return "";
      const { data } = await worker.recognize(blob);
      return (data.text || "").replace(/\s+/g, " ").trim();
    } finally {
      await worker.terminate();
    }
  } catch {
    // OCR is optional. A failure must never block the receiving workflow.
    return "";
  }
}
