// app/api/translate/route.ts
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { head, put } from '@vercel/blob';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 300; // дольше выполнение

// --- словарь, как раньше ---
const PSYCHO_GLOSSARY: Record<string, string> = {
  intersubjectivity: 'интерсубъективность',
  attachment: 'привязанность',
  'self-disclosure': 'самораскрытие терапевта',
  enactment: 'разыгрывание',
  countertransference: 'контрперенос',
  transference: 'перенос',
  'therapeutic alliance': 'терапевтический альянс',
  'object relations': 'объектные отношения',
  'holding environment': 'поддерживающая среда',
  containment: 'контейнирование',
  mentalization: 'ментализация',
  'projective identification': 'проективная идентификация',
  'therapeutic frame': 'терапевтическая рамка',
  'working through': 'проработка',
  resistance: 'сопротивление',
};

function systemPrompt(src: string, dst: string) {
  const gl = Object.entries(PSYCHO_GLOSSARY).map(([en, ru]) => `${en} → ${ru}`).join(', ');
  return `You are a professional translator specializing in books and articles on relational psychoanalysis.

Key requirements:
- Translate from ${src} to ${dst}
- Preserve the academic tone and psychological terminology
- Use established psychoanalytic terminology where applicable
- Maintain paragraph structure and formatting
- Ensure clarity and readability for professional audiences

Psychoanalytic terminology glossary: ${gl}

Instructions:
- Output ONLY the translation, no additional comments
- Preserve the original meaning and nuanced tone
- Use gender-neutral language where appropriate in Russian
- Maintain professional academic style throughout

Translate the following text:`;
}

// — санитизация под DOCX (как в твоём примере) —
const INVALID_XML_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
function sanitizeForDocx(s: string) {
  if (!s) return '';
  s = s.replace(INVALID_XML_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // убираем «сломанные» суррогаты
  const buf = Buffer.from(s, 'utf8');
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

// — ретраи на 429/5xx —
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 800): Promise<T> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const st = e?.status ?? e?.response?.status;
      const retriable = st === 429 || (st >= 500 && st < 600);
      if (!retriable || i === attempts - 1) throw e;
      const wait = baseMs * 2 ** i + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

// — группируем страницы по N штук (как chunk_size в Python) —
function groupPages(pages: string[], groupSize = 5) {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i += groupSize) {
    out.push(pages.slice(i, i + groupSize).join('\n\n'));
  }
  return out;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // heartbeat — чтобы не рвался стрим
      const hb = setInterval(() => send({ type: 'heartbeat', t: Date.now() }), 10_000);

      try {
        const { uploadId, sourceLang, targetLang, model } = await request.json();
        if (!uploadId) {
          send({ type: 'error', message: 'No upload ID provided' });
          clearInterval(hb);
          controller.close();
          return;
        }
        if (!process.env.OPENAI_API_KEY) {
          send({ type: 'error', message: 'OpenAI API key not configured' });
          clearInterval(hb);
          controller.close();
          return;
        }
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // 1) достаём PDF из Blob
        const pdfKey = `uploads/${uploadId}.pdf`;
        const meta = await head(pdfKey).catch(() => null);
        if (!meta?.downloadUrl) {
          send({ type: 'error', message: 'Uploaded file not found in Blob storage' });
          clearInterval(hb);
          controller.close();
          return;
        }

        send({ type: 'progress', message: 'Extracting text from PDF...' });

        // 2) извлекаем ТЕКСТ ПО СТРАНИЦАМ (как в Python-версии)
        const { default: pdfParse } = await import('pdf-parse');

        // pdf-parse позволяет передать кастомный pagerender
        // Внутри он вызывает pdfjs и отдаёт Page.getTextContent(); мы склеим все items в строку.
        const pdfArrayBuffer = await fetch(meta.downloadUrl).then(r => r.arrayBuffer());
        const pdfBuffer = Buffer.from(pdfArrayBuffer);

        const pages: string[] = [];
        const pdfData = await pdfParse(pdfBuffer, {
          pagerender: async (pageData: any) => {
            const content = await pageData.getTextContent();
            const strings = content.items.map((it: any) => it.str).filter(Boolean);
            const text = strings.join(' ').replace(/\s+\n/g, '\n');
            pages.push(text);
            // вернуть строку всё равно нужно (но она нам не нужна для общего .text)
            return text;
          },
        });

        if (!pages.length) {
          send({ type: 'error', message: 'No text found in PDF. Ensure it has selectable text.' });
          clearInterval(hb);
          controller.close();
          return;
        }

        // 3) группируем страницы по 5 (можешь поднять до 10, как в Python, если стабильно)
        const chunks = groupPages(pages, 5);
        const translatedChunks: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          send({
            type: 'progress',
            currentChunk: i + 1,
            totalChunks: chunks.length,
            message: `Translating chunk ${i + 1}/${chunks.length}...`,
          });

          const sys = systemPrompt(sourceLang || 'English', targetLang || 'Russian');
          const isMini = (model || 'gpt-4o-mini').toLowerCase().includes('mini');

          const translated = await withRetry(async () => {
            const resp = await openai.chat.completions.create({
              model: model || 'gpt-4o-mini',
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: chunks[i] },
              ],
              // как в твоём примере: можно без temperature для mini, но 0 — самый безопасный
              temperature: isMini ? undefined : 0,
            });
            return resp.choices[0]?.message?.content ?? '';
          }, 3);

          translatedChunks.push(sanitizeForDocx(translated));
        }

        send({ type: 'building', message: 'Building DOCX file...' });

        // 4) собираем DOCX
        const { Document, Paragraph, TextRun, Packer } = await import('docx');
        const doc = new Document({
          sections: [
            {
              properties: {},
              children: translatedChunks
                .join('\n\n')
                .split('\n')
                .map((line) => new Paragraph({ children: [new TextRun({ text: line })] })),
            },
          ],
        });
        const buffer = await Packer.toBuffer(doc);

        // 5) сохраняем результат в Blob
        const docxId = randomUUID();
        const putRes = await put(`results/${docxId}.docx`, buffer, {
          access: 'public',
          addRandomSuffix: false,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          token: process.env.BLOB_READ_WRITE_TOKEN, // гарантированная запись
        });

        const result = {
          downloadUrl: putRes.url,
          pagesProcessed: pdfData?.info?.numpages ?? pages.length,
          model: model || 'gpt-4o-mini',
          tokenUsage: {
            // грубая оценка
            inputTokens: Math.ceil(pages.join('\n').length / 4),
            outputTokens: Math.ceil(translatedChunks.join('').length / 4),
          },
        };

        send({ type: 'completed', result });
      } catch (error: any) {
        console.error('Translate route error:', error);
        try {
          const message = error?.message || 'Translation failed';
          send({ type: 'error', message });
        } catch {}
      } finally {
        clearInterval((hb as unknown) as number);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}