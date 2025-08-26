// app/api/translate/route.ts
import { NextRequest } from 'next/server';
import { put } from '@vercel/blob';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

function sanitizeDocx(s: string) {
  return (s ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function chunkText(text: string, max = 3000) {
  const paras = text.split('\n').filter((p) => p.trim());
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > max) {
      const parts = p.match(new RegExp(`.{1,${max}}`, 'g')) ?? [p];
      for (const part of parts) {
        if (buf.length + part.length + 1 > max) {
          if (buf.trim()) chunks.push(buf.trim());
          buf = '';
        }
        buf += part + '\n';
      }
      continue;
    }
    if (buf.length + p.length + 1 > max) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = '';
    }
    buf += p + '\n';
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const { fileUrl, sourceLang, targetLang, model } = await request.json();

        if (!process.env.OPENAI_API_KEY) {
          send({ type: 'error', message: 'OpenAI API key not configured' });
          controller.close();
          return;
        }
        if (!fileUrl) {
          send({ type: 'error', message: 'No fileUrl provided' });
          controller.close();
          return;
        }

        // Ленивая загрузка тяжёлых модулей (Node)
        const [{ default: pdf }, { Document, Paragraph, TextRun, Packer }, { default: OpenAI }] =
          await Promise.all([
            import('pdf-parse'),
            import('docx'),
            import('openai'),
          ]);

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // 1) забираем PDF из Blob по публичному URL
        send({ type: 'progress', message: 'Downloading PDF from Blob...' });
        const res = await fetch(fileUrl);
        if (!res.ok) {
          send({ type: 'error', message: `Failed to download PDF: ${res.status}` });
          controller.close();
          return;
        }
        const pdfBuffer = Buffer.from(await res.arrayBuffer());

        // 2) извлекаем текст
        send({ type: 'progress', message: 'Extracting text from PDF...' });
        const pdfData = await pdf(pdfBuffer);
        const extracted = (pdfData.text || '').trim();
        if (!extracted) {
          send({
            type: 'error',
            message: 'No text found in PDF. Ensure it has selectable text.',
          });
          controller.close();
          return;
        }

        // 3) бьём на чанки и переводим
        const chunks = chunkText(extracted);
        const translatedChunks: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          send({
            type: 'progress',
            currentChunk: i + 1,
            totalChunks: chunks.length,
            message: `Translating chunk ${i + 1}/${chunks.length}...`,
          });

          const resp = await openai.chat.completions.create({
            model: model || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `Translate from ${sourceLang || 'English'} to ${targetLang || 'Russian'}` },
              { role: 'user', content: chunks[i] },
            ],
            temperature: 0,
          });

          const translated = resp.choices[0]?.message?.content ?? '';
          translatedChunks.push(sanitizeDocx(translated));
        }

        // 4) собираем DOCX
        send({ type: 'building', message: 'Building DOCX file...' });
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

        // 5) кладём DOCX в Blob и отдаём ссылку
        const docxKey = `outputs/${randomUUID()}.docx`;
        const putRes = await put(docxKey, new Blob([buffer], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }), {
          access: 'public',
          token: process.env.BLOB_READ_WRITE_TOKEN,
          addRandomSuffix: false,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          cacheControlMaxAge: 60 * 60 * 24, // 1 day
        });

        const result = {
          downloadUrl: putRes.url, // <-- абсолютный публичный URL
          pagesProcessed: pdfData?.info?.numpages ?? Math.max(1, Math.ceil(extracted.length / 2000)),
          model: model || 'gpt-4o-mini',
          tokenUsage: {
            inputTokens: Math.ceil(extracted.length / 4),
            outputTokens: Math.ceil(translatedChunks.join('').length / 4),
          },
        };

        send({ type: 'completed', result });
      } catch (error: any) {
        console.error('Translate route error:', error);
        const message =
          (typeof error?.message === 'string' && error.message) ||
          'Translation failed';
        send({ type: 'error', message });
      }
      controller.close();
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