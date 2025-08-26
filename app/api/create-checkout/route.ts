// app/api/create-checkout/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // не пытаться пререндерить/кэшировать

// Безопасный публичный URL
const RAW_APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
function originOf(url: string) {
  try { return new URL(url).origin; } catch { return 'http://localhost:3000'; }
}
const APP_ORIGIN = originOf(RAW_APP_URL);

// Диапазон суммы доната
const MIN_USD = 1;
const MAX_USD = 500;

export async function POST(request: NextRequest) {
  try {
    // ❗ ЛЕНИВАЯ инициализация Stripe — только в рантайме запроса
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      console.error('Missing STRIPE_SECRET_KEY in environment');
      return NextResponse.json({ error: 'Stripe is not configured' }, { status: 500 });
    }
    const stripe = new Stripe(key);

    const body = await request.json().catch(() => ({} as any));
    const raw = (typeof body?.amount === 'number' || typeof body?.amount === 'string')
      ? Number(body.amount)
      : NaN;

    if (!Number.isFinite(raw)) {
      return NextResponse.json({ error: 'Amount must be a number' }, { status: 400 });
    }

    // Кламп и округление
    const clamped = Math.min(Math.max(raw, MIN_USD), MAX_USD);
    const amountInCents = Math.round(clamped * 100);
    if (amountInCents < MIN_USD * 100) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    // Безопасные URL'ы
    const successUrl = new URL(APP_ORIGIN + '/');
    successUrl.searchParams.set('payment', 'success');
    const cancelUrl = new URL(APP_ORIGIN + '/');
    cancelUrl.searchParams.set('payment', 'cancelled');

    // Идемпотентность (с учётом суммы, IP, UA)
    const idemKey = 'donate_' + crypto.createHash('sha256').update(JSON.stringify({
      amountInCents,
      ip: request.headers.get('x-forwarded-for') || '',
      ua: request.headers.get('user-agent') || '',
    })).digest('hex').slice(0, 48);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      submit_type: 'donate',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'PDF Translator — Thank You Donation',
            description: 'Support the development of PDF translation tools',
          },
          unit_amount: amountInCents,
        },
        quantity: 1,
      }],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      locale: 'auto',
      metadata: {
        // при желании: userId, uploadId, sourceLang, targetLang
      },
    }, { idempotencyKey: idemKey });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('Stripe error:', err);
    return NextResponse.json({ error: err?.message || 'Payment processing failed' }, { status: 500 });
  }
}