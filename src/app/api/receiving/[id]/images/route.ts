import { NextResponse } from "next/server";
import { z } from "zod";

import { ACCEPTED_MIME_TYPES, STORAGE_BUCKET, getLimits } from "@/lib/config";
import { sha256Hex } from "@/lib/hash";
import { authenticate, fail, isResponse } from "@/lib/server/api";
import { CAPTURE_TYPES } from "@/lib/types";

export const dynamic = "force-dynamic";

const metaSchema = z.object({
  capture_type: z.enum(["overview", "carton_label", "quantity", "product", "damage", "other"]),
  ocr_text: z.string().max(8000).optional().default(""),
  barcode_value: z.string().max(500).optional().default(""),
  quality_score: z.coerce.number().min(0).max(1).optional(),
  quality_flags: z.string().max(500).optional().default(""),
  width: z.coerce.number().int().min(0).max(20000).optional(),
  height: z.coerce.number().int().min(0).max(20000).optional(),
});

type Params = { params: Promise<{ id: string }> };

/** Lists a record's images with short-lived signed URLs (read through the caller's RLS). */
export async function GET(_request: Request, context: Params) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { id } = await context.params;

  const { data: images, error } = await auth.db
    .from("receiving_images")
    .select("id, storage_path, capture_type, original_filename, mime_type, size_bytes, quality_flags, quality_score, ocr_text, barcode_value, uploaded_at")
    .eq("receiving_record_id", id)
    .order("uploaded_at", { ascending: true });
  if (error) return fail(error.message, 500, "database_error");

  const withUrls = await Promise.all(
    (images ?? []).map(async (img) => {
      const { data } = await auth.db.storage.from(STORAGE_BUCKET).createSignedUrl(img.storage_path, 600);
      return { ...img, url: data?.signedUrl ?? null };
    }),
  );
  return NextResponse.json({ images: withUrls });
}

/** Uploads one evidence image. Local OCR/barcode/quality values are supporting metadata only. */
export async function POST(request: Request, context: Params) {
  const auth = await authenticate();
  if (isResponse(auth)) return auth;
  const { db, session } = auth;
  const { id } = await context.params;
  const limits = getLimits();

  const { data: record } = await db
    .from("receiving_records")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!record) return fail("Receiving record not found in your organisation.", 404, "not_found");
  if (record.status === "processing") return fail("Inspection is running; wait before adding images.", 409, "conflict");

  const { count } = await db
    .from("receiving_images")
    .select("id", { count: "exact", head: true })
    .eq("receiving_record_id", id);
  if ((count ?? 0) >= limits.maxImagesPerInspection) {
    return fail(`A receiving unit accepts at most ${limits.maxImagesPerInspection} images.`, 422, "too_many_images");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("Expected multipart form data.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Attach an image in the 'file' field.", 422, "validation_failed");
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return fail("Only JPEG, PNG or WebP images are accepted.", 415, "unsupported_media_type");
  }
  if (file.size === 0) return fail("The image is empty.", 422, "validation_failed");
  if (file.size > limits.maxImageBytes) {
    return fail(`Image exceeds ${Math.round(limits.maxImageBytes / 1048576)} MB.`, 413, "too_large");
  }

  const meta = metaSchema.safeParse(Object.fromEntries([...form.entries()].filter(([k]) => k !== "file")));
  if (!meta.success) return fail(meta.error.issues[0].message, 422, "validation_failed");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const imageId = crypto.randomUUID();
  // Organisation-scoped path: storage policies only allow the caller's own org prefix.
  const storagePath = `${session.organizationSlug}/${id}/${imageId}.${ext}`;

  const { error: uploadError } = await db.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: file.type, upsert: false });
  if (uploadError) return fail(`Upload failed: ${uploadError.message}`, 502, "storage_error");

  const flags = meta.data.quality_flags.split(",").map((f) => f.trim()).filter(Boolean);
  const { data: row, error } = await db
    .from("receiving_images")
    .insert({
      id: imageId,
      organization_id: session.organizationId,
      receiving_record_id: id,
      storage_path: storagePath,
      original_filename: file.name?.slice(0, 200) || null,
      mime_type: file.type,
      size_bytes: file.size,
      sha256,
      capture_type: meta.data.capture_type,
      width: meta.data.width ?? null,
      height: meta.data.height ?? null,
      quality_score: meta.data.quality_score ?? null,
      quality_flags: flags,
      ocr_text: meta.data.ocr_text || null,
      barcode_value: meta.data.barcode_value || null,
    })
    .select("id, capture_type, storage_path, quality_flags")
    .single();
  if (error) {
    await db.storage.from(STORAGE_BUCKET).remove([storagePath]);
    return fail(error.message, 500, "database_error");
  }

  const label = CAPTURE_TYPES.find((c) => c.key === meta.data.capture_type)?.label ?? "Other";
  return NextResponse.json({ image: row, label }, { status: 201 });
}
