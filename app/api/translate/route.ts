// app/api/translate/route.ts
import { NextRequest } from 'next/server';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const BASE_TMP = resolve(process.cwd(), 'temp');
const UPLOAD_DIR = join(BASE_TMP, '');
const OUTPUT_DIR = join(BASE_TMP, '');

function sanitizeDocx(s: string) {
  return (s ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function chunkText(text: string, max = 3000) {
  const paras = text.split('\n').filter(p => p.trim());
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

async function ensureDirs() {
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const { uploadId, sourceLang, targetLang, model } = await request.json();
        console.log('=== [TRANSLATE] START ===');
        console.log('[TRANSLATE] CWD:', process.cwd());
        console.log('[TRANSLATE] BASE_TMP:', BASE_TMP);
        console.log('[TRANSLATE] UPLOAD_DIR:', UPLOAD_DIR);
        console.log('[TRANSLATE] INPUT:', { uploadId, sourceLang, targetLang, model });

        if (!process.env.OPENAI_API_KEY) {
          console.error('[TRANSLATE] No OPENAI_API_KEY');
          send({ type: 'error', message: 'OpenAI API key not configured' });
          controller.close(); return;
        }
        if (!uploadId) {
          console.error('[TRANSLATE] No uploadId');
          send({ type: 'error', message: 'No upload ID provided' });
          controller.close(); return;
        }

        await ensureDirs();

        // Список файлов в temp — помогает увидеть, реально ли туда что-то кладётся upload-роутом
        try {
          const files = await readdir(UPLOAD_DIR);
          console.log('[TRANSLATE] Files in temp/:', files);
        } catch (e) {
          console.error('[TRANSLATE] Cannot list temp dir:', e);
        }

        const pdfPath = join(UPLOAD_DIR, `${uploadId}.pdf`);
        console.log('[TRANSLATE] Looking for file:', pdfPath);

        // stat для наглядности (размер/наличие)
        try {
          const s = await stat(pdfPath);
          console.log('[TRANSLATE] File exists, size:', s.size, 'bytes');
        } catch (e) {
          console.error('[TRANSLATE] File does NOT exist (stat failed):', e);
        }

        let pdfBuffer: Buffer;
        try {
          pdfBuffer = await readFile(pdfPath);
          console.log('[TRANSLATE] File read OK, bytes:', pdfBuffer.length);
        } catch (err) {
          console.error('[TRANSLATE] readFile failed for', pdfPath, err);
          send({ type: 'error', message: 'File not found or expired' });
          controller.close(); return;
        }

        // Ленивая загрузка тяжёлых модулей
        const [{ default: pdf }, { Document, Paragraph, TextRun, Packer }, { default: OpenAI }] =
          await Promise.all([
            import('pdf-parse'),
            import('docx'),
            import('openai'),
          ]);

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        send({ type: 'progress', message: 'Extracting text from PDF...' });
        let pdfData;
        try {
          pdfData = await pdf(pdfBuffer);
          console.log('[TRANSLATE] pdf-parse OK. numpages:', pdfData?.info?.numpages);
        } catch (e) {
          console.error('[TRANSLATE] pdf-parse failed:', e);
          send({ type: 'error', message: 'Failed to parse PDF' });
          controller.close(); return;
        }

        const extracted = (pdfData.text || '').trim();
        console.log('[TRANSLATE] Extracted length:', extracted.length);

        if (!extracted) {
          send({ type: 'error', message: 'No text found in PDF. Ensure it has selectable text.' });
          controller.close(); return;
        }

        const chunks = chunkText(extracted);
        console.log('[TRANSLATE] Chunks:', chunks.length);

        const translatedChunks: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          send({
            type: 'progress',
            currentChunk: i + 1,
            totalChunks: chunks.length,
            message: `Translating chunk ${i + 1}/${chunks.length}...`,
          });
          console.log(`[TRANSLATE] → OpenAI chunk ${i + 1}/${chunks.length}, len=${chunks[i].length}`);

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

        send({ type: 'building', message: 'Building DOCX file...' });
        console.log('[TRANSLATE] Building DOCX. Chunks:', translatedChunks.length);

        const doc = new Document({
          sections: [
            {
              properties: {},
              children: translatedChunks
                .join('\n\n')
                .split('\n')
                .map(line => new Paragraph({ children: [new TextRun({ text: line })] })),
            },
          ],
        });

        const buffer = await Packer.toBuffer(doc);
        const docxId = randomUUID();
        const outPath = join(OUTPUT_DIR, `${docxId}.docx`);
        await writeFile(outPath, buffer);
        console.log('[TRANSLATE] DOCX saved:', outPath);

        const result = {
          downloadUrl: `/api/download?file=${docxId}.docx`,
          pagesProcessed: pdfData?.info?.numpages ?? Math.max(1, Math.ceil(extracted.length / 2000)),
          model: model || 'gpt-4o-mini',
        };

        send({ type: 'completed', result });
        console.log('=== [TRANSLATE] DONE ===');
      } catch (error: any) {
        console.error('[TRANSLATE] Error:', error);
        send({ type: 'error', message: error?.message || 'Translation failed' });
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