import type { Scene } from "../types";

export interface CapCutDraftResult {
  projectName: string;
  projectPath: string;
  sceneCount: number;
}

interface PrepareCapCutOptions {
  projectName: string;
  scenes: Scene[];
  audioFile: File;
  audioDurationSeconds: number;
  srtText: string;
  fallbackDurationSeconds: number;
  width: number;
  height: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

async function requestLocalJson(
  path: string,
  init: RequestInit,
): Promise<any> {
  const urls = Array.from(
    new Set([path, `http://127.0.0.1:3006${path}`]),
  );
  let lastError: Error | null = null;

  for (const url of urls) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("application/json")) {
      lastError = new Error(
        `Backend local inválido em ${url}: ${contentType || "tipo desconhecido"}.`,
      );
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.error || `Servidor local retornou HTTP ${response.status}.`,
      );
    }
    return payload;
  }

  throw lastError || new Error("O backend local do CineGen não respondeu.");
}

export async function prepareCapCutDraft(
  options: PrepareCapCutOptions,
): Promise<CapCutDraftResult> {
  options.onProgress?.(5, "Enviando a narração ao integrador local...");
  const audioPayload = await requestLocalJson("/api/cinegen/capcut/audio", {
    method: "POST",
    headers: {
      "Content-Type": options.audioFile.type || "application/octet-stream",
      "X-CineGen-File-Name": encodeURIComponent(options.audioFile.name),
    },
    body: options.audioFile,
    signal: options.signal,
  });

  options.onProgress?.(15, "Baixando as cenas e montando o rascunho do CapCut...");
  const scenes = options.scenes.map((scene, index) => {
    const startSeconds =
      scene.startSeconds ?? index * options.fallbackDurationSeconds;
    const durationSeconds =
      scene.durationSeconds || options.fallbackDurationSeconds;
    const endSeconds = scene.endSeconds ?? startSeconds + durationSeconds;
    return {
      number: index + 1,
      time: scene.time,
      startSeconds,
      endSeconds,
      durationSeconds,
      mediaType: scene.mediaType === "video" ? "video" : "image",
      imageUrl: scene.imageUrl || null,
      videoUrl: scene.videoUrl || null,
      subtitle: scene.subtitle || null,
    };
  });

  const result = await requestLocalJson("/api/cinegen/capcut", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectName: options.projectName,
      scenes,
      audioUploadId: audioPayload.uploadId,
      audioFileName: options.audioFile.name,
      audioDurationSeconds: options.audioDurationSeconds,
      srtText: options.srtText,
      width: options.width,
      height: options.height,
    }),
    signal: options.signal,
  });
  options.onProgress?.(100, "Rascunho pronto no CapCut.");
  return result as CapCutDraftResult;
}
