/**
 * Sogni.ai API Integration Service
 *
 * Uses the official Sogni SDK for image projects and the Creative Workflows
 * REST API for video projects.
 *
 * Primary image model: krea2_turbo_fp8_scaled (Krea 2 Turbo).
 */

export interface SogniImageOptions {
  prompt: string;
  stylePrompt?: string;
  referenceMode?: "style" | "character";
  model?: string;
  apiKey?: string;
  referenceImage?: string | null;
  width?: number;
  height?: number;
  aspectRatio?: string;
  seed?: number;
  batchId?: string;
  sceneKey?: string;
  signal?: AbortSignal;
  qualityMode?: "standard" | "studio";
}

export interface SogniVideoOptions {
  prompt: string;
  imageUrl?: string;
  model?: string;
  apiKey?: string;
  duration?: number;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

export const DEFAULT_SOGNI_API_KEY = "";
export const DEFAULT_SOGNI_MODEL = "krea2_turbo_fp8_scaled";
export const DEFAULT_SOGNI_VIDEO_MODEL = "ltx23";

// Use the Vite proxy path — avoids browser CORS issues.
// /api/sogni/* is proxied to https://api.sogni.ai/* by vite.config.ts
const SOGNI_BASE_URL = "/api/sogni";

// ─── Semaphore for concurrency control ────────────────────────────────────────
// User-selected concurrency for the current Sogni plan.
export const SOGNI_IMAGE_CONCURRENCY = 16;
let activeSogniRequests = 0;
const sogniQueue: Array<() => void> = [];
export const SOGNI_VIDEO_CONCURRENCY = 4;
let activeVideoRequests = 0;
const videoQueue: Array<() => void> = [];
const IMAGE_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_IMAGE_ATTEMPTS = 3;

const MODEL_ALIASES: Record<string, string> = {
  flux2: "flux2_dev_fp8",
  "krea-2-turbo": DEFAULT_SOGNI_MODEL,
  "krea-turbo-2": DEFAULT_SOGNI_MODEL,
};

function normalizeImageModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Erro desconhecido";
  }
}

function isRetryableImageError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "timeout",
    "network",
    "socket",
    "disconnect",
    "worker",
    "queue",
    "429",
    "temporar",
    "econn",
    "fetch",
    "repet",
    "composição",
  ].some((term) => message.includes(term));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Fluxo cancelado pelo usuário.", "AbortError");
  }
}

async function requestSogniImage(
  prompt: string,
  stylePrompt: string | undefined,
  model: string,
  width: number,
  height: number,
  referenceImage?: string | null,
  referenceMode?: "style" | "character",
  seed?: number,
  batchId?: string,
  sceneKey?: string,
  externalSignal?: AbortSignal,
  qualityMode: "standard" | "studio" = "standard",
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  const cancelRequest = () => controller.abort();
  externalSignal?.addEventListener("abort", cancelRequest, { once: true });
  if (externalSignal?.aborted) controller.abort();

  try {
    const response = await fetch("/api/cinegen/image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        stylePrompt,
        referenceMode,
        model,
        width,
        height,
        referenceImage,
        seed,
        batchId,
        sceneKey,
        qualityMode,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.error || `Servidor Sogni retornou HTTP ${response.status}.`,
      );
    }

    if (typeof payload?.url !== "string" || !/^https?:\/\//i.test(payload.url)) {
      throw new Error("O servidor Sogni não retornou uma URL de imagem válida.");
    }

    return payload.url;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new DOMException("Fluxo cancelado pelo usuário.", "AbortError");
      }
      throw new Error("Timeout ao aguardar a imagem da Sogni.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", cancelRequest);
  }
}

function acquireSogniSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeSogniRequests < SOGNI_IMAGE_CONCURRENCY) {
      activeSogniRequests++;
      resolve();
    } else {
      sogniQueue.push(() => {
        activeSogniRequests++;
        resolve();
      });
    }
  });
}

function releaseSogniSlot(): void {
  activeSogniRequests--;
  const next = sogniQueue.shift();
  if (next) next();
}

function acquireVideoSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeVideoRequests < SOGNI_VIDEO_CONCURRENCY) {
      activeVideoRequests++;
      resolve();
    } else {
      videoQueue.push(() => {
        activeVideoRequests++;
        resolve();
      });
    }
  });
}

function releaseVideoSlot(): void {
  activeVideoRequests = Math.max(0, activeVideoRequests - 1);
  const next = videoQueue.shift();
  if (next) next();
}

