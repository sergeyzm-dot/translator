// app/api/translate/route.ts
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// ---- утилиты ----
function sanitizeForDocx(s: string): string {
  return (s ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function chunkText(text: string, max = 3000): string[] {
  const paras = text.split('\n').filter((p) => p.trim());
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    const parts = p.length > max ? (p.match(new RegExp(`.{1,${max}}`, 'g')) ?? [p]) : [p];
    for (const part of parts) {
      if (buf.length + part.length + 1 > max) {
        if (buf.trim()) chunks.push(buf.trim());
        buf = '';
      }
      buf += part + '\n';
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

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

function buildSystemPrompt(src: string, dst: string) {
  const gl = Object.entries(PSYCHO_GLOSSARY)
    .map(([en, ru]) => `${en} → ${ru}`)
    .join(', ');
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

// ---- основной обработчик ----
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const { fileUrl, sourceLang, targetLang, model } = await req.json();

        if (!process.env.OPENAI_API_KEY) {
          send({ type: 'error', message: 'OpenAI API key not configured' });
          controller.close();
          return;
        }
        if (!process.env.BLOB_READ_WRITE_TOKEN) {
          send({ type: 'error', message: 'BLOB_READ_WRITE_TOKEN is missing in Vercel env' });
          controller.close();
          return;
        }
        if (!fileUrl) {
          console.error('[TRANSLATE no-fileUrl] missing fileUrl');
          send({ type: 'error', message: 'Missing fileUrl' });
          controller.close();
          return;
        }

        // Ленивая загрузка тяжёлых модулей (Node runtime)
        const [{ default: pdf }, { Document, Paragraph, TextRun, Packer }, { put }] = await Promise.all([
          import('pdf-parse'),
          import('docx'),
          import('@vercel/blob'),
        ]);
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // 1) скачиваем PDF из Blob
        send({ type: 'progress', stage: 'downloading', message: 'Downloading PDF from storage...' });
        const pdfResp = await fetch(fileUrl);
        if (!pdfResp.ok) {
          send({ type: 'error', message: `Failed to download PDF (${pdfResp.status})` });
          controller.close();
          return;
        }
        const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

        // 2) извлекаем текст
        send({ type: 'progress', stage: 'parsing', message: 'Extracting text from PDF...' });
        const pdfData = await pdf(pdfBuffer);
        const extracted = (pdfData.text || '').trim();
        if (!extracted) {
          send({
            type: 'error',
            message: 'No text found in PDF. Ensure it has selectable (not scanned) text.',
          });
          controller.close();
          return;
        }

        // 3) режем на чанки и сообщаем фронту об их количестве
        const chunks = chunkText(extracted);
        send({
          type: 'init',
          totalChunks: chunks.length,
          message: `Preparing ${chunks.length} chunks...`,
        });

        // 4) перевод
        const translatedChunks: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          send({
            type: 'progress',
            stage: 'translating',
            currentChunk: i + 1,
            totalChunks: chunks.length,
            message: `Translating chunk ${i + 1}/${chunks.length}...`,
          });

          const resp = await openai.chat.completions.create({
            model: model || 'gpt-4o-mini',
            temperature: 0,
            messages: [
              { role: 'system', content: buildSystemPrompt(sourceLang || 'English', targetLang || 'Russian') },
              { role: 'user', content: chunks[i] },
            ],
          });

          const translated = resp.choices[0]?.message?.content ?? '';
          translatedChunks.push(sanitizeForDocx(translated));
        }

        // 5) собираем DOCX
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

        // 6) загружаем DOCX в Vercel Blob, делаем публичным
        const name = `translated-${Date.now()}.docx`;
        const putRes = await put(name, buffer, {
          access: 'public',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });

        // 7) финал
        const result = {
          downloadUrl: putRes.url, // абсолютный URL
          pagesProcessed:
            (pdfData as any)?.info?.numpages ??
            Math.max(1, Math.ceil(extracted.length / 2000)),
          model: model || 'gpt-4o-mini',
          tokenUsage: {
            inputTokens: Math.ceil(extracted.length / 4),
            outputTokens: Math.ceil(translatedChunks.join('').length / 4),
          },
        };

        send({ type: 'completed', result });
      } catch (err: any) {
        console.error('Translate route error:', err);
        send({ type: 'error', message: err?.message || 'Translation failed' });
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