import { SogniClient } from "@sogni-ai/sogni-client";
import { GoogleGenAI } from "@google/genai";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import {
  buildSfxOnlyVideoPrompt,
  VIDEO_NO_TEXT_NEGATIVE_PROMPT,
  VIDEO_RARE_TEXT_NEGATIVE_PROMPT,
  VIDEO_SFX_NEGATIVE_PROMPT,
} from "../utils/videoAudioPolicy";
import { RARE_SHORT_TEXT_MARKER } from "../utils/textOverlayPolicy";
import {
  createCapCutAudioUploadHandler,
  createCapCutProjectHandler,
  createMediaProxyHandler,
} from "./capcutBackend";

interface ImageRequest {
  prompt?: string;
  stylePrompt?: string;
  referenceMode?: "style" | "character";
  model?: string;
  width?: number;
  height?: number;
  seed?: number;
  batchId?: string;
  sceneKey?: string;
  referenceImage?: string | null;
  qualityMode?: "standard" | "studio";
}

interface VideoRequest {
  prompt?: string;
  imageUrl?: string;
  model?: string;
  duration?: number;
  width?: number;
  height?: number;
}

interface FlowHeartbeat {
  connected?: boolean;
  plan?: string;
  tabUrl?: string;
  extensionVersion?: string;
}

interface FlowJob {
  id: string;
  status: "pending" | "claimed" | "opening_project" | "generating" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  kind?: "image" | "video";
  prompt: string;
  imageUrl?: string;
  resultImageUrl?: string;
  aspectRatio?: "16:9" | "9:16";
  model?: string;
  projectName?: string;
  videoUrl?: string;
  approveCredits?: boolean;
  error?: string;
}

const SOGNI_APP_ID = "7d2b9f16-a3f4-4e7c-88f2-5b9f66be45e3";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;
const GEMINI_TRANSCRIPTION_MODEL = "gemini-3.6-flash";
const LTX_IMAGE_TO_VIDEO_MODEL = "ltx23-22b-fp8_i2v_distilled";
const LTX_BALANCED_VIDEO_CONFIG = Object.freeze({
  fps: 24,
  steps: 8,
  guidance: 1,
  sampler: "euler_ancestral_cfg_pp",
  shift: 5,
  teacacheThreshold: 0.2,
});

const MODEL_ALIASES: Record<string, string> = {
  flux2: "flux2_dev_fp8",
  "krea-2-turbo": "krea2_turbo_fp8_scaled",
  "krea-turbo-2": "krea2_turbo_fp8_scaled",
};

let clientPromise: Promise<SogniClient> | null = null;
let activeApiKey = "";
let flowHeartbeat: (FlowHeartbeat & { lastSeen: number }) | null = null;
let flowOpenRequested = false;
const flowJobs = new Map<string, FlowJob>();

function recoverStaleFlowJobs(): void {
  const now = Date.now();
  for (const job of flowJobs.values()) {
    const age = now - job.updatedAt;
    if ((job.status === "claimed" || job.status === "opening_project") && age > 2 * 60_000) {
      job.status = "pending";
      job.error = undefined;
      job.updatedAt = now;
      continue;
    }
    if (job.status === "generating" && age > 25 * 60_000) {
      job.status = "failed";
      job.error = "A tarefa Flow expirou sem atualização da extensão.";
      job.updatedAt = now;
    }
  }
}

function getClient(apiKey: string): Promise<SogniClient> {
  if (!clientPromise || activeApiKey !== apiKey) {
    activeApiKey = apiKey;
    clientPromise = SogniClient.createInstance({
      appId: SOGNI_APP_ID,
      appSource: "cinegen-ai-studio",
      network: "fast",
      apiKey,
      socketEventSubscriptions: {
        modelAvailability: false,
      },
    }).catch((error) => {
      clientPromise = null;
      activeApiKey = "";
      throw error;
    });
  }

  return clientPromise;
}

