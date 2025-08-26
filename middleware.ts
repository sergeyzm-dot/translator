import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter } from '@/lib/rate-limiter';

const limiter = new RateLimiter({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 100, // Max 100 unique IPs per interval
});

export async function middleware(request: NextRequest) {
  // Apply rate limiting to translation endpoint
  if (request.nextUrl.pathname === '/api/translate') {
    const ip = request.ip || request.headers.get('x-forwarded-for') || 'anonymous';
    
    try {
      await limiter.check(10, ip); // 10 requests per minute per IP
    } catch {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        { status: 429 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};