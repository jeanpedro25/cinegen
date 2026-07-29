import type { Scene } from "../types";

export type SceneStatusTone = "idle" | "queued" | "active" | "success" | "error";

export interface SceneStatusDisplay {
  label: string;
  tone: SceneStatusTone;
}

export function getSceneStatusDisplay(scene: Scene): SceneStatusDisplay {
  if (scene.status === "failed") {
    return { label: "Falhou na imagem", tone: "error" };
  }
  if (scene.status === "queued") {
    return { label: "Na fila · imagem", tone: "queued" };
  }
  if (scene.status === "generating") {
    return { label: "Gerando imagem", tone: "active" };
  }
  if (scene.status !== "completed") {
    return { label: "Aguardando", tone: "idle" };
  }

  if (scene.mediaType !== "video") {
    return { label: "Imagem pronta", tone: "success" };
  }
  if (scene.videoStatus === "failed") {
    return { label: "Falhou no vídeo", tone: "error" };
  }
  if (scene.videoStatus === "generating") {
    return { label: "Gerando vídeo", tone: "active" };
  }
  if (scene.videoStatus === "queued") {
    return { label: "Na fila · vídeo", tone: "queued" };
  }
  if (scene.videoStatus === "completed") {
    return { label: "Vídeo pronto", tone: "success" };
  }
  return { label: "Aguardando vídeo", tone: "idle" };
}