function imageStepsForModel(model: string, qualityMode: "standard" | "studio" = "standard"): number {
  if (model.includes("schnell")) return 4;
  // Modelos Turbo são destilados para completar em poucos passos. Aumentar
  // para 12 só eleva a latência e não produz ganho proporcional de qualidade.
  if (model.includes("turbo") || model.includes("krea2")) return 8;
  return qualityMode === "studio" ? 28 : 20;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function forwardToStableEngine(
  engineUrl: string,
  route: "image" | "video",
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${engineUrl.replace(/\/+$/, "")}/api/cinegen/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text || `O motor respondeu com HTTP ${response.status}.` };
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`Payload maior que ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body.length === 0) return {} as T;
  return JSON.parse(body.toString("utf8")) as T;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Erro desconhecido";
  }
}

function dataUrlToBuffer(value?: string | null): Buffer | undefined {
  if (!value) return undefined;
  const match = value.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    throw new Error("A imagem de referência precisa ser PNG, JPEG ou WebP.");
  }

  const buffer = Buffer.from(match[1].replace(/\s/g, ""), "base64");
  if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
    throw new Error("A imagem de referência está vazia ou excede 8 MB.");
  }
  return buffer;
}

async function imageSourceToBuffer(value?: string): Promise<Buffer> {
  if (value?.startsWith("data:")) {
    const inline = dataUrlToBuffer(value);
    if (inline) return inline;
  }
  if (!value || !/^https?:\/\//i.test(value)) {
    throw new Error("A cena precisa de uma imagem válida para ser animada.");
  }
  const response = await fetch(value);
  if (!response.ok) throw new Error(`HTTP ${response.status} ao carregar imagem da cena.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > 12 * 1024 * 1024) {
    throw new Error("A imagem da cena está vazia ou excede 12 MB.");
  }
  return buffer;
}

