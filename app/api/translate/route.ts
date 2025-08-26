// app/api/translate/route.ts
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { head, put } from '@vercel/blob';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 300;

// ─────────── Helpers ───────────
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

const INVALID_XML_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
function sanitizeForDocx(s: string) {
  if (!s) return '';
  s = s.replace(INVALID_XML_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const buf = Buffer.from(s, 'utf8');
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 800): Promise<T> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const st = e?.status ?? e?.response?.status;
      const retriable = st === 429 || (st >= 500 && st < 600);
      console.error(`[RETRY] attempt=${i + 1}/${attempts} status=${st ?? 'n/a'} message=${e?.message ?? e}`);
      if (!retriable || i === attempts - 1) throw e;
      const wait = baseMs * 2 ** i + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

function groupPages(pages: string[], groupSize = 5) {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i += groupSize) {
    out.push(pages.slice(i, i + groupSize).join('\n\n'));
  }
  return out;
}

// ─────────── Route ───────────
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // heartbeat для поддержания SSE
      const hb = setInterval(() => send({ type: 'heartbeat', t: Date.now() }), 10_000);

      const t0 = Date.now();
      try {
        const { uploadId, sourceLang, targetLang, model } = await request.json();
        const logPrefix = `[TRANSLATE ${uploadId ?? 'no-id'}]`;

        if (!uploadId) {
          console.error(`${logPrefix} missing uploadId`);
          send({ type: 'error', message: 'No upload ID provided' });
          clearInterval(hb);
          controller.close();
          return;
        }
        if (!process.env.OPENAI_API_KEY) {
          console.error(`${logPrefix} missing OPENAI_API_KEY`);
          send({ type: 'error', message: 'OpenAI API key not configured' });
          clearInterval(hb);
          controller.close();
          return;
        }
        console.log(`${logPrefix} start; model=${model}; src=${sourceLang} dst=${targetLang}`);

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // 1) ищем загруженный PDF в Blob
        const pdfKey = `uploads/${uploadId}.pdf`;
        console.log(`${logPrefix} head blob: ${pdfKey}`);
        const meta = await head(pdfKey).catch((e) => {
          console.error(`${logPrefix} head error`, e);
          return null;
        });
        if (!meta?.downloadUrl) {
          console.error(`${logPrefix} not found in Blob: ${pdfKey}`);
          send({ type: 'error', message: 'Uploaded file not found in Blob storage' });
          clearInterval(hb);
          controller.close();
          return;
        }

        // 2) скачиваем PDF и извлекаем текст постранично
        console.log(`${logPrefix} fetching pdf (${Math.round((meta?.size ?? 0) / 1024)} kB)`);
        const pdfArrayBuffer = await fetch(meta.downloadUrl).then(r => r.arrayBuffer());
        console.log(`${logPrefix} pdf fetched in ${Date.now() - t0}ms`);

        send({ type: 'progress', message: 'Extracting text from PDF...' });

        const tParse0 = Date.now();
        const { default: pdfParse } = await import('pdf-parse');
        const pdfBuffer = Buffer.from(pdfArrayBuffer);

        const pages: string[] = [];
        let numPages = 0;
        const pdfData = await pdfParse(pdfBuffer, {
          pagerender: async (pageData: any) => {
            const content = await pageData.getTextContent();
            const strings = content.items.map((it: any) => it.str).filter(Boolean);
            const text = strings.join(' ').replace(/\s+\n/g, '\n');
            pages.push(text);
            return text;
          },
        }).catch((e) => {
          console.error(`${logPrefix} pdf-parse error`, e);
          throw new Error('Failed to parse PDF');
        });

        // возможен info.numpages
        numPages = (pdfData?.info?.numpages as number) || pages.length;
        console.log(`${logPrefix} parsed pages=${pages.length} (info.numpages=${numPages}) in ${Date.now() - tParse0}ms`);

        if (!pages.length) {
          send({ type: 'error', message: 'No text found in PDF. Ensure it has selectable text.' });
          clearInterval(hb);
          controller.close();
          return;
        }

        // 3) готовим чанки
        const chunks = groupPages(pages, 5); // можешь поднять до 10
        console.log(`${logPrefix} chunks=${chunks.length}, groupSize=5`);
        send({
          type: 'init',
          phase: 'chunks',
          totalChunks: chunks.length,
          pages: pages.length,
          infoPages: numPages,
          message: `Prepared ${chunks.length} chunks from ${pages.length} pages`,
        });

        // 4) перевод чанков
        const translatedChunks: string[] = [];
        const sys = systemPrompt(sourceLang || 'English', targetLang || 'Russian');
        const useModel = model || 'gpt-4o-mini';
        const isMini = useModel.toLowerCase().includes('mini');

        for (let i = 0; i < chunks.length; i++) {
          const tChunk0 = Date.now();
          console.log(`${logPrefix} chunk ${i + 1}/${chunks.length} → OpenAI (len=${chunks[i].length})`);

          send({
            type: 'progress',
            currentChunk: i + 1,
            totalChunks: chunks.length,
            message: `Translating chunk ${i + 1}/${chunks.length}...`,
          });

          try {
            const translated = await withRetry(async () => {
              const resp = await openai.chat.completions.create({
                model: useModel,
                messages: [
                  { role: 'system', content: sys },
                  { role: 'user', content: chunks[i] },
                ],
                temperature: isMini ? undefined : 0,
              });
              return resp.choices[0]?.message?.content ?? '';
            }, 3);

            translatedChunks.push(sanitizeForDocx(translated));
            console.log(`${logPrefix} chunk ${i + 1} done in ${Date.now() - tChunk0}ms`);
          } catch (e: any) {
            console.error(`${logPrefix} chunk ${i + 1} FAILED:`, e?.message ?? e);
            throw e;
          }
        }

        // 5) сборка DOCX
        console.log(`${logPrefix} building DOCX (chunks=${translatedChunks.length})`);
        send({ type: 'building', message: 'Building DOCX file...' });

        const tDocx0 = Date.now();
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
        console.log(`${logPrefix} DOCX built in ${Date.now() - tDocx0}ms (size=${buffer.byteLength}B)`);

        // 6) сохраняем в Blob
        const docxId = randomUUID();
        const putRes = await put(`results/${docxId}.docx`, buffer, {
          access: 'public',
          addRandomSuffix: false,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        console.log(`${logPrefix} uploaded result: ${putRes.url}`);

        const result = {
          downloadUrl: putRes.url,
          pagesProcessed: numPages || pages.length,
          model: useModel,
          tokenUsage: {
            inputTokens: Math.ceil(pages.join('\n').length / 4),
            outputTokens: Math.ceil(translatedChunks.join('').length / 4),
          },
        };

        send({ type: 'completed', result });
        console.log(`${logPrefix} completed in ${Date.now() - t0}ms`);
      } catch (error: any) {
        console.error('[TRANSLATE] fatal error:', error);
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