// ─── Unique request ID per call ───────────────────────────────────────────────
function uniqueTitle(): string {
  return `CineGen-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Generate one image through the local server route.
 *
 * The server owns the official SDK connection and the API key. The browser
 * only receives the completed media URL, avoiding CORS and invalid WebSocket
 * authentication while still using Unlimited subscription billing.
 */
export async function generateSogniImage(options: SogniImageOptions): Promise<string> {
  const model = normalizeImageModel(options.model || DEFAULT_SOGNI_MODEL);
  const width = options.width || 1280;
  const height = options.height || 720;

  await acquireSogniSlot();

  try {
    throwIfCancelled(options.signal);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt++) {
      throwIfCancelled(options.signal);
      const attemptModel =
        attempt === MAX_IMAGE_ATTEMPTS && model !== "z_image_turbo_bf16"
          ? "z_image_turbo_bf16"
          : model;

      try {
        console.log(
          `[Sogni] Gerando imagem ${attempt}/${MAX_IMAGE_ATTEMPTS} com ${attemptModel} (Unlimited)...`,
        );

        const imageUrl = await requestSogniImage(
          options.prompt.trim(),
          options.stylePrompt?.trim(),
          attemptModel,
          width,
          height,
          options.referenceImage,
          options.referenceMode,
          ((options.seed || Date.now()) + (attempt - 1) * 104_729) % 2_147_483_647 || 1,
          options.batchId,
          options.sceneKey,
          options.signal,
          options.qualityMode || "standard",
        );

        console.log(`[Sogni] Imagem concluída: ${imageUrl.substring(0, 100)}`);
        return imageUrl;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error;
        const message = errorMessage(error);
        const retryable = isRetryableImageError(error);
        const fatal = /api key|401|403|unauthor|subscription.*(?:inactive|unavailable)|plano unlimited não/i.test(
          message.toLowerCase(),
        );

        console.warn(
          `[Sogni] Tentativa ${attempt}/${MAX_IMAGE_ATTEMPTS} falhou: ${message}`,
        );

        if (fatal || attempt === MAX_IMAGE_ATTEMPTS) {
          break;
        }

        await wait(retryable ? 5000 * attempt : 1000);
      }
    }

    throw new Error(
      `Falha na geração Sogni Unlimited após ${MAX_IMAGE_ATTEMPTS} tentativa(s): ${errorMessage(lastError)}`,
    );
  } finally {
    releaseSogniSlot();
  }
}

/**
 * Poll workflow until completed, return image URL from CDN
 */
async function pollWorkflowForImageUrl(
  workflowId: string,
  maxAttempts: number,
  intervalMs: number
): Promise<string | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const response = await fetch(`${SOGNI_BASE_URL}/v1/creative-agent/workflows/${workflowId}`, {
      });

      if (!response.ok) {
        console.warn(`[Sogni] Poll ${attempt + 1}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      // Log full response on first attempt to debug structure
      if (attempt === 0) {
        console.log(`[Sogni] Poll first response keys:`, Object.keys(data));
      }

      // Handle both wrapped and flat response shapes
      const workflow = data?.workflow || data?.data?.workflow || data;
      const status = workflow?.status;

      console.log(`[Sogni] Poll ${attempt + 1}/${maxAttempts}: status=${status} (workflow ${workflowId})`);

      if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
        // Log entire workflow on completion to debug URL location
        console.log('[Sogni] Completed workflow data:', JSON.stringify(workflow).substring(0, 800));

        // PRIMARY: Official docs say artifact URL is at workflow.steps[0].artifacts[0].url
        const steps: any[] = workflow?.steps || workflow?.step_results || [];
        for (const step of steps) {
          const artifacts: any[] = step?.artifacts || step?.outputs || step?.results || step?.output || [];
          for (const a of (Array.isArray(artifacts) ? artifacts : [artifacts])) {
            const url = a?.url || a?.media_url || a?.image_url || a?.uri || a?.download_url || a?.cdn_url;
            if (url && typeof url === 'string' && url.startsWith('http')) {
              console.log(`[Sogni] ✅ Image URL found: ${url.substring(0, 100)}`);
              return url;
            }
          }
          if (typeof step?.output === 'string' && step.output.startsWith('http')) return step.output;
          if (typeof step?.result === 'string' && step.result.startsWith('http')) return step.result;
        }

        const workflowArtifacts: any[] = Array.isArray(workflow?.artifacts)
          ? workflow.artifacts
          : [];
        for (const artifact of workflowArtifacts) {
          const url =
            artifact?.url ||
            artifact?.media_url ||
            artifact?.image_url ||
            artifact?.download_url;
          if (typeof url === "string" && url.startsWith("http")) return url;
        }

        // FALLBACK: top-level output
        const out = workflow?.output || workflow?.outputs || workflow?.result;
        if (typeof out === 'string' && out.startsWith('http')) return out;
        if (out?.url && typeof out.url === 'string') return out.url;
        if (out?.image_url && typeof out.image_url === 'string') return out.image_url;
        if (Array.isArray(out) && out[0]?.url) return out[0].url;
        if (Array.isArray(out) && typeof out[0] === 'string' && out[0].startsWith('http')) return out[0];

        // Could not extract URL — log full payload for debugging
        console.warn('[Sogni] ⚠️ Workflow completed but no image URL found. Full response:', JSON.stringify(data).substring(0, 1500));
      }

      if (
        status === "failed" ||
        status === "partial_failure" ||
        status === "cancelled" ||
        status === "error" ||
        status === "waiting_for_user"
      ) {
        const lastEvent = Array.isArray(workflow?.events)
          ? workflow.events[workflow.events.length - 1]
          : undefined;
        const errMsg =
          workflow?.error?.message ||
          workflow?.errorMessage ||
          workflow?.error ||
          lastEvent?.message ||
          "Workflow falhou";
        console.error(`[Sogni] Workflow ${workflowId} falhou:`, errMsg);
        throw new Error(`Workflow falhou: ${String(errMsg)}`);
      }
    } catch (e: any) {
      // Only re-throw non-polling errors
      if (e.message && (e.message.includes('Workflow') || e.message.includes('falhou'))) throw e;
      console.warn(`[Sogni] Poll error (attempt ${attempt + 1}):`, e.message);
    }
  }
  throw new Error(`Timeout no workflow ${workflowId}`);
}