async function selectVerifiedVideoUrl(urls: unknown): Promise<string | undefined> {
  if (!Array.isArray(urls)) return undefined;
  const candidates = urls.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && /^https?:\/\//i.test(candidate),
  );

  const explicitVideo = candidates.find((candidate) => {
    try {
      return /\.(?:mp4|webm|mov)(?:$|[?#])/i.test(new URL(candidate).pathname);
    } catch {
      return false;
    }
  });
  if (explicitVideo) return explicitVideo;

  for (const candidate of candidates) {
    try {
      const mediaResponse = await fetch(candidate, {
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
      });
      const contentType = mediaResponse.headers.get("content-type")?.toLowerCase() || "";
      await mediaResponse.body?.cancel();
      if (mediaResponse.ok && contentType.startsWith("video/")) return candidate;
    } catch {
      // Tenta o próximo resultado. Imagem de capa nunca deve ser aceita como vídeo.
    }
  }

  return undefined;
}

function createImageHandler(apiKey: string, engineUrl: string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para gerar uma imagem." });
      return;
    }

    if (!apiKey.trim()) {
      sendJson(response, 503, {
        error: "SOGNI_API_KEY não está configurada no arquivo .env.local.",
      });
      return;
    }

    let project:
      | Awaited<ReturnType<SogniClient["projects"]["create"]>>
      | undefined;

    try {
      const body = await readJson<ImageRequest>(request);
      const prompt = body.prompt?.trim();
      if (!prompt) {
        sendJson(response, 400, { error: "O prompt da imagem está vazio." });
        return;
      }

      const model = MODEL_ALIASES[body.model || ""] || body.model || "krea2_turbo_fp8_scaled";
      const stylePrompt = body.stylePrompt?.trim().slice(0, 1_500) || "";
      const width = Math.min(2560, Math.max(256, Math.round(body.width || 1280)));
      const height = Math.min(2560, Math.max(256, Math.round(body.height || 720)));
      const referenceMode = body.referenceMode === "character" ? "character" : "style";
      const qualityMode = body.qualityMode === "studio" ? "studio" : "standard";
      // A style reference is first converted into a textual art-direction profile
      // by Gemini. Sending its pixels as startingImage would make img2img copy the
      // original subject, pose and composition into every scene.
      const startingImage =
        referenceMode === "character" ? dataUrlToBuffer(body.referenceImage) : undefined;
      const positivePrompt = prompt;
      const allowsRareShortText = positivePrompt.includes(
        `${RARE_SHORT_TEXT_MARKER}: ACTIVE`,
      );
      const seed = Math.max(
        1,
        Math.min(2_147_483_646, Math.round(body.seed || Math.random() * 2_147_483_646)),
      );

      if (engineUrl) {
        try {
          const forwarded = await forwardToStableEngine(engineUrl, "image", {
            ...body,
            referenceImage: referenceMode === "character" ? body.referenceImage : null,
            seed,
            prompt: stylePrompt
              ? `VISUAL STYLE ONLY: ${stylePrompt}\n\nSCENE CONTENT: ${prompt}`
              : prompt,
          });
          sendJson(response, forwarded.status, forwarded.payload);
          return;
        } catch (error) {
          console.warn("[CineGen] Motor local indisponível; usando conexão Sogni direta.", error);
        }
      }

      const client = await getClient(apiKey);
      project = await client.projects.create({
        type: "image",
        network: "fast",
        modelId: model,
        positivePrompt,
        ...(stylePrompt ? { stylePrompt } : {}),
        negativePrompt:
          "blurry, low quality, low resolution, unfinished, rough draft, muddy detail, plastic texture, flat lighting, incoherent shadows, malformed anatomy, deformed face, asymmetrical eyes, bad hands, fused fingers, extra fingers, extra limbs, duplicate subject, cloned pose, repeated face, floating object, warped architecture, broken vehicle, collage, split screen, contact sheet, generic poster, watermark, logo, captions, subtitles, lower thirds, footer text, title cards, prompt text, technical notes, white text strip, black text strip, " +
          (allowsRareShortText
            ? "paragraphs, sentences, multiple labels, extra words, misspelled text, gibberish typography, pseudo-text, handwriting, rows of text"
            : "text, letters, words, numbers, labels, headlines, document writing, newspaper writing, map labels, map legends, coordinates, screen text, signage, gibberish typography, pseudo-text, handwriting, typewritten marks, rows of horizontal strokes, sentence-like squiggles, glyph-like texture"),
        numberOfMedia: 1,
        steps: imageStepsForModel(model, qualityMode),
        width,
        height,
        seed,
        ...(startingImage
          ? {
              startingImage,
              startingImageStrength: referenceMode === "style" ? 0.42 : 0.22,
            }
          : {}),
        billingMode: "auto",
        outputFormat: "jpg",
        appSource: "cinegen-ai-studio",
      });

      const urls = await project.waitForCompletion();
      const url = urls.find(
        (candidate) =>
          typeof candidate === "string" && /^https?:\/\//i.test(candidate),
      );
      if (!url) {
        throw new Error("A Sogni concluiu o projeto sem retornar a URL da imagem.");
      }

      sendJson(response, 200, {
        url,
        projectId: project.id,
        model,
        qualityMode,
        stylePromptApplied: Boolean(stylePrompt),
        stylePromptLength: stylePrompt.length,
      });
    } catch (error) {
      const message = messageFromError(error);
      const status = /payload|json|prompt/i.test(message)
        ? 400
        : /429|queue|limit/i.test(message)
          ? 429
          : 502;

      sendJson(response, status, { error: message });
    }
  };
}

