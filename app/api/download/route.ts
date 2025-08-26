import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const direct = searchParams.get('url'); // ожидаем ?url=<public blob url>
  if (!direct) return NextResponse.json({ message: 'Missing "url" param' }, { status: 400 });
  return NextResponse.redirect(direct, 302);
}