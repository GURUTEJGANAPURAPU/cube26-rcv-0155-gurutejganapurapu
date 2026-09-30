import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticate, fail, isResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

const schema = z.object({
  ocr_text: z.string().max(8000).optional(),
  barcode_value: z.string().max(500).optional(),
  quality_score: z.number().min(0).max(1).optional(),
  quality_flags: z.array(z.string().max(100)).max(20).optional(),
  width: z.number().int().min(1).max(20000).optional(),
  height: z.number().int().min(1).max(20000).optional(),
});

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ id: string; imageId: string }>;
  },
) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;

  const { id, imageId } = await context.params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return fail(
      "Request body must be valid JSON.",
      400,
      "invalid_json",
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "Invalid metadata.",
      422,
      "validation_failed",
    );
  }

  const { data: image, error: lookupError } = await auth.db
    .from("receiving_images")
    .select("id, receiving_record_id")
    .eq("id", imageId)
    .eq("receiving_record_id", id)
    .maybeSingle();

  if (lookupError) {
    return fail(
      lookupError.message,
      500,
      "database_error",
    );
  }

  if (!image) {
    return fail(
      "Evidence image not found in your organisation.",
      404,
      "not_found",
    );
  }

  const updateData: Record<string, unknown> = {};

  if (parsed.data.ocr_text !== undefined) {
    updateData.ocr_text = parsed.data.ocr_text || null;
  }

  if (parsed.data.barcode_value !== undefined) {
    updateData.barcode_value =
      parsed.data.barcode_value || null;
  }

  if (parsed.data.quality_score !== undefined) {
    updateData.quality_score = parsed.data.quality_score;
  }

  if (parsed.data.quality_flags !== undefined) {
    updateData.quality_flags = parsed.data.quality_flags;
  }

  if (parsed.data.width !== undefined) {
    updateData.width = parsed.data.width;
  }

  if (parsed.data.height !== undefined) {
    updateData.height = parsed.data.height;
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({
      image: image,
    });
  }

  const { data, error } = await auth.db
    .from("receiving_images")
    .update(updateData)
    .eq("id", imageId)
    .eq("receiving_record_id", id)
    .select(
      "id, ocr_text, barcode_value, quality_score, quality_flags, width, height",
    )
    .single();

  if (error) {
    return fail(
      error.message,
      500,
      "database_error",
    );
  }

  return NextResponse.json({
    image: data,
  });
}