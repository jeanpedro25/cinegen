import { GoogleGenAI } from "@google/genai";
import { SogniClient } from "@sogni-ai/sogni-client";
import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { maxDuration: 300 };

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const IMAGE_MODEL_ALIASES: Record<string, string> = {
  flux2: "flux2_dev_fp8",
  "krea-2-turbo": "krea2_turbo_fp8_scaled",
  "krea-turbo-2": "krea2_turbo_fp8_scaled",
};
let clientPromise: Promise<SogniClient> | undefined;
let clientKey = "";

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Erro desconhecido.");
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Payload maior que 10 MB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request);
  return (body.length ? JSON.parse(body.toString("utf8")) : {}) as T;
}

function dataUrlToBuffer(value?: string | null) {
  if (!value) return undefined;
  const match = value.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("A imagem de referência precisa ser PNG, JPEG ou WebP.");
  const buffer = Buffer.from(match[1].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("Imagem de referência inválida.");
  return buffer;
}

async function imageSourceToBuffer(value?: string) {
  if (value?.startsWith("data:")) {
    const inline = dataUrlToBuffer(value);
    if (inline) return inline;
  }
  if (!value || !/^https?:\/\//i.test(value)) throw new Error("A cena precisa de uma imagem válida para ser animada.");
  const response = await fetch(value);
  if (!response.ok) throw new Error(`HTTP ${response.status} ao carregar imagem da cena.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error("Imagem da cena inválida.");
  return buffer;
}

async function sogniClient(apiKey: string) {
  if (!clientPromise || clientKey !== apiKey) {
    clientKey = apiKey;
    clientPromise = SogniClient.createInstance({
      appId: "7d2b9f16-a3f4-4e7c-88f2-5b9f66be45e3",
      appSource: "cinegen-ai-studio",
      network: "fast",
      apiKey,
      socketEventSubscriptions: { modelAvailability: false },
    });
  }
  return clientPromise;
}

async function handleImage(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST para gerar uma imagem." });
  const apiKey = process.env.SOGNI_API_KEY || "";
  if (!apiKey) return json(response, 503, { error: "SOGNI_API_KEY não está configurada na Vercel." });
  try {
    const body = await readJson<any>(request);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("O prompt da imagem está vazio.");
    const model = IMAGE_MODEL_ALIASES[body.model] || body.model || "krea2_turbo_fp8_scaled";
    const width = Math.min(2560, Math.max(256, Math.round(body.width || 1280)));
    const height = Math.min(2560, Math.max(256, Math.round(body.height || 720)));
    const referenceMode = body.referenceMode === "character" ? "character" : "style";
    const startingImage = referenceMode === "character" ? dataUrlToBuffer(body.referenceImage) : undefined;
    const project = await (await sogniClient(apiKey)).projects.create({
      type: "image", network: "fast", modelId: model, positivePrompt: prompt,
      ...(body.stylePrompt?.trim() ? { stylePrompt: String(body.stylePrompt).trim().slice(0, 1500) } : {}),
      negativePrompt: "blurry, low quality, malformed anatomy, bad hands, duplicate subject, collage, split screen, watermark, logo, captions, subtitles, title cards, prompt text, text, letters, words, numbers, labels, headlines, document writing, map labels, screen text, signage, gibberish typography",
      numberOfMedia: 1, steps: model.includes("turbo") || model.includes("krea2") ? 8 : body.qualityMode === "studio" ? 28 : 20,
      width, height, seed: Math.max(1, Math.min(2147483646, Math.round(body.seed || Math.random() * 2147483646))),
      ...(startingImage ? { startingImage, startingImageStrength: 0.22 } : {}),
      billingMode: "auto", outputFormat: "jpg", appSource: "cinegen-ai-studio",
    });
    const url = (await project.waitForCompletion()).find((item: unknown): item is string => typeof item === "string" && /^https?:\/\//.test(item));
    if (!url) throw new Error("A Sogni concluiu sem retornar uma imagem.");
    json(response, 200, { url, projectId: project.id, model });
  } catch (error) {
    json(response, /payload|json|prompt/i.test(errorMessage(error)) ? 400 : 502, { error: errorMessage(error) });
  }
}

async function handleVideo(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST para gerar um vídeo." });
  const apiKey = process.env.SOGNI_API_KEY || "";
  if (!apiKey) return json(response, 503, { error: "SOGNI_API_KEY não está configurada na Vercel." });
  try {
    const body = await readJson<any>(request);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("O prompt do vídeo está vazio.");
    const project = await (await sogniClient(apiKey)).projects.create({
      type: "video", network: "fast", modelId: "ltx23-22b-fp8_i2v_distilled", positivePrompt: prompt,
      negativePrompt: "text, letters, words, subtitles, captions, watermark, logo, title cards, gibberish typography, unintended camera movement, distorted face, identity drift, warped anatomy, extra limbs",
      referenceImage: await imageSourceToBuffer(body.imageUrl), numberOfMedia: 1,
      duration: Math.min(20, Math.max(4, Math.round(body.duration || 6))), fps: 24, steps: 8,
      guidance: 1, sampler: "euler_ancestral_cfg_pp", shift: 5, teacacheThreshold: 0.2,
      generateAudio: true, width: Math.min(1280, Math.max(512, Math.round(body.width || 1280))),
      height: Math.min(720, Math.max(480, Math.round(body.height || 720))), billingMode: "auto", outputFormat: "mp4", appSource: "cinegen-ai-studio",
    });
    const urls = await project.waitForCompletion();
    const url = urls.find((item: unknown): item is string => typeof item === "string" && /^https?:\/\//.test(item));
    if (!url) throw new Error("A Sogni concluiu sem retornar um vídeo.");
    json(response, 200, { url, projectId: project.id });
  } catch (error) {
    json(response, /payload|json|prompt|imagem/i.test(errorMessage(error)) ? 400 : 502, { error: errorMessage(error) });
  }
}

async function handleTranscription(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST para transcrever um áudio." });
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) return json(response, 503, { error: "GEMINI_API_KEY não está configurada na Vercel." });
  try {
    const audio = await readBody(request);
    if (!audio.length || audio.length > 14 * 1024 * 1024) throw new Error("O áudio precisa ter até 14 MB.");
    const mimeType = String(request.headers["content-type"] || "audio/mpeg").split(";")[0];
    const result = await new GoogleGenAI({ apiKey }).models.generateContent({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ inlineData: { data: audio.toString("base64"), mimeType } }, { text: "Transcreva integralmente o áudio no idioma original. Retorne somente a transcrição." }] }],
    });
    json(response, 200, { transcript: result.text?.trim() || "" });
  } catch (error) {
    json(response, 502, { error: errorMessage(error) });
  }
}

export default async function cinegenApi(request: IncomingMessage, response: ServerResponse) {
  const path = new URL(request.url || "/", "https://cinegen.local").pathname;
  if (path === "/api/cinegen/image") return handleImage(request, response);
  if (path === "/api/cinegen/video") return handleVideo(request, response);
  if (path === "/api/cinegen/transcribe") return handleTranscription(request, response);
  if (path === "/api/cinegen/flow/status") return json(response, 200, { installed: false, connected: false, activeJobs: 0 });
  return json(response, 404, { error: "Rota CineGen não encontrada." });
}
