// app/api/translate/route.ts
import { NextRequest } from 'next/server';
import { get, put } from '@vercel/blob';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';              // нужен Node для pdf-parse и docx
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

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

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const { uploadId, sourceLang, targetLang, model } = await request.json();

        if (!process.env.OPENAI_API_KEY) {
          send({ type: 'error', message: 'OpenAI API key not configured' });
          controller.close(); return;
        }
        if (!uploadId) {
          send({ type: 'error', message: 'No upload ID provided' });
          controller.close(); return;
        }

        // ленивые импорты тяжёлых lib
        const [{ default: pdf }, { default: OpenAI }] = await Promise.all([
          import('pdf-parse'),
          import('openai'),
        ]);
        const { Document, Paragraph, TextRun, Packer } = await import('docx');

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // 1) берём PDF из Blob по ключу (uploadId)
        const meta = await get(uploadId);
        if (!meta?.downloadUrl) {
          send({ type: 'error', message: 'Uploaded file not found in Blob' });
          controller.close(); return;
        }

        // 2) скачиваем бинарник и парсим
        send({ type: 'progress', message: 'Extracting text from PDF...' });
        const pdfResp = await fetch(meta.downloadUrl);
        const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

        const pdfData = await pdf(pdfBuffer);
        const extracted = (pdfData.text || '').trim();
        if (!extracted) {
          send({ type: 'error', message: 'No text found in PDF. Ensure it has selectable text.' });
          controller.close(); return;
        }

        // 3) перевод чанками
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
              { role: 'system', content: systemPrompt(sourceLang || 'English', targetLang || 'Russian') },
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
                .map(line => new Paragraph({ children: [new TextRun({ text: line })] })),
            },
          ],
        });

        const buffer = await Packer.toBuffer(doc);

        // 5) кладём DOCX в Blob
        const outKey = `results/${randomUUID()}.docx`;
        await put(outKey, buffer, {
          access: 'private',
          addRandomSuffix: false,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        const result = {
          downloadUrl: `/api/download?key=${encodeURIComponent(outKey)}`,
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
