export interface Scene {
  id: number;
  mediaType?: 'image' | 'video';
  time: string;
  startSeconds?: number;
  endSeconds?: number;
  sourceCueStart?: number;
  sourceCueEnd?: number;
  action: string;
  subtitle?: string;
  imageUrl?: string;
  status: 'pending' | 'queued' | 'generating' | 'completed' | 'failed';
  error?: string;
  durationSeconds?: number;
  videoMotionPrompt?: string;
  imagePrompt?: string;
  imageStylePrompt?: string;
  videoUrl?: string;
  videoStatus?: 'idle' | 'queued' | 'generating' | 'completed' | 'failed';
}

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

export interface AppConfig {
  stylePreset: string;
}

export type ImageQualityMode = 'standard' | 'studio';

export enum ProcessingStage {
  IDLE = 'IDLE',
  ANALYZING_AUDIO = 'ANALYZING_AUDIO',
  TRANSCRIBING = 'TRANSCRIBING',
  SCRIPTING = 'SCRIPTING',
  GENERATING_IMAGES = 'GENERATING_IMAGES',
  GENERATING_VIDEO_PROMPTS = 'GENERATING_VIDEO_PROMPTS',
  ANIMATING_VIDEOS = 'ANIMATING_VIDEOS',
  COMPLETED = 'COMPLETED'
}

export const STYLES = [
  "Massinha (Estilo Aardman)",
  "Estúdio Laika (Estilo Coraline)",
  "Stop Motion Wes Anderson",
  "Estilo Lego Movie",
  "Gótico Tim Burton",
  "Animação de Recorte de Papel",
  "Feltro e Lã",
  "Stop Motion Vintage Anos 1930"
];

export const INTERVAL_OPTIONS = [
  { value: 0, label: "Nenhum", description: "Um prompt por cena, sem corte automático" },
  { value: 2, label: "2s", description: "Corte muito rápido" },
  { value: 3, label: "3s", description: "Corte rápido" },
  { value: 6, label: "6s", description: "Padrão CapCut / Shorts" },
  { value: 8, label: "8s", description: "SRT de texto" },
  { value: 10, label: "10s", description: "Rápido" },
  { value: 15, label: "15s", description: "Médio" },
  { value: 30, label: "30s", description: "Estendido" },
  { value: 60, label: "1m", description: "Longo" }
];
