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

// таймауты и ретраи для отдельных вызовов LLM
const CHUNK_REQUEST_TIMEOUT_MS = 60_000; // таймаут одного запроса к OpenAI
const CHUNK_REQUEST_RETRIES = 1;         // сколько дополнительных попыток делать при ошибке

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

// --- УСТОЙЧИВЫЙ вспомогательный fallback через pdfjs-dist ---
// (динамически импортируется только при необходимости)
// Пробуем несколько путей импорта, т.к. разные версии пакета имеют разные entry points.
async function extractTextWithPdfJs(buffer: Buffer | Uint8Array) {
  const tryImportPdfJs = async () => {
    const candidates = [
      'pdfjs-dist/legacy/build/pdf.js',
      'pdfjs-dist/build/pdf.js',
      'pdfjs-dist'
    ];
    let lastErr: any = null;
    for (const p of candidates) {
      try {
        // динамический import — позволит Vercel/webpack определить модуль в рантайме
        const mod = await import(p);
        return mod;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Cannot import pdfjs-dist (tried multiple paths). Last error: ${String(lastErr)}`);
  };

  const pdfjsModule: any = await tryImportPdfJs();

  // Найдём getDocument — модуль может экспортироваться по-разному
  const getDocument =
    pdfjsModule.getDocument ??
    pdfjsModule.default?.getDocument ??
    pdfjsModule.PDFJS?.getDocument ??
    pdfjsModule.getDocument?.default ??
    null;

  if (!getDocument) {
    throw new Error('pdfjs-dist was imported but getDocument() entry point was not found.');
  }

  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const loadingTask = getDocument({ data: uint8 });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages || 0;
  let fullText = "";

  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    // content.items — массив объектов, у которых обычно есть .str
    const pageText = (content.items || []).map((it: any) => {
      if (!it) return '';
      if (typeof it === 'string') return it;
      if (typeof it.str === 'string') return it.str;
      return String(it?.toString?.() ?? '');
    }).join(' ');

    fullText += (fullText ? '\n\n' : '') + pageText;
  }

  return { text: fullText.trim(), numPages };
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

// helper: обёртка промиса с таймаутом
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error(`Timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise,
  ]) as Promise<T>;
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

        const allowedModels = [
          "gpt-4o-mini",
          "gpt-5-mini",
          "gpt-4o",
          "gpt-4",
          "gpt-3.5-turbo"
        ];
        if (!allowedModels.includes(model)) {
          send({ type: "error", message: "Unsupported model" });
          controller.close();
          return;
        }

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

        // Отправляем диагностические заголовки и размер для отладки
        const contentTypeHeader = pdfRes.headers.get("content-type") || "unknown";
        send({ type: "log", message: `PDF Content-Type: ${contentTypeHeader}` });

        const pdfArrayBuffer = await pdfRes.arrayBuffer();
        const pdfBuffer = Buffer.from(pdfArrayBuffer);
        send({ type: "log", message: `Downloaded PDF size: ${pdfBuffer.length} bytes` });

        // вытаскиваем текст и число страниц
        const { pdfParse } = await lazyLoadHeavy();
        send({ type: "log", message: "Extracting text from PDF..." });

        let pdfData: any = null;
        try {
          // основной парсер
          pdfData = await pdfParse(pdfBuffer);
          send({ type: "log", message: "pdf-parse succeeded" });
        } catch (parseErr: any) {
          // подробный лог об ошибке парсера
          send({ type: "log", message: `pdf-parse failed: ${String(parseErr?.message || parseErr)}` });

          // попытка fallback через pdfjs-dist (если установлена)
          try {
            send({ type: "log", message: "Attempting fallback extraction with pdfjs-dist..." });
            const fallback = await extractTextWithPdfJs(pdfBuffer);
            pdfData = { info: { numpages: fallback.numPages }, text: fallback.text };
            send({ type: "log", message: `pdfjs-dist fallback succeeded, pages=${fallback.numPages}` });
          } catch (fallbackErr: any) {
            // если fallback упал — отправляем детальную ошибку и завершаем
            send({ type: "log", message: `pdfjs-dist fallback failed: ${String(fallbackErr?.message || fallbackErr)}` });
            send({ type: "error", message: "Invalid PDF structure" });
            controller.close();
            return;
          }
        }

        const totalPages = pdfData?.info?.numpages ?? 0;
        const fullText = (pdfData?.text ?? "").trim();

        if (!fullText) {
          send({ type: "error", message: "No text found in PDF." });
          controller.close();
          return;
        }

        // расщепляем на "страницы", затем группируем по chunkSizePages в чанк
        const pageTexts = splitTextByPages(fullText, Math.max(1, totalPages || 1));
        const pageChunks = groupBy(pageTexts, Math.max(1, chunkSizePages));
        const totalChunks = pageChunks.length;

        send({
          type: "init",
          totalChunks,
          message: `Total pages in document – ${totalPages || "unknown"}`,
        });

        // Обёртка перевода одного чанка с таймаутом и ретраями и метриками
        async function translateChunkWithRetries(textChunk: string, idx: number): Promise<{ text: string; ok: boolean; usage?: any; durationMs?: number; error?: string }> {
          let lastErr: any = null;
          for (let attempt = 0; attempt <= CHUNK_REQUEST_RETRIES; attempt++) {
            const attemptLabel = attempt + 1;
            const t0 = Date.now();
            try {
              send({ type: "log", message: `Translating chunk ${idx} (attempt ${attemptLabel})...` });

              const prompt = `${systemPrompt(sourceLang, targetLang)}\n\n${textChunk}`;

              // сам вызов к OpenAI, оборачиваем в таймаут
              const call = openai.chat.completions.create({
                model,
                messages: [
                  { role: "system", content: "You are a precise translator." },
                  { role: "user", content: prompt },
                ],
                temperature: 0,
              });

              const resp: any = await withTimeout(call, CHUNK_REQUEST_TIMEOUT_MS, () => {
                send({ type: "log", message: `Chunk ${idx}: request timed out after ${CHUNK_REQUEST_TIMEOUT_MS}ms (attempt ${attemptLabel})` });
              });

              const t1 = Date.now();
              const duration = t1 - t0;

              const out = sanitize(resp.choices?.[0]?.message?.content ?? "");
              const usage = resp?.usage ?? {};
              const promptTokens = usage.prompt_tokens ?? usage.promptTokens ?? 0;
              const completionTokens = usage.completion_tokens ?? usage.completionTokens ?? 0;

              // шлём событие о завершённом чанке с метрикой
              send({
                type: "chunk",
                index: idx,
                durationMs: duration,
                textLength: out.length,
                ok: true,
                promptTokens,
                completionTokens,
              });

              return { text: out, ok: true, usage, durationMs: duration };
            } catch (err: any) {
              lastErr = err;
              const t1 = Date.now();
              const duration = t1 - t0;
              send({ type: "log", message: `Chunk ${idx} error on attempt ${attemptLabel}: ${err?.message || String(err)}` });
              // отправляем частичную метрику о неудаче (позволит UI отобразить last latency)
              send({
                type: "chunk",
                index: idx,
                durationMs: duration,
                textLength: 0,
                ok: false,
                attempt: attemptLabel,
                error: err?.message ?? String(err),
              });

              // короткая пауза перед ретраем
              if (attempt < CHUNK_REQUEST_RETRIES) {
                // небольшой экспоненциальный бекофф
                const backoffMs = 500 * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
              }
            }
          }
          // если все попытки не удались — возвращаем пустой текст и пометку
          send({ type: "log", message: `Chunk ${idx} failed after ${CHUNK_REQUEST_RETRIES + 1} attempts` });
          return { text: "", ok: false, usage: null, durationMs: undefined, error: lastErr?.message ?? String(lastErr) };
        }

        // Разбиваем на батчи и переводим
        const batches = groupBy(pageChunks, PARALLEL_LIMIT);
        let translatedSoFar = 0;
        const translated: string[] = [];
        let failedChunks = 0;

        // агрегированные метрики
        const chunkDurations: number[] = [];
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;

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

          // каждая задача переводит один chunk (набор "страниц")
          const tasks = batch.map(async (pages, i) => {
            const chunkIndexGlobal = b * PARALLEL_LIMIT + i + 1; // 1-based for logs
            const textChunk = pages.join("\n\n");
            const res = await translateChunkWithRetries(textChunk, chunkIndexGlobal);
            return { res, chunkIndexGlobal };
          });

          // Promise.allSettled можно оставить, но каждый таск уже имеет свои таймауты и ретраи
          const results = await Promise.allSettled(tasks);

          for (const r of results) {
            if (r.status === "fulfilled") {
              const value = r.value;
              const v = value.res;
              translated.push(v.text);
              if (!v.ok) failedChunks++;
              if (v.durationMs !== undefined) chunkDurations.push(v.durationMs);
              if (v.usage) {
                const usage = v.usage;
                const p = usage.prompt_tokens ?? usage.promptTokens ?? 0;
                const c = usage.completion_tokens ?? usage.completionTokens ?? 0;
                totalPromptTokens += Number(p || 0);
                totalCompletionTokens += Number(c || 0);
              }
            } else {
              // если промис упал — учитываем как неуспешный
              translated.push("");
              failedChunks++;
              send({ type: "log", message: `A chunk promise was rejected: ${String(r.reason)}` });
            }
            translatedSoFar++;
            send({
              type: "progress",
              currentChunk: translatedSoFar,
              totalChunks,
              message: `Translated chunk ${translatedSoFar}/${totalChunks}`,
            });

            // агрегированные метрики после каждого чанка
            const avg =
              chunkDurations.length > 0
                ? Math.round(chunkDurations.reduce((a, b) => a + b, 0) / chunkDurations.length)
                : 0;
            const last = chunkDurations.length > 0 ? chunkDurations[chunkDurations.length - 1] : 0;

            send({
              type: "metrics",
              averageLatencyMs: avg,
              lastLatencyMs: last,
              completedChunks: translatedSoFar,
              failedChunks,
              totalPromptTokens: totalPromptTokens || undefined,
              totalCompletionTokens: totalCompletionTokens || undefined,
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
        const paragraphs = translated.join("\n\n").split("\n").map((p) => p.trim());
        let url: string;
        try {
          url = await buildAndUploadDocx(paragraphs, process.env.BLOB_READ_WRITE_TOKEN);
        } catch (err: any) {
          send({ type: "error", message: `Failed to build/upload DOCX: ${err?.message || err}` });
          controller.close();
          return;
        }

        const elapsed = Math.round((Date.now() - startAt) / 1000);
        // более корректное pagesProcessed: если pdf парсер вернул real totalPages — используем его,
        // иначе оцениваем на основе успешно переведённых чанков.
        const successfulChunks = translated.filter((t) => !!(t && t.trim().length)).length;
        const estimatedPagesProcessed = successfulChunks * Math.max(1, chunkSizePages);
        const pagesProcessed = totalPages && totalPages > 0
          ? Math.min(totalPages, estimatedPagesProcessed)
          : estimatedPagesProcessed;

        const partial = translated.length < totalChunks || elapsed >= Math.round(HARD_TIME_LIMIT_MS / 1000);

        // финальные метрики
        const avgFinal =
          chunkDurations.length > 0
            ? Math.round(chunkDurations.reduce((a, b) => a + b, 0) / chunkDurations.length)
            : 0;
        send({
          type: "metrics_final",
          averageLatencyMs: avgFinal,
          totalChunksCompleted: translated.length,
          failedChunks,
          totalPromptTokens: totalPromptTokens || undefined,
          totalCompletionTokens: totalCompletionTokens || undefined,
          elapsedSeconds: elapsed,
        });

        send({
          type: "completed",
          result: {
            downloadUrl: url,
            pagesProcessed,
            model,
            elapsedSeconds: elapsed,
            partial,
            failedChunks,
            notice: partial
              ? "The document was translated partially. Current version has a 300-second translation time limit."
              : undefined,
          },
        });
      } catch (err: any) {
        console.error("[TRANSLATE] error:", err);
        const msg = err?.message || "Translation failed";
        send({ type: "error", message: msg });
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