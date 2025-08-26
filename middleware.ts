// middleware.ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// если используешь свой лимитер — импортируй его тут
// import { limiter } from './lib/limiter';

function getClientIp(req: NextRequest): string {
  // берём первый IP из X-Forwarded-For
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const ip = xff.split(',')[0]?.trim();
    if (ip) return ip;
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;

  // Vercel Edge добавляет geo?.ip
  // (тип может быть undefined, поэтому через опциональную цепочку)
  // @ts-expect-error — поле существует в рантайме, но не в типах некоторых версий
  if (req.geo?.ip) return req.geo.ip as string;

  return 'anonymous';
}

export async function middleware(request: NextRequest) {
  // пример ограничения только для /api/translate
  if (request.nextUrl.pathname === '/api/translate') {
    const ip = getClientIp(request);

    // если используешь лимитер — раскомментируй:
    // try {
    //   await limiter.check(10, ip); // 10 req/min per IP, к примеру
    // } catch {
    //   return new NextResponse('Too Many Requests', { status: 429 });
    // }
  }

  return NextResponse.next();
}

// при необходимости ограничь матчинɡ
// export const config = { matcher: ['/api/translate'] };