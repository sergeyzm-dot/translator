// app/api/upload/route.ts
import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('pdf');

    if (!(file instanceof File)) {
      return NextResponse.json({ message: 'No PDF file provided (field "pdf")' }, { status: 400 });
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json({ message: 'Only PDF files are allowed' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ message: 'File too large (max 25MB)' }, { status: 400 });
    }

    // заливаем в Vercel Blob
    const blob = await put(`uploads/${Date.now()}-${file.name}`, file, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN, // возьми из Project → Settings → Environment Variables
      addRandomSuffix: true,
      contentType: 'application/pdf',
      cacheControlMaxAge: 60 * 60 * 24, // 1 day
    });

    return NextResponse.json(
      {
        fileUrl: blob.url,     // <-- ЭТО возвращаем фронту
        fileName: file.name,
        size: file.size,
        contentType: file.type,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json(
      { message: err?.message || 'Upload failed' },
      { status: 500 }
    );
  }
}