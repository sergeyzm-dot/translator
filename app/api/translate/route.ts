// app/api/translate/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { put } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- настройки производительности ---
const DEFAULT_CHUNK_PAGES = 20;     // сколько "страниц" в одном чанке
const PARALLEL_LIMIT = 3;           // сколько чанков переводим одновременно
const HARD_TIME_LIMIT_MS = 290_000; // на 290-й секунде начинаем сборку Word

// легкая санитация текста для DOCX (убрать недопустимые символы)
function sanitize(s: string) {
  return (s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// "страничное" разбиение текста по количеству страниц (приближенно по символам)
function splitTextByPages(fullText: string, numPages: number): string[] {
  if (!numPages || numPages <= 1) return [fullText];
  const len = fullText.length || 1;
  const per = Math.ceil(len / numPages);
  const out: string[] = [];
  for (let i = 0; i < numPages; i++) {
    const start = i * per;
    const end = Math.min((i + 1) * per, len);
    out.push(fullText.slice(start, end));
  }
  // сшиваем хвосты пустых
  return out.map((p) => p.trim());
}

function groupBy<T>(arr: T[], size: number): T[][] {
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

// ленивый импорт тяжелых модулей только в Node-окружении
async function lazyLoadHeavy() {
  const [{ default: pdfParse }, docx] = await Promise.all([
    import("pdf-parse"),
    import("docx"),
  ]);
  return { pdfParse, docx };
}

// системный промпт
function systemPrompt(src: string, dst: string) {
  return `You are a precise, professional academic translator.
- Translate from ${src} to ${dst}.
- Preserve meaning, formatting and paragraph structure.
- Output ONLY the translation, no extra commentary.`;
}

// сборка DOCX и загрузка в Vercel Blob
async function buildAndUploadDocx(
  paragraphs: string[],
  token?: string
): Promise<string> {
  const { docx } = await lazyLoadHeavy();
  const { Document, Paragraph, TextRun, Packer } = docx;

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: paragraphs.map(
          (line) => new Paragraph({ children: [new TextRun({ text: line })] })
        ),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const fileName = `translation-${Date.now()}.docx`;

  const { url } = await put(fileName, buffer, {
    access: "public",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    token, // process.env.BLOB_READ_WRITE_TOKEN
  });

  return url;
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const startAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const {
          fileUrl,
          sourceLang = "English",
          targetLang = "Russian",
          model = "gpt-4o-mini",
          chunkSizePages = DEFAULT_CHUNK_PAGES,
        } = await req.json();

        if (!fileUrl) {
          send({ type: "error", message: "Missing fileUrl" });
          controller.close();
          return;
        }
        if (!process.env.OPENAI_API_KEY) {
          send({ type: "error", message: "OpenAI API key not configured" });
          controller.close();
          return;
        }

        // загружаем PDF
        send({ type: "log", message: "Downloading PDF..." });
        const pdfRes = await fetch(fileUrl);
        if (!pdfRes.ok) {
          send({ type: "error", message: `Failed to download PDF: ${pdfRes.status}` });
          controller.close();
          return;
        }
        const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

        // вытаскиваем текст и число страниц
        const { pdfParse } = await lazyLoadHeavy();
        send({ type: "log", message: "Extracting text..." });
        const pdfData = await pdfParse(pdfBuffer);
        const totalPages = pdfData?.info?.numpages ?? 0;
        const fullText = (pdfData?.text ?? "").trim();

        if (!fullText) {
          send({ type: "error", message: "No text found in PDF." });
          controller.close();
          return;
        }

        // расщепляем на "страницы", затем группируем по 20 "страниц" в чанк
        const pageTexts = splitTextByPages(fullText, Math.max(1, totalPages || 1));
        const pageChunks = groupBy(pageTexts, Math.max(1, chunkSizePages));
        const totalChunks = pageChunks.length;

        // init: сообщаем кол-во страниц (по-английски, как просил)
        send({
          type: "init",
          totalChunks,
          message: `Total pages in document – ${totalPages || "unknown"}`,
        });

        // батчи по PARALLEL_LIMIT чанков
        const batches = groupBy(pageChunks, PARALLEL_LIMIT);
        let translatedSoFar = 0;
        const translated: string[] = []; // сюда складываем перевод по мере готовности

        // основной цикл по батчам
        for (let b = 0; b < batches.length; b++) {
          const batch = batches[b];
          const batchLabel = `${b + 1}/${batches.length}`;

          // проверка тайм-лимита до старта батча
          if (Date.now() - startAt > HARD_TIME_LIMIT_MS) {
            send({
              type: "log",
              message:
                "⏳ Time limit reached. Building partial DOCX...",
            });
            break;
          }

          send({ type: "log", message: `⚡ Started batch ${batchLabel} (size ${batch.length})` });

          // параллельный перевод чанков батча
          const results = await Promise.allSettled(
            batch.map(async (pages) => {
              // склеиваем "страницы" батча в текст чанка
              const textChunk = pages.join("\n\n");
              const prompt = `${systemPrompt(sourceLang, targetLang)}\n\n${textChunk}`;

              const resp = await openai.chat.completions.create({
                model,
                messages: [
                  { role: "system", content: "You are a precise translator." },
                  { role: "user", content: prompt },
                ],
                temperature: 0,
              });

              const out = sanitize(resp.choices[0]?.message?.content ?? "");
              return out;
            })
          );

          // собираем готовые чанки, шлем прогресс
          for (const r of results) {
            if (r.status === "fulfilled") {
              translated.push(r.value);
            } else {
              translated.push(""); // чтобы не ломать порядок; можно логировать подробнее
            }
            translatedSoFar++;
            send({
              type: "progress",
              currentChunk: translatedSoFar,
              totalChunks,
              message: `Translated chunk ${translatedSoFar}/${totalChunks}`,
            });
          }

          send({ type: "log", message: `✅ Finished batch ${batchLabel}` });

          // пост-батчевая проверка тайм-лимита
          if (Date.now() - startAt > HARD_TIME_LIMIT_MS) {
            send({
              type: "log",
              message:
                "⏳ Time limit reached after batch. Building partial DOCX...",
            });
            break;
          }
        }

        // если ничего не перевели — ошибка
        if (translated.length === 0) {
          send({ type: "error", message: "Nothing translated (timeout or errors)." });
          controller.close();
          return;
        }

        // сборка DOCX из переведенной части
        send({ type: "building", message: "Building DOCX file..." });
        const paragraphs = translated.join("\n\n").split("\n");
        const url = await buildAndUploadDocx(paragraphs, process.env.BLOB_READ_WRITE_TOKEN);

        const elapsed = Math.round((Date.now() - startAt) / 1000);
        const partial = translated.length < totalChunks || elapsed >= HARD_TIME_LIMIT_MS / 1000;

        send({
          type: "completed",
          result: {
            downloadUrl: url,
            pagesProcessed:
              Math.min(totalPages || 0, translated.length * Math.max(1, chunkSizePages)),
            model,
            elapsedSeconds: elapsed,
            partial,
            notice: partial
              ? "The document was translated partially. Current version has a 300-second translation time limit."
              : undefined,
          },
        });
      } catch (err: any) {
        console.error("[TRANSLATE] error:", err);
        const msg = err?.message || "Translation failed";
        // шлём ошибку в поток и закрываем
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        controller.close();
      }
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