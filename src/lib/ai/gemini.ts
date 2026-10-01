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
 * Gemini adapter â€” one logical multimodal inspection per receiving unit.
 *
 * All receiving checks are sent together in one model request. We retry
 * transient transport/model failures at the same request boundary. If the
 * configured primary model remains unavailable, we fail over to a stable
 * multimodal Flash model instead of immediately leaving the inspection in a
 * dead-end PENDING state.
 *
 * AI observes. Deterministic code decides.
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

// Gemini documents 503/5xx as transient service failures. Retry only these
// transient statuses and do not retry permanent auth/quota/client errors.
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PRIMARY_ATTEMPTS = 2;
const FALLBACK_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 4_000;
const MAX_REQUEST_MS = 14_000;
const DEFAULT_FALLBACK_MODEL = "gemini-3.6-flash";

export function getModelId(): string {
  return process.env.GEMINI_MODEL || "gemini-3.8-flash";
}

function getFallbackModelIds(primary: string): string[] {
  const configured = (process.env.GEMINI_FALLBACK_MODELS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const candidates = [...configured, DEFAULT_FALLBACK_MODEL];
  return [...new Set(candidates)].filter((model) => model !== primary).slice(0, 2);
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function runInspection(
  expected: PoLineExpectation,
  signals: LocalSignals,
  images: InspectionImage[],
): Promise<InspectionCallResult> {
  const primaryModel = getModelId();
  const fallbackModels = getFallbackModelIds(primaryModel);
  const promptVersion = PROMPT_VERSION;
  const apiKey = process.env.GEMINI_API_KEY;
  const started = Date.now();

  if (!apiKey) {
    return {
      ok: false,
      outcome: "not_configured",
      message: "GEMINI_API_KEY is not set on the server.",
      latencyMs: 0,
      modelVersion: primaryModel,
      promptVersion,
    };
  }

  const { inspectionTimeoutMs } = getLimits();
  // Give recovery enough room for a 2-attempt primary + 2-attempt fallback,
  // while still respecting the application's configured upper bound.
  const recoveryBudgetMs = Math.max(inspectionTimeoutMs, 45_000);
  const deadline = started + recoveryBudgetMs;

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
    parts.push({
      text: `image_id=${image.image_id} (capture_type=${image.capture_type})`,
    });
    parts.push({
      inlineData: {
        mimeType: image.mime_type,
        data: image.data,
      },
    });
  }

  // Gemini 3.x guidance: do not force temperature/topP/topK. Use thinkingLevel
  // to control reasoning effort and keep receiving latency bounded.
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: "low",
      },
      responseMimeType: "application/json",
      responseSchema: geminiResponseSchema,
      maxOutputTokens: 4096,
    },
  };

  let lastFailure: InspectionCallResult | null = null;

  const modelsToTry = [
    { id: primaryModel, attempts: PRIMARY_ATTEMPTS, fallback: false },
    ...fallbackModels.map((id) => ({ id, attempts: FALLBACK_ATTEMPTS, fallback: true })),
  ];

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= model.attempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          outcome: "timeout",
          message: `Inspection recovery timed out after ${recoveryBudgetMs} ms.`,
          latencyMs: Date.now() - started,
          modelVersion: model.id,
          promptVersion,
        };
      }

      const requestTimeoutMs = Math.min(MAX_REQUEST_MS, remainingMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const response = await fetch(
          `${API_BASE}/models/${encodeURIComponent(model.id)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );

        clearTimeout(timer);
        const responseText = await response.text();

        if (response.ok) {
          const parsed = parseInspectionHttpResponse(responseText, {
            latencyMs: Date.now() - started,
            modelVersion: model.id,
            promptVersion,
          });

          // A valid structured response is the end of the recovery chain.
          if (parsed.ok) return parsed;

          // Invalid output is not fixed by trying the same model repeatedly,
          // so preserve the failure instead of hiding a schema problem.
          return parsed;
        }

        const classified = classifyHttpError(response.status, responseText);
        const failure: InspectionCallResult = {
          ok: false,
          outcome: classified,
          message: httpErrorMessage(response.status, responseText),
          latencyMs: Date.now() - started,
          modelVersion: model.id,
          promptVersion,
          raw: responseText.slice(0, 2000),
        };
        lastFailure = failure;

        // 429 quota exhaustion and auth/client errors are not useful to retry.
        if (
          !isTransientStatus(response.status) ||
          classified === "quota_exhausted" ||
          classified === "auth_error"
        ) {
          return failure;
        }

        const canTrySameModel = attempt < model.attempts;
        const canFailOver = !canTrySameModel && model.id === primaryModel && fallbackModels.length > 0;

        if (canTrySameModel) {
          const delayMs = Math.min(
            parseRetryAfterMs(response.headers.get("retry-after")) ?? exponentialBackoff(attempt),
            MAX_BACKOFF_MS,
          );

          console.warn(
            `[arrivex] Gemini ${model.id} returned HTTP ${response.status}; retry ${attempt + 1}/${model.attempts} in ${delayMs}ms`,
          );

          if (!(await sleepWithinDeadline(delayMs, deadline))) break;
          continue;
        }

        if (canFailOver) {
          console.warn(
            `[arrivex] Gemini ${primaryModel} remains unavailable after ${model.attempts} attempts; failing over to ${fallbackModels[0]}`,
          );
          break;
        }
      } catch (error) {
        clearTimeout(timer);

        const aborted = error instanceof Error && error.name === "AbortError";
        const failure: InspectionCallResult = {
          ok: false,
          outcome: aborted ? "timeout" : "model_error",
          message: aborted
            ? `Gemini request attempt ${attempt} timed out after ${requestTimeoutMs} ms.`
            : `Could not reach the model service: ${error instanceof Error ? error.message : String(error)}`,
          latencyMs: Date.now() - started,
          modelVersion: model.id,
          promptVersion,
        };
        lastFailure = failure;

        if (aborted && Date.now() >= deadline) return failure;

        const canTrySameModel = attempt < model.attempts;
        const canFailOver = !canTrySameModel && model.id === primaryModel && fallbackModels.length > 0;

        if (canTrySameModel) {
          const delayMs = Math.min(exponentialBackoff(attempt), MAX_BACKOFF_MS);
          if (!(await sleepWithinDeadline(delayMs, deadline))) break;
          continue;
        }

        if (canFailOver) break;
      }
    }
  }

  const finalModel = lastFailure && !lastFailure.ok ? lastFailure.modelVersion : primaryModel;
  return {
    ok: false,
    outcome: lastFailure && !lastFailure.ok ? lastFailure.outcome : "model_error",
    message: `The model service remained unavailable after automatic recovery attempts. Primary model: ${primaryModel}${fallbackModels.length ? `; fallback tried: ${fallbackModels.join(", ")}` : ""}. The capture is saved â€” retry when the service is available.`,
    latencyMs: Date.now() - started,
    modelVersion: finalModel,
    promptVersion,
    raw: lastFailure && !lastFailure.ok ? lastFailure.raw : undefined,
  };
}

function parseInspectionHttpResponse(
  text: string,
  meta: { latencyMs: number; modelVersion: string; promptVersion: string },
): InspectionCallResult {
  try {
    const payload = JSON.parse(text) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        finishReason?: string;
      }[];
      promptFeedback?: { blockReason?: string };
    };

    if (payload.promptFeedback?.blockReason) {
      return {
        ok: false,
        outcome: "model_error",
        message: `The model declined to process this evidence (${payload.promptFeedback.blockReason}).`,
        ...meta,
      };
    }

    const candidate = payload.candidates?.[0];
    const payloadText = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

    if (!payloadText) {
      return {
        ok: false,
        outcome: "invalid_response",
        message: `The model returned no inspection content${candidate?.finishReason ? ` (finish reason: ${candidate.finishReason})` : ""}.`,
        raw: text.slice(0, 2000),
        ...meta,
      };
    }

    return parseInspectionPayload(payloadText, meta);
  } catch {
    return {
      ok: false,
      outcome: "invalid_response",
      message: "The model service returned a response that could not be read.",
      raw: text.slice(0, 2000),
      ...meta,
    };
  }
}

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
  if (status === 429) {
    return /quota|exhaust/i.test(body) ? "quota_exhausted" : "rate_limited";
  }
  if (status === 401 || status === 403) return "auth_error";
  return "model_error";
}

function httpErrorMessage(status: number, body: string): string {
  switch (classifyHttpError(status, body)) {
    case "rate_limited":
      return "The model service is temporarily rate limiting requests; Arrivex is retrying automatically.";
    case "quota_exhausted":
      return "The model quota is exhausted. The capture is saved â€” retry after the quota resets.";
    case "auth_error":
      return "The model service rejected the API key. Check GEMINI_API_KEY on the server.";
    default:
      return `The model service returned HTTP ${status}; Arrivex is attempting automatic recovery.`;
  }
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

function exponentialBackoff(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function sleepWithinDeadline(ms: number, deadline: number): Promise<boolean> {
  const wait = Math.min(ms, Math.max(0, deadline - Date.now() - 50));
  if (wait <= 0) return false;
  await new Promise((resolve) => setTimeout(resolve, wait));
  return Date.now() < deadline;
}

