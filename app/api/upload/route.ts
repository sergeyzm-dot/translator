// app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("pdf");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ message: "No PDF provided" }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json({ message: "Only PDF allowed" }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ message: "File too large (max 25MB)" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const uploadId = randomUUID();

    // сохраняем PDF в Vercel Blob
    const { url } = await put(`${uploadId}.pdf`, buffer, {
      access: "private",
    });

    return NextResponse.json({ uploadId, url });
  } catch (err: any) {
    console.error("Upload API error:", err);
    return NextResponse.json(
      { message: err?.message || "Upload failed" },
      { status: 500 }
    );
  }
}