/**
 * Generate video using Sogni API
 */
export async function generateSogniVideo(options: SogniVideoOptions): Promise<string> {
  if (!options.imageUrl) throw new Error("A cena precisa de uma imagem para ser animada.");
  await acquireVideoSlot();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  const cancelRequest = () => controller.abort();
  options.signal?.addEventListener("abort", cancelRequest, { once: true });
  if (options.signal?.aborted) controller.abort();

  try {
    // Keep the original Sogni CDN URL. The local server downloads it without
    // browser CORS restrictions and uploads the bytes as referenceImage to the
    // official LTX-2.3 image-to-video project.
    const referenceImage = options.imageUrl;
    const response = await fetch("/api/cinegen/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: options.prompt,
        imageUrl: referenceImage,
        model: options.model || "ltx23-22b-fp8_i2v_distilled",
        duration: options.duration || 6,
        width: options.width || 1280,
        height: options.height || 720,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Servidor Sogni retornou HTTP ${response.status}.`);
    }
    if (typeof payload?.url !== "string" || !/^https?:\/\//i.test(payload.url)) {
      throw new Error("O servidor Sogni não retornou uma URL de vídeo válida.");
    }
    return payload.url;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (options.signal?.aborted) {
        throw new DOMException("Fluxo cancelado pelo usuário.", "AbortError");
      }
      throw new Error("Timeout ao aguardar o vídeo da Sogni.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", cancelRequest);
    releaseVideoSlot();
  }
}

async function generateSogniVideoLegacy(options: SogniVideoOptions): Promise<string> {
  const model = options.model || DEFAULT_SOGNI_VIDEO_MODEL;
  const duration = options.duration || 5;

  const stepArgs: any = {
    prompt: options.prompt,
    videoModel: model,
    duration: duration,
  };
  if (options.imageUrl) {
    if (options.imageUrl.startsWith('http')) {
      stepArgs.image_url = options.imageUrl;
    } else {
      stepArgs.image = options.imageUrl;
    }
  }

  const response = await fetch(`${SOGNI_BASE_URL}/v1/creative-agent/workflows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        title: uniqueTitle(),
        steps: [{ id: "vid1", toolName: "generate_video", arguments: stepArgs }]
      }
    })
  });

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`Sogni Video API ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const workflowId =
    data?.data?.workflow?.workflowId ||
    data?.workflow?.workflowId ||
    data?.data?.workflow?.id ||
    data?.workflow?.id ||
    data?.workflowId ||
    data?.id;

  if (!workflowId) throw new Error("Nenhum workflowId retornado pela API de vídeo");

  const videoUrl = await pollWorkflowForImageUrl(workflowId, 120, 3000);
  if (!videoUrl) throw new Error("Timeout: vídeo não completou");

  return await fetchMediaAsBlobUrl(videoUrl);
}

export async function fetchMediaAsBlobUrl(url: string): Promise<string> {
  if (url.startsWith('blob:')) return url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar mídia`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
