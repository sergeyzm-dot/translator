import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

function sanitize(s: string) {
  return (s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function chunkText(text: string, max = 3000) {
  const paras = text.split('\n').filter(p => p.trim());
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf.length + p.length + 1 > max) { if (buf.trim()) out.push(buf.trim()); buf = ''; }
    buf += p + '\n';
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const { fileUrl, sourceLang, targetLang, model } = await request.json();
        if (!process.env.OPENAI_API_KEY) { send({ type: 'error', message: 'OpenAI API key not configured' }); controller.close(); return; }
        if (!fileUrl || typeof fileUrl !== 'string') { send({ type: 'error', message: 'No fileUrl provided' }); controller.close(); return; }

        const [{ default: pdf }, { Document, Paragraph, TextRun, Packer }, OpenAI] = await Promise.all([
          import('pdf-parse'),
          import('docx'),
          import('openai').then(m => (m as any).default ?? m),
        ]);

        // Скачиваем PDF по публичному URL
        send({ type: 'progress', message: 'Downloading PDF from Blob...' });
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
        const pdfBuffer = Buffer.from(await res.arrayBuffer());

        // Извлечение текста
        send({ type: 'progress', message: 'Extracting text from PDF...' });
        const pdfData = await pdf(pdfBuffer);
        const extracted = (pdfData.text || '').trim();
        if (!extracted) { send({ type: 'error', message: 'No text found in PDF. Ensure it has selectable text.' }); controller.close(); return; }

        const chunks = chunkText(extracted);
        const translatedChunks: string[] = [];
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        for (let i = 0; i < chunks.length; i++) {
          send({ type: 'progress', currentChunk: i + 1, totalChunks: chunks.length, message: `Translating chunk ${i + 1}/${chunks.length}...` });
          const resp = await openai.chat.completions.create({
            model: model || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `You are a professional translator specializing in relational psychoanalysis. Translate from ${sourceLang || 'English'} to ${targetLang || 'Russian'}. Output ONLY the translation.` },
              { role: 'user', content: chunks[i] },
            ],
            temperature: 0,
          });
          translatedChunks.push(sanitize(resp.choices[0]?.message?.content ?? ''));
        }

        send({ type: 'building', message: 'Building DOCX file...' });
        const doc = new Document({
          sections: [{ properties: {}, children: translatedChunks.join('\n\n').split('\n').map(line => new Paragraph({ children: [new TextRun({ text: line })] })) }],
        });
        const buffer = await Packer.toBuffer(doc);

        // Заливаем DOCX в Blob и отдаём публичный URL
        const { put } = await import('@vercel/blob');
        const outKey = `outputs/${crypto.randomUUID()}.docx`;
        const putResult = await put(outKey, new Blob([buffer], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }), {
          access: 'public',
          addRandomSuffix: false,
          // token: process.env.BLOB_READ_WRITE_TOKEN,
        });

        const result = {
          downloadUrl: putResult.url,
          pagesProcessed: (pdfData as any)?.numpages ?? Math.max(1, Math.ceil(extracted.length / 2000)),
          model: model || 'gpt-4o-mini',
          tokenUsage: {
            inputTokens: Math.ceil(extracted.length / 4),
            outputTokens: Math.ceil(translatedChunks.join('').length / 4),
          },
        };

        send({ type: 'completed', result });
      } catch (error: any) {
        console.error('Translate route error:', error);
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: error?.message || 'Translation failed' })}\n\n`)); } catch {}
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