import {
  geminiResponseSchema,
  visionResponseSchema,
  type VisionResponse,
} from "@/lib/ai/vision-schema";
import {
  PROMPT_VERSION,
  SYSTEM_INSTRUCTION,
  buildUserPrompt,
} from "@/lib/ai/prompts/receiving-inspection";
import { getLimits } from "@/lib/config";
import type { LocalSignals, PoLineExpectation } from "@/lib/types";

/**
 * Gemini adapter — ONE multimodal call per receiving unit.
 *
 * Everything the inspection needs (PO context, OCR, barcode, all images) goes
 * into a single generateContent request. There is deliberately no second call
 * for identity, quantity, damage or variant.
 */

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type InspectionFailure =
  | "timeout"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_error"
  | "model_error"
  | "invalid_response"
  | "not_configured";

export type InspectionCallResult =
  | {
      ok: true;
      data: VisionResponse;
      raw: string;
      latencyMs: number;
      modelVersion: string;
      promptVersion: string;
    }
  | {
      ok: false;
      outcome: InspectionFailure;
      message: string;
      latencyMs: number;
      modelVersion: string;
      promptVersion: string;
      raw?: string;
    };

export interface InspectionImage {
  image_id: string;
  capture_type: string;
  filename: string | null;
  mime_type: string;
  /** base64, without the data: prefix */
  data: string;
}

export function getModelId(): string {
  return process.env.GEMINI_MODEL || "gemini-3.8-flash";
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function runInspection(
  expected: PoLineExpectation,
  signals: LocalSignals,
  images: InspectionImage[],
): Promise<InspectionCallResult> {
  const modelVersion = getModelId();
  const promptVersion = PROMPT_VERSION;
  const apiKey = process.env.GEMINI_API_KEY;
  const started = Date.now();

  if (!apiKey) {
    return {
      ok: false,
      outcome: "not_configured",
      message: "GEMINI_API_KEY is not set on the server.",
      latencyMs: 0,
      modelVersion,
      promptVersion,
    };
  }

  const { inspectionTimeoutMs } = getLimits();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), inspectionTimeoutMs);

  const parts: unknown[] = [
    {
      text: buildUserPrompt(
        expected,
        signals,
        images.map((i) => ({
          image_id: i.image_id,
          capture_type: i.capture_type,
          filename: i.filename,
        })),
      ),
    },
  ];

  for (const image of images) {
    parts.push({ text: `image_id=${image.image_id} (capture_type=${image.capture_type})` });
    parts.push({ inlineData: { mimeType: image.mime_type, data: image.data } });
  }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: geminiResponseSchema,
    },
  };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/models/${encodeURIComponent(modelVersion)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      outcome: aborted ? "timeout" : "model_error",
      message: aborted
        ? `Inspection timed out after ${inspectionTimeoutMs} ms.`
        : `Could not reach the model service: ${(error as Error).message}`,
      latencyMs: Date.now() - started,
      modelVersion,
      promptVersion,
    };
  }
  clearTimeout(timer);

  const latencyMs = Date.now() - started;
  const text = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      outcome: classifyHttpError(response.status, text),
      message: httpErrorMessage(response.status, text),
      latencyMs,
      modelVersion,
      promptVersion,
      raw: text.slice(0, 2000),
    };
  }

  let payloadText: string;
  try {
    const payload = JSON.parse(text) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    if (payload.promptFeedback?.blockReason) {
      return {
        ok: false,
        outcome: "model_error",
        message: `The model declined to process this evidence (${payload.promptFeedback.blockReason}).`,
        latencyMs,
        modelVersion,
        promptVersion,
      };
    }
    payloadText = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  } catch {
    return {
      ok: false,
      outcome: "invalid_response",
      message: "The model service returned a response that could not be read.",
      latencyMs,
      modelVersion,
      promptVersion,
      raw: text.slice(0, 2000),
    };
  }

  return parseInspectionPayload(payloadText, { latencyMs, modelVersion, promptVersion });
}

/** Exported so malformed-response handling can be tested without a network call. */
export function parseInspectionPayload(
  payloadText: string,
  meta: { latencyMs: number; modelVersion: string; promptVersion: string },
): InspectionCallResult {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(payloadText));
  } catch {
    return {
      ok: false,
      outcome: "invalid_response",
      message: "The model returned output that is not valid JSON.",
      raw: payloadText.slice(0, 2000),
      ...meta,
    };
  }

  const parsed = visionResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      outcome: "invalid_response",
      message: `The model response did not match the inspection schema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
      raw: payloadText.slice(0, 2000),
      ...meta,
    };
  }

  return { ok: true, data: parsed.data, raw: payloadText, ...meta };
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}

function classifyHttpError(status: number, body: string): InspectionFailure {
  if (status === 429) return /quota|exhaust/i.test(body) ? "quota_exhausted" : "rate_limited";
  if (status === 401 || status === 403) return "auth_error";
  return "model_error";
}

function httpErrorMessage(status: number, body: string): string {
  switch (classifyHttpError(status, body)) {
    case "rate_limited":
      return "The model service is rate limiting requests. The capture is saved — retry in a moment.";
    case "quota_exhausted":
      return "The free-tier model quota for today is used up. The capture is saved — retry after the quota resets.";
    case "auth_error":
      return "The model service rejected the API key. Check GEMINI_API_KEY on the server.";
    default:
      return `The model service returned an error (HTTP ${status}). The capture is saved.`;
  }
}
