// app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const runtime = "edge";           // важно: edge-окружение, без локальной FS
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("pdf");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { message: "No PDF file provided (field 'pdf')" },
        { status: 400 }
      );
    }
    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { message: "Only PDF files are allowed" },
        { status: 400 }
      );
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { message: "File too large (max 25MB)" },
        { status: 400 }
      );
    }

    // Генерим ID (в Edge доступен Web Crypto API)
    const uploadId = (globalThis.crypto?.randomUUID?.() ??
      Math.random().toString(36).slice(2)) as string;

    // Кладём файл прямо в Vercel Blob
    const key = `uploads/${uploadId}.pdf`;
    const blob = await put(key, file, {
      access: "private",             // если нужен публичный URL — поставь "public"
      addRandomSuffix: false,
      contentType: "application/pdf",
      // token: process.env.BLOB_READ_WRITE_TOKEN, // можно явно указать, если требуется
    });

    // фронту достаточно знать uploadId (ключ), а url может пригодиться отладочно
    return NextResponse.json({ uploadId: key, blobUrl: blob.url }, { status: 200 });
  } catch (err: any) {
    console.error("[UPLOAD] error:", err);
    return NextResponse.json(
      { message: err?.message || "Upload failed" },
      { status: 500 }
    );
  }
}
