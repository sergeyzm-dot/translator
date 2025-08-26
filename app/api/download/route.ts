// app/api/download/route.ts
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing "url" query param' }, { status: 400 });
  }
  // 302 на публичный Blob URL
  return NextResponse.redirect(url);
}