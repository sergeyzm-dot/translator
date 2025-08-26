// app/api/translate/route.ts
import { NextRequest } from "next/server";
import { get, put } from "@vercel/blob";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeDocx(s: string) {
  return (s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function chunkText(text: string, max = 3000) {
  const paras = text.split("\n").filter((p) => p.trim());
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (p.length > max) {
      const parts = p.match(new RegExp(`.{1,${max}}`, "g")) ?? [p];
      for (const part of parts) {
        if (buf.length + part.length + 1 > max) {
          if (buf.trim()) chunks.push(buf.trim());
          buf = "";
        }
        buf += part + "\n";
      }
      continue;
    }
    if (buf.length + p.length + 1 > max) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = "";
    }
    buf += p + "\n";
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
          send({ type: "error", message: "Missing OpenAI API key" });
          controller.close();
          return;
        }

        if (!uploadId) {
          send({ type: "error", message: "No uploadId" });
          controller.close();
          return;
        }

        // ✅ Lazy imports
        const [{ default: pdf }, { Document, Paragraph, TextRun, Packer }, { default: OpenAI }] =
          await Promise.all([
            import("pdf-parse"),
            import("docx"),
            import("openai"),
          ]);

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // достаём PDF из Vercel Blob
        const { url } = await get(`${uploadId}.pdf`);
        const res = await fetch(url);
        const pdfBuffer = Buffer.from(await res.arrayBuffer());

        send({ type: "progress", message: "Extracting text from PDF..." });
        const pdfData = await pdf(pdfBuffer);
        const extracted = (pdfData.text || "").trim();

        if (!extracted) {
          send({ type: "error", message: "No text found in PDF" });
          controller.close();
          return;
        }

        const chunks = chunkText(extracted);
        const translatedChunks: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          send({
            type: "progress",
            currentChunk: i + 1,
            totalChunks: chunks.length,
            message: `Translating chunk ${i + 1}/${chunks.length}...`,
          });

          const resp = await openai.chat.completions.create({
            model: model || "gpt-4o-mini",
            messages: [
              { role: "system", content: `Translate from ${sourceLang} to ${targetLang}` },
              { role: "user", content: chunks[i] },
            ],
            temperature: 0,
          });

          const translated = resp.choices[0]?.message?.content ?? "";
          translatedChunks.push(sanitizeDocx(translated));
        }

        send({ type: "building", message: "Building DOCX file..." });

        const doc = new Document({
          sections: [
            {
              properties: {},
              children: translatedChunks
                .join("\n\n")
                .split("\n")
                .map(
                  (line) =>
                    new Paragraph({
                      children: [new TextRun({ text: line })],
                    })
                ),
            },
          ],
        });

        const buffer = await Packer.toBuffer(doc);
        const docxId = randomUUID();

        // сохраняем результат в Vercel Blob
        const { url: docxUrl } = await put(`${docxId}.docx`, buffer, {
          access: "private",
        });

        const result = {
          downloadUrl: docxUrl,
          pagesProcessed: pdfData?.info?.numpages ?? Math.max(1, Math.ceil(extracted.length / 2000)),
          model: model || "gpt-4o-mini",
        };

        send({ type: "completed", result });
      } catch (err: any) {
        console.error("Translate error:", err);
        send({ type: "error", message: err?.message || "Translation failed" });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
