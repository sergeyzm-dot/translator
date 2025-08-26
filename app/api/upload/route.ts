// app/api/upload/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const MAX_SIZE = 25 * 1024 * 1024; // 25MB как на фронте

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('pdf');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ message: 'No PDF file provided (field "pdf")' }, { status: 400 });
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json({ message: 'Only PDF files are allowed' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ message: 'File too large (max 25MB)' }, { status: 400 });
    }

    // Кладём напрямую в Vercel Blob (никаких temp/ папок)
    const key = `uploads/${crypto.randomUUID()}.pdf`;
    const { url } = await put(key, file, {
      access: 'private',
      addRandomSuffix: false,
      contentType: 'application/pdf',
      // token: process.env.BLOB_READ_WRITE_TOKEN, // можно не указывать — Vercel сам подставит из env
    });

    // фронтенд ждёт uploadId — отдаём ключ blob'а
    return NextResponse.json({ uploadId: key, blobUrl: url }, { status: 200 });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json(
      { message: err?.message || 'Upload failed' },
      { status: 500 }
    );
  }
}
