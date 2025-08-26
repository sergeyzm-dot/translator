// app/api/download/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { get, head } from '@vercel/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(req: NextRequest) {
  try {
    const key = req.nextUrl.searchParams.get('key');
    if (!key) {
      return NextResponse.json({ message: 'Missing "key" parameter' }, { status: 400 });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json({ message: 'Blob token not configured' }, { status: 500 });
    }

    // Проверим, что файл существует
    const meta = await head(key, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!meta) {
      return NextResponse.json({ message: 'File not found' }, { status: 404 });
    }

    // Получим подписанную ссылку (временную)
    const file = await get(key, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    if (!file?.downloadUrl) {
      return NextResponse.json({ message: 'Failed to sign download URL' }, { status: 500 });
    }

    return NextResponse.redirect(file.downloadUrl, { status: 302 });
  } catch (err: any) {
    console.error('Download error:', err);
    return NextResponse.json({ message: err?.message || 'Download failed' }, { status: 500 });
  }
}
