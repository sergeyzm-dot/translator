// app/api/download/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { join, resolve } from 'path';
import { stat, readFile } from 'fs/promises';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const BASE_TMP = resolve(process.cwd(), 'temp');

export async function GET(req: NextRequest) {
  try {
    // ✅ используем nextUrl вместо request.url
    const file = req.nextUrl.searchParams.get('file');
    if (!file || !file.endsWith('.docx')) {
      return NextResponse.json({ error: 'Invalid file' }, { status: 400 });
    }

    // простейшая защита от path traversal
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const filePath = join(BASE_TMP, file);

    try {
      const s = await stat(filePath);
      if (!s.isFile()) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    } catch {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const buf = await readFile(filePath);

    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('Download error:', err);
    return NextResponse.json(
      { error: err?.message || 'Download failed' },
      { status: 500 }
    );
  }
}