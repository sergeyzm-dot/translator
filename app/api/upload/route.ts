// app/api/upload/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const BASE_TMP = resolve(process.cwd(), 'temp');
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('pdf') as File | Blob | null;

    if (!file) {
      console.error('[UPLOAD] No file in formData');
      return NextResponse.json({ message: 'No PDF file provided (field "pdf")' }, { status: 400 });
    }

    // 📝 Логируем базовую информацию
    console.log('[UPLOAD] Received object:', {
      constructor: file.constructor?.name,
      type: 'type' in file ? file.type : undefined,
      size: 'size' in file ? file.size : undefined,
    });

    // Проверка размера
    if ('size' in file && file.size > MAX_SIZE) {
      console.error('[UPLOAD] File too large:', file.size);
      return NextResponse.json({ message: 'File too large (max 25MB)' }, { status: 400 });
    }

    // Проверка типа (мягкая)
    if ('type' in file && file.type && file.type !== 'application/pdf') {
      console.error('[UPLOAD] Wrong MIME type:', file.type);
      return NextResponse.json({ message: 'Only PDF files are allowed' }, { status: 400 });
    }

    // Гарантируем наличие temp/
    await mkdir(BASE_TMP, { recursive: true });

    const uploadId = randomUUID();
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const pdfPath = join(BASE_TMP, `${uploadId}.pdf`);
    await writeFile(pdfPath, buffer);

    console.log(`[UPLOAD] Saved file to: ${pdfPath}`);

    return NextResponse.json({ uploadId }, { status: 200 });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json(
      { message: err?.message || 'Upload failed' },
      { status: 500 }
    );
  }
}