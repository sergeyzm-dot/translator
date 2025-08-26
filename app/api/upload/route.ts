import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const MAX_SIZE = 25 * 1024 * 1024;

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

    const key = `uploads/${crypto.randomUUID()}.pdf`;
    const { url } = await put(key, file, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/pdf',
      // token: process.env.BLOB_READ_WRITE_TOKEN, // если store private
    });

    return NextResponse.json({ key, url }, { status: 200 });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json({ message: err?.message || 'Upload failed' }, { status: 500 });
  }
}