function createVideoHandler(apiKey: string, engineUrl: string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para gerar um vídeo." });
      return;
    }
    if (!apiKey.trim()) {
      sendJson(response, 503, { error: "SOGNI_API_KEY não está configurada no .env.local." });
      return;
    }

    try {
      const body = await readJson<VideoRequest>(request);
      const rawPrompt = body.prompt?.trim();
      if (!rawPrompt) throw new Error("O prompt do vídeo está vazio.");
      const prompt = buildSfxOnlyVideoPrompt(rawPrompt);
      const allowsRareShortText = prompt.includes(
        `${RARE_SHORT_TEXT_MARKER}: ACTIVE`,
      );
      const duration = Math.min(20, Math.max(4, Math.round(body.duration || 6)));
      const width = Math.min(1280, Math.max(512, Math.round(body.width || 1280)));
      const height = Math.min(720, Math.max(480, Math.round(body.height || 720)));

      if (engineUrl) {
        try {
          const forwarded = await forwardToStableEngine(engineUrl, "video", {
            ...body,
            prompt,
          });
          sendJson(response, forwarded.status, forwarded.payload);
          return;
        } catch (error) {
          console.warn("[CineGen] Motor local de vídeo indisponível; usando Sogni direta.", error);
        }
      }

      const referenceImage = await imageSourceToBuffer(body.imageUrl);
      const client = await getClient(apiKey);

      const project = await client.projects.create({
        type: "video",
        network: "fast",
        modelId: LTX_IMAGE_TO_VIDEO_MODEL,
        positivePrompt: prompt,
        negativePrompt: `duplicated motion, unintended camera movement, unintended subject movement, distorted face, identity drift, warped anatomy, extra limbs, ${VIDEO_SFX_NEGATIVE_PROMPT}, ${
          allowsRareShortText
            ? VIDEO_RARE_TEXT_NEGATIVE_PROMPT
            : VIDEO_NO_TEXT_NEGATIVE_PROMPT
        }`,
        referenceImage,
        numberOfMedia: 1,
        duration,
        ...LTX_BALANCED_VIDEO_CONFIG,
        generateAudio: true,
        width,
        height,
        billingMode: "auto",
        outputFormat: "mp4",
        appSource: "cinegen-ai-studio",
      });
      const urls = await project.waitForCompletion();
      const url = await selectVerifiedVideoUrl(urls);
      if (!url) throw new Error("A Sogni concluiu o projeto sem retornar o vídeo.");
      sendJson(response, 200, {
        url,
        projectId: project.id,
        duration,
      });
    } catch (error) {
      const message = messageFromError(error);
      const status = /payload|json|prompt|imagem/i.test(message)
        ? 400
        : /429|queue|limit/i.test(message)
          ? 429
          : 502;
      sendJson(response, status, { error: message });
    }
  };
}

function createTranscriptionHandler(apiKey: string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para transcrever um áudio." });
      return;
    }
    if (!apiKey.trim()) {
      sendJson(response, 503, {
        error: "GEMINI_API_KEY não está configurada no arquivo .env.local.",
      });
      return;
    }

    try {
      const audio = await readBody(request, MAX_AUDIO_BYTES);
      if (audio.length === 0) throw new Error("O arquivo de áudio está vazio.");
      if (audio.length > MAX_INLINE_AUDIO_BYTES) {
        throw new Error(
          "O áudio ultrapassa 14 MB, limite do modo de transcrição direta do Gemini. Comprima o MP3 antes de gerar as cenas.",
        );
      }

      const contentType = String(request.headers["content-type"] || "audio/mpeg")
        .split(";")[0]
        .trim();
      const supportedMimeTypes = new Set([
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/x-wav",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/aiff",
        "audio/mp4",
        "audio/x-m4a",
      ]);
      const mimeType = supportedMimeTypes.has(contentType) ? contentType : "audio/mpeg";
      const ai = new GoogleGenAI({ apiKey });
      const result = await ai.models.generateContent({
        model: GEMINI_TRANSCRIPTION_MODEL,
        contents: [{
          role: "user",
          parts: [
            {
              inlineData: {
                data: audio.toString("base64"),
                mimeType,
              },
            },
            {
              text: "Transcreva integralmente este áudio no idioma original, com pontuação correta. Preserve nomes, números e siglas. Retorne somente a transcrição, sem resumo, títulos, comentários ou Markdown.",
            },
          ],
        }],
      });
      const transcript = result.text?.trim() || "";
      if (!transcript) throw new Error("O Gemini não retornou texto para este áudio.");

      sendJson(response, 200, {
        transcript,
        model: GEMINI_TRANSCRIPTION_MODEL,
        bytes: audio.length,
      });
    } catch (error) {
      const message = messageFromError(error);
      const status = /api key|401|403|unauthor/i.test(message)
        ? 401
        : /payload|arquivo|áudio|audio|mime/i.test(message)
          ? 400
          : /429|quota|resource_exhausted/i.test(message)
            ? 429
            : 502;
      sendJson(response, status, { error: message });
    }
  };
}

function createFlowStatusHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Use GET para consultar o conector Flow." });
      return;
    }
    recoverStaleFlowJobs();
    const age = flowHeartbeat ? Date.now() - flowHeartbeat.lastSeen : Number.POSITIVE_INFINITY;
    const activeJobs = [...flowJobs.values()].filter((job) =>
      ["pending", "claimed", "opening_project", "generating"].includes(job.status)
    ).length;
    sendJson(response, 200, {
      installed: age < 70_000,
      connected: age < 70_000 && Boolean(flowHeartbeat?.connected),
      plan: flowHeartbeat?.plan,
      tabUrl: flowHeartbeat?.tabUrl,
      extensionVersion: flowHeartbeat?.extensionVersion,
      lastSeen: flowHeartbeat?.lastSeen,
      activeJobs,
    });
  };
}

function createFlowHeartbeatHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para atualizar o conector Flow." });
      return;
    }
    const body = await readJson<FlowHeartbeat>(request);
    flowHeartbeat = {
      connected: Boolean(body.connected),
      plan: body.plan?.slice(0, 80),
      tabUrl: body.tabUrl?.slice(0, 1_000),
      extensionVersion: body.extensionVersion?.slice(0, 20),
      lastSeen: Date.now(),
    };
    sendJson(response, 200, { ok: true });
  };
}

function createFlowOpenHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "POST") {
      flowOpenRequested = true;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET") {
      const openFlow = flowOpenRequested;
      flowOpenRequested = false;
      sendJson(response, 200, { openFlow });
      return;
    }
    sendJson(response, 405, { error: "Método não permitido." });
  };
}

function createFlowJobsHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    if (request.method === "POST") {
      const body = await readJson<Partial<FlowJob>>(request);
      const prompt = body.prompt?.trim();
      if (!prompt) {
        sendJson(response, 400, { error: "O prompt da tarefa Flow está vazio." });
        return;
      }
      const heartbeatAge = flowHeartbeat
        ? Date.now() - flowHeartbeat.lastSeen
        : Number.POSITIVE_INFINITY;
      if (heartbeatAge >= 70_000 || !flowHeartbeat?.connected) {
        sendJson(response, 503, {
          error: "Google Flow indisponível ou desconectado. O CineGen usará o motor interno.",
        });
        return;
      }
      const id = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const job: FlowJob = {
        id,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        kind: body.kind === "image" ? "image" : "video",
        prompt,
        imageUrl: body.imageUrl,
        aspectRatio: body.aspectRatio === "9:16" ? "9:16" : "16:9",
        model: body.model || "Veo 3.1 - Fast",
        projectName: body.projectName || "CineGen IA",
        approveCredits: Boolean(body.approveCredits),
      };
      flowJobs.set(id, job);
      sendJson(response, 200, { jobId: id });
      return;
    }

    if (request.method === "GET") {
      const id = requestUrl.searchParams.get("id");
      if (!id) {
        sendJson(response, 400, { error: "Informe o id da tarefa." });
        return;
      }
      sendJson(response, 200, flowJobs.get(id) || { status: "missing" });
      return;
    }

    sendJson(response, 405, { error: "Método não permitido." });
  };
}

function createFlowNextJobHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Use GET para consultar a fila Flow." });
      return;
    }
    recoverStaleFlowJobs();
    const job = [...flowJobs.values()]
      .filter((item) => item.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) {
      sendJson(response, 200, { job: null });
      return;
    }
    job.status = "claimed";
    job.updatedAt = Date.now();
    flowJobs.set(job.id, job);
    sendJson(response, 200, { job });
  };
}

function createFlowJobUpdateHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para atualizar a tarefa Flow." });
      return;
    }
    const body = await readJson<Partial<FlowJob> & { id?: string }>(request);
    const current = body.id ? flowJobs.get(body.id) : undefined;
    if (!body.id || !current) {
      sendJson(response, 404, { error: "Tarefa Flow não encontrada." });
      return;
    }
    const allowedStatus = new Set([
      "claimed",
      "opening_project",
      "generating",
      "completed",
      "failed",
      "cancelled",
    ]);
    const status = allowedStatus.has(String(body.status)) ? body.status! : current.status;
    const updated: FlowJob = {
      ...current,
      status,
      resultImageUrl: typeof body.resultImageUrl === "string"
        ? body.resultImageUrl
        : current.resultImageUrl,
      videoUrl: typeof body.videoUrl === "string" ? body.videoUrl : current.videoUrl,
      error: typeof body.error === "string" ? body.error.slice(0, 2_000) : current.error,
      updatedAt: Date.now(),
    };
    flowJobs.set(updated.id, updated);
    sendJson(response, 200, { ok: true });
  };
}

function createFlowJobCancelHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para cancelar tarefas Flow." });
      return;
    }
    const body = await readJson<{ id?: string }>(request);
    const cancellable = new Set(["pending", "claimed", "opening_project", "generating"]);
    let cancelled = 0;
    for (const job of flowJobs.values()) {
      if (body.id && job.id !== body.id) continue;
      if (!cancellable.has(job.status)) continue;
      job.status = "cancelled";
      job.error = "Tarefa cancelada pelo usuário.";
      job.updatedAt = Date.now();
      cancelled += 1;
    }
    sendJson(response, 200, { ok: true, cancelled });
  };
}

function registerImageRoute(
  server: ViteDevServer | PreviewServer,
  sogniApiKey: string,
  geminiApiKey: string,
  engineUrl: string,
): void {
  server.middlewares.use("/api/cinegen/image", createImageHandler(sogniApiKey, engineUrl));
  server.middlewares.use("/api/cinegen/video", createVideoHandler(sogniApiKey, engineUrl));
  server.middlewares.use("/api/cinegen/media", createMediaProxyHandler());
  server.middlewares.use("/api/cinegen/capcut/audio", createCapCutAudioUploadHandler());
  server.middlewares.use("/api/cinegen/capcut", createCapCutProjectHandler());
  server.middlewares.use("/api/cinegen/transcribe", createTranscriptionHandler(geminiApiKey));
  server.middlewares.use("/api/cinegen/flow/status", createFlowStatusHandler());
  server.middlewares.use("/api/cinegen/flow/heartbeat", createFlowHeartbeatHandler());
  server.middlewares.use("/api/cinegen/flow/open", createFlowOpenHandler());
  server.middlewares.use("/api/cinegen/flow/jobs/next", createFlowNextJobHandler());
  server.middlewares.use("/api/cinegen/flow/jobs/update", createFlowJobUpdateHandler());
  server.middlewares.use("/api/cinegen/flow/jobs/cancel", createFlowJobCancelHandler());
  server.middlewares.use("/api/cinegen/flow/jobs", createFlowJobsHandler());
}

export function sogniBackendPlugin(
  sogniApiKey: string,
  geminiApiKey: string,
  engineUrl = "",
): Plugin {
  return {
    name: "cinegen-sogni-backend",
    configureServer(server) {
      registerImageRoute(server, sogniApiKey, geminiApiKey, engineUrl);
    },
    configurePreviewServer(server) {
      registerImageRoute(server, sogniApiKey, geminiApiKey, engineUrl);
    },
  };
}
