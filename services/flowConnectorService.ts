export interface FlowConnectionStatus {
  installed: boolean;
  connected: boolean;
  plan?: string;
  tabUrl?: string;
  extensionVersion?: string;
  lastSeen?: number;
  activeJobs?: number;
}

interface FlowVideoRequest {
  prompt: string;
  imageUrl?: string;
  aspectRatio?: "16:9" | "9:16";
  model?: "Veo 3.1 - Fast" | "Veo 3.1 - Quality" | "Veo 3.1 - Lite";
  projectName?: string;
  signal?: AbortSignal;
}

interface FlowImageRequest {
  prompt: string;
  referenceImage?: string | null;
  aspectRatio?: "16:9" | "9:16";
  projectName?: string;
  approveCredits: boolean;
  signal?: AbortSignal;
}

type FlowJobKind = "image" | "video";

const FLOW_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const FLOW_POLL_INTERVAL_MS = 1_000;
const BRIDGE_RESPONSE_TIMEOUT_MS = 1_500;

function requestConnector(
  type: string,
  payload?: Record<string, unknown>,
  timeoutMs = BRIDGE_RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("A ponte do navegador não está disponível."));
  }

  const requestId = `cinegen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        event.data?.source !== "cinegen-flow-connector" ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      finish(() => {
        if (event.data?.ok === false) {
          reject(new Error(event.data?.error || "O conector Flow recusou a solicitação."));
        } else {
          resolve(event.data?.payload);
        }
      });
    };
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error("O conector Flow não respondeu nesta página.")));
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage({
      source: "cinegen-ai-studio",
      type,
      requestId,
      payload,
    }, window.location.origin);
  });
}

async function wakeFlowConnector(jobId: string): Promise<void> {
  await requestConnector("CINEGEN_FLOW_WAKE", { jobId }).catch(() => undefined);
}

export async function cancelFlowJobs(jobId?: string): Promise<void> {
  await Promise.allSettled([
    fetch("/api/cinegen/flow/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jobId ? { id: jobId } : {}),
    }),
    requestConnector("CINEGEN_FLOW_CANCEL", jobId ? { jobId } : {}),
  ]);
}

export async function getFlowConnectionStatus(): Promise<FlowConnectionStatus> {
  try {
    const response = await fetch("/api/cinegen/flow/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    return {
      installed: Boolean(status?.installed),
      connected: Boolean(status?.connected),
      plan: typeof status?.plan === "string" ? status.plan : undefined,
      tabUrl: typeof status?.tabUrl === "string" ? status.tabUrl : undefined,
      extensionVersion: typeof status?.extensionVersion === "string"
        ? status.extensionVersion
        : undefined,
      lastSeen: typeof status?.lastSeen === "number" ? status.lastSeen : undefined,
      activeJobs: typeof status?.activeJobs === "number" ? status.activeJobs : undefined,
    };
  } catch {
    return { installed: false, connected: false };
  }
}

export async function openGoogleFlow(): Promise<void> {
  try {
    await requestConnector("CINEGEN_FLOW_OPEN");
    return;
  } catch {
    // A extensão pode ainda não estar carregada nesta aba. O backend serve como
    // segundo canal e a extensão consome esse comando no próximo heartbeat.
  }

  try {
    const response = await fetch("/api/cinegen/flow/open", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    window.open("https://labs.google/fx/pt/tools/flow", "_blank", "noopener,noreferrer");
  }
}

async function createFlowJob(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException("Fluxo cancelado pelo usuário.", "AbortError");
  }
  const response = await fetch("/api/cinegen/flow/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const accepted = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(accepted?.error || `Servidor Flow retornou HTTP ${response.status}.`);
  }
  const jobId = accepted?.jobId;
  if (!jobId) throw new Error("O conector Flow não criou a tarefa.");

  void wakeFlowConnector(jobId);
  return jobId;
}

async function waitForFlowJob(
  jobId: string,
  kind: FlowJobKind,
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    let timer: number | undefined;
    let settled = false;

    const cleanup = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      void cancelFlowJobs(jobId);
      finish(() => reject(new DOMException("Fluxo cancelado pelo usuário.", "AbortError")));
    };

    const poll = async () => {
      if (settled) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (Date.now() - startedAt > FLOW_JOB_TIMEOUT_MS) {
        void cancelFlowJobs(jobId);
        finish(() => reject(new Error(
          `Tempo limite ao aguardar ${kind === "image" ? "a imagem" : "o vídeo"} no Google Flow.`,
        )));
        return;
      }

      try {
        const statusResponse = await fetch(
          `/api/cinegen/flow/jobs?id=${encodeURIComponent(jobId)}`,
          { cache: "no-store", signal },
        );
        const status = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok) {
          throw new Error(status?.error || `Servidor Flow retornou HTTP ${statusResponse.status}.`);
        }
        const resultUrl = kind === "image" ? status?.resultImageUrl : status?.videoUrl;
        if (status?.status === "completed" && resultUrl) {
          finish(() => resolve(resultUrl));
          return;
        }
        if (status?.status === "failed" || status?.status === "cancelled") {
          finish(() => reject(new Error(
            status?.error ||
            (status?.status === "cancelled"
              ? "A tarefa foi cancelada."
              : `A geração ${kind === "image" ? "da imagem" : "do vídeo"} falhou no Google Flow.`),
          )));
          return;
        }
      } catch (error) {
        if (signal?.aborted) {
          onAbort();
          return;
        }
        finish(() => reject(error));
        return;
      }

      timer = window.setTimeout(poll, FLOW_POLL_INTERVAL_MS);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    void poll();
  });
}

export async function generateFlowVideo(options: FlowVideoRequest): Promise<string> {
  const sfxOnlyPrompt = `${options.prompt}

AUDIO REQUIREMENT — STRICT: Generate only synchronized diegetic sound effects caused by visible actions and subtle natural environmental ambience. Do not generate music, soundtrack, score, instruments, singing, human voice, speech, dialogue, narration, voice-over, spoken script, lip sync or vocal sounds. Never read the scene text aloud. If no sound effect is necessary, output silence.`;
  const jobId = await createFlowJob({
    kind: "video",
    prompt: sfxOnlyPrompt,
    imageUrl: options.imageUrl,
    aspectRatio: options.aspectRatio || "16:9",
    model: options.model || "Veo 3.1 - Fast",
    projectName: options.projectName || "CineGen IA",
  }, options.signal);
  return await waitForFlowJob(jobId, "video", options.signal);
}

export async function generateFlowImage(options: FlowImageRequest): Promise<string> {
  const imagePrompt = `Generate exactly ONE still image for this scene.
Output type: still image only. Do not create or animate a video.
Aspect ratio: ${options.aspectRatio || "16:9"}.
Do not add captions, subtitles, interface text, borders, logos or watermarks.
Preserve the requested visual style, but the content and composition must represent only this scene:

${options.prompt}`;
  const jobId = await createFlowJob({
    kind: "image",
    prompt: imagePrompt,
    imageUrl: options.referenceImage || undefined,
    aspectRatio: options.aspectRatio || "16:9",
    model: "Flow Image",
    projectName: options.projectName || "CineGen IA",
    approveCredits: options.approveCredits,
  }, options.signal);
  return await waitForFlowJob(jobId, "image", options.signal);
}
