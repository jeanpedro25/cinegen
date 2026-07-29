
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';

import { LogViewer } from './components/LogViewer';
import { ImageModal } from './components/ImageModal';
import { Timeline } from './components/Timeline';
import { ImageQualityMode, LogEntry, ProcessingStage, Scene } from './types';
import {
  CineGenService,
  countExplicitSceneHeadings,
  parsePromptListBlocks,
  parseStructuredPromptBlocks,
} from './services/geminiService';
import {
  generateSogniVideo,
  SOGNI_IMAGE_CONCURRENCY,
  SOGNI_VIDEO_CONCURRENCY,
} from './services/sogniService';
import {
  cancelFlowJobs,
  getFlowConnectionStatus,
  openGoogleFlow,
  type FlowConnectionStatus,
} from './services/flowConnectorService';
import { prepareCapCutDraft } from './services/capcutService';
import { generateSrtSubtitles } from './utils/videoExporter';
import { formatTimelineTime, parseSrtCues } from './utils/srt';
import {
  buildLtxAnimationPrompt,
  DEFAULT_LOCKED_ANIMATION_PROMPT,
} from './utils/ltxPrompt';
import JSZip from 'jszip';

// Simple ID generator
const uuid = () => Math.random().toString(36).substring(2, 9);
const REQUIRED_FLOW_CONNECTOR_VERSION = "2.0.0";

const formatElapsedTime = (totalSeconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
};

const parseVisualPromptBlocks = (content: string) => {
  const structured = parseStructuredPromptBlocks(content);
  return structured.length > 0 ? structured : parsePromptListBlocks(content);
};

export default function App() {
  // Configuration State
  const [selectedStyle, setSelectedStyle] = useState("none");
  const [customStylePrompt, setCustomStylePrompt] = useState("");
  const [imageQualityMode, setImageQualityMode] = useState<ImageQualityMode>("standard");
  const [imageProvider, setImageProvider] = useState<"sogni" | "flow">("sogni");
  const [flowConnection, setFlowConnection] = useState<FlowConnectionStatus>({
    installed: false,
    connected: false,
  });
  const [approveFlowCredits, setApproveFlowCredits] = useState(false);
  const [sceneInterval, setSceneInterval] = useState<number>(6); // Default 6s for CapCut / Shorts
  const [subtitleMode, setSubtitleMode] = useState<"storyboard" | "text-srt-8" | "auto" | "audio" | "script" | "srt-sync">("storyboard");
  const [videoPercentage, setVideoPercentage] = useState(70);
  const [projectName, setProjectName] = useState("Minha História");
  const [isGeneratingVideos, setIsGeneratingVideos] = useState(false);
  const [isExportingProject, setIsExportingProject] = useState(false);
  const [isSynchronizingProject, setIsSynchronizingProject] = useState(false);
  const [synchronizationProgress, setSynchronizationProgress] = useState(0);
  const [synchronizationMessage, setSynchronizationMessage] = useState("");
  const [capCutDraftPath, setCapCutDraftPath] = useState<string | null>(null);
  
  // Data State
  const [refImage, setRefImage] = useState<string | null>(null);
  const [refImageName, setRefImageName] = useState<string | null>(null);
  const [scriptText, setScriptText] = useState("");
  const [animationScriptText, setAnimationScriptText] = useState("");
  const [srtText, setSrtText] = useState("");
  const [srtFileName, setSrtFileName] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stage, setStage] = useState<ProcessingStage>(ProcessingStage.IDLE);
  const [generationElapsedSeconds, setGenerationElapsedSeconds] = useState(0);
  const generationStartedAtRef = useRef<number | null>(null);
  const flowSequenceRef = useRef(0);
  const activeFlowAbortRef = useRef<AbortController | null>(null);
  const synchronizationAbortRef = useRef<AbortController | null>(null);
  
  // Modal State
  const [selectedScene, setSelectedScene] = useState<Scene | null>(null);
  
  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const now = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { id: uuid(), timestamp: now, message, type }]);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const status = await getFlowConnectionStatus();
      if (active) setFlowConnection(status);
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const isGenerationActive =
      stage !== ProcessingStage.IDLE && stage !== ProcessingStage.COMPLETED;

    if (!isGenerationActive) {
      if (generationStartedAtRef.current !== null) {
        setGenerationElapsedSeconds(
          Math.floor((Date.now() - generationStartedAtRef.current) / 1000),
        );
        generationStartedAtRef.current = null;
      }
      return;
    }

    if (generationStartedAtRef.current === null) {
      generationStartedAtRef.current = Date.now();
      setGenerationElapsedSeconds(0);
    }

    const updateElapsed = () => {
      if (generationStartedAtRef.current !== null) {
        setGenerationElapsedSeconds(
          Math.floor((Date.now() - generationStartedAtRef.current) / 1000),
        );
      }
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [stage]);

  const handleConnectGoogleFlow = useCallback(async () => {
    await openGoogleFlow();
    const refreshConnection = async () => {
      const status = await getFlowConnectionStatus();
      setFlowConnection(status);
      return status;
    };
    const immediateStatus = await refreshConnection();
    if (immediateStatus.connected) {
      addLog(
        `Conta Google Flow conectada${immediateStatus.plan ? ` (${immediateStatus.plan})` : ""}. As cenas serão geradas diretamente no Flow.`,
        "success",
      );
      return;
    }
    window.setTimeout(async () => {
      const delayedStatus = await refreshConnection();
      addLog(
        delayedStatus.connected
          ? `Conta Google Flow conectada${delayedStatus.plan ? ` (${delayedStatus.plan})` : ""}.`
          : "A aba do Google Flow foi aberta. Entre na conta Google e mantenha a aba aberta; o CineGen detectará a sessão automaticamente.",
        delayedStatus.connected ? "success" : "warning",
      );
    }, 1_500);
  }, [addLog]);

  const beginFlow = useCallback(() => {
    activeFlowAbortRef.current?.abort();
    const controller = new AbortController();
    const flowId = ++flowSequenceRef.current;
    activeFlowAbortRef.current = controller;
    return { flowId, controller };
  }, []);

  const isFlowActive = useCallback((flowId: number, signal: AbortSignal) => (
    flowSequenceRef.current === flowId && !signal.aborted
  ), []);

  const cancelActiveFlow = useCallback(() => {
    if (!activeFlowAbortRef.current) return;
    flowSequenceRef.current += 1;
    activeFlowAbortRef.current.abort();
    void cancelFlowJobs();
    activeFlowAbortRef.current = null;
    setIsGeneratingVideos(false);
    setScenes(previous => previous.map(scene => ({
      ...scene,
      status:
        scene.status === "generating" || scene.status === "queued"
          ? "pending"
          : scene.status,
      videoStatus:
        scene.videoStatus === "generating" || scene.videoStatus === "queued"
          ? "idle"
          : scene.videoStatus,
    })));
    setStage(ProcessingStage.IDLE);
    addLog("Fluxo cancelado pelo usuário. As cenas já concluídas foram preservadas.", "warning");
  }, [addLog]);

  const presetStyle = selectedStyle === "none" ? "" : selectedStyle;
  const effectiveStyle = [presetStyle, customStylePrompt.trim()]
    .filter(Boolean)
    .join(". ") || "professional cinematic illustration, coherent art direction, detailed finish";
  const imagePercentage = 100 - videoPercentage;
  const effectiveSceneDuration = sceneInterval > 0 ? sceneInterval : 6;
  const srtCues = useMemo(() => parseSrtCues(srtText), [srtText]);
  const srtDuration = srtCues.length > 0
    ? srtCues[srtCues.length - 1].endSeconds
    : 0;

  const buildMediaPlan = (total: number, requestedVideoPercentage: number): Array<"image" | "video"> => {
    const videoTotal = Math.max(
      0,
      Math.min(total, Math.round((total * requestedVideoPercentage) / 100)),
    );
    return Array.from({ length: total }, (_, index) => {
      const videosBefore = Math.round((index * videoTotal) / total);
      const videosAfter = Math.round(((index + 1) * videoTotal) / total);
      return videosAfter > videosBefore ? "video" : "image";
    });
  };

  // File Handlers
  const handleRefImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setRefImage(reader.result as string);
        setRefImageName(file.name);
        addLog("Referência visual carregada: a IA estudará o estilo e aplicará essa linguagem às cenas do roteiro.", "success");
      };
      reader.onerror = () => addLog("Não foi possível ler a imagem de referência.", "error");
      reader.readAsDataURL(file);
      addLog("Imagem de referência de estilo carregada.", 'info');
    }
  };

  const handleScriptFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const normalized = raw.trim();
      setScriptText(normalized);
      const promptBlocks = parseVisualPromptBlocks(normalized);
      addLog(
        promptBlocks.length >= 1
          ? `Roteiro importado: ${file.name}. ${promptBlocks.length} prompts de cena reconhecidos automaticamente.`
          : `Roteiro importado: ${file.name}`,
        "success",
      );
    };
    reader.onerror = () => addLog("Não foi possível ler o arquivo de roteiro.", "error");
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleAnimationFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const normalized = String(reader.result || "").trim();
      setAnimationScriptText(normalized);
      const promptBlocks = parseVisualPromptBlocks(normalized);
      addLog(
        `Prompts de animação importados: ${file.name}. ${promptBlocks.length} bloco(s) reconhecido(s).`,
        promptBlocks.length > 0 ? "success" : "warning",
      );
    };
    reader.onerror = () => addLog("Não foi possível ler o arquivo de prompts de animação.", "error");
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSrtFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const cues = parseSrtCues(raw);
      if (cues.length === 0) {
        addLog(`O arquivo ${file.name} não contém blocos SRT válidos.`, "error");
        return;
      }
      setSrtText(raw);
      setSrtFileName(file.name);
      setSubtitleMode("srt-sync");
      addLog(
        `SRT carregado: ${cues.length} blocos sincronizados até ${formatTimelineTime(cues[cues.length - 1].endSeconds)}.`,
        "success",
      );
    };
    reader.onerror = () => addLog("Não foi possível ler o arquivo SRT.", "error");
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleRemoveSrt = () => {
    setSrtText("");
    setSrtFileName(null);
    if (subtitleMode === "srt-sync") setSubtitleMode("storyboard");
    addLog("SRT sincronizado removido.", "info");
  };

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAudioFile(file);
      const url = URL.createObjectURL(file);
      setAudioUrl(url);

      const audioObj = new Audio(url);
      audioObj.onloadedmetadata = () => {
        const dur = Math.round(audioObj.duration);
        if (isFinite(dur) && dur > 0) {
          setAudioDuration(dur);
          addLog(`Áudio carregado: ${file.name} (${dur}s)`, 'info');
        } else {
          addLog(`Áudio carregado: ${file.name}`, 'info');
        }
      };
      audioObj.onerror = () => {
        addLog(`Áudio carregado: ${file.name}`, 'info');
      };
    }
  };

  const handleRemoveAudio = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    setAudioFile(null);
    setAudioUrl(null);
    setAudioDuration(0);
    addLog("Áudio do Roteiro removido.", 'info');
  };

  // --- GENERATION CORE LOGIC ---

  // Helper to generate Motion Prompt for a scene
  const handleGenerateVideoPrompt = async (sceneToProcess: Scene): Promise<boolean> => {
    const service = new CineGenService();
    const sceneDuration = sceneToProcess.durationSeconds || effectiveSceneDuration;
    addLog(`Gerando Prompt de Animação de Vídeo para Cena ${sceneToProcess.time}...`, 'info');
    try {
      const motionPrompt = await service.generateVideoMotionPrompt(sceneToProcess, effectiveStyle, sceneDuration);
      setScenes(prev => prev.map(s => s.id === sceneToProcess.id ? { ...s, videoMotionPrompt: motionPrompt } : s));
      if (selectedScene?.id === sceneToProcess.id) {
        setSelectedScene(prev => prev ? { ...prev, videoMotionPrompt: motionPrompt } : null);
      }
      addLog(`Prompt de Animação da Cena ${sceneToProcess.time} gerado com sucesso!`, 'success');
      return true;
    } catch (err: any) {
      addLog(`Erro ao gerar prompt de animação da Cena ${sceneToProcess.time}: ${err.message}`, 'error');
      return false;
    }
  };

  // Helper to animate a single scene into a video clip
  const handleAnimateScene = async (sceneToProcess: Scene): Promise<boolean> => {
    const currentScene = scenes.find((scene) => scene.id === sceneToProcess.id) || sceneToProcess;
    if (!currentScene.imageUrl) {
      addLog(`A Cena ${currentScene.time} ainda não possui uma imagem para animar.`, 'warning');
      return false;
    }
    if (currentScene.videoStatus === 'generating') {
      addLog(`A Cena ${currentScene.time} já está sendo animada.`, 'warning');
      return false;
    }
    const sceneDuration = Math.min(
      Math.max(currentScene.durationSeconds || effectiveSceneDuration, 1),
      20,
    );
    addLog(`🎬 Gerando vídeo via API Sogni.ai (LTX-2.3) de ${sceneDuration.toFixed(1)}s para Cena ${sceneToProcess.time}...`, 'info');
    setScenes(prev => prev.map(s => s.id === currentScene.id ? { ...s, videoStatus: 'generating' } : s));

    try {
      const prompt = buildLtxAnimationPrompt(
        currentScene.videoMotionPrompt || DEFAULT_LOCKED_ANIMATION_PROMPT,
      );

      const videoUrl = await generateSogniVideo({
        prompt: prompt || currentScene.action,
        imageUrl: currentScene.imageUrl,
        duration: sceneDuration,
        model: "ltx23-22b-fp8_i2v_distilled",
      });
      addLog(`✨ LTX‑2.3 Image-to-Video: Cena ${sceneToProcess.time} animada pela API Sogni Unlimited.`, 'success');

      setScenes(prev => prev.map(s => s.id === currentScene.id ? {
        ...s,
        videoMotionPrompt: prompt,
        videoUrl: videoUrl,
        videoStatus: 'completed'
      } : s));

      addLog(`✅ Cena ${currentScene.time} em vídeo concluída!`, 'success');
      return true;
    } catch (err: any) {
      setScenes(prev => prev.map(s => s.id === currentScene.id ? { ...s, videoStatus: 'failed' } : s));
      addLog(`Erro ao animar Cena ${currentScene.time}: ${err.message}`, 'error');
      return false;
    }
  };

  const runGenerationLoop = async (
    scenesToProcess: Scene[],
    service: CineGenService,
    rawRefImage: string | null,
    flowId: number,
    signal: AbortSignal,
    timelineTotal: number = scenesToProcess.length,
    onSceneReady?: (scene: Scene) => Promise<void>,
  ) => {
    const total = scenesToProcess.length;
    const batchId = `flow-${flowId}-${Date.now()}-${uuid()}`;
    let generationProvider: "sogni" | "flow" =
      imageProvider === "flow" && flowConnection.connected && approveFlowCredits
        ? "flow"
        : "sogni";
    let providerFallbackLogged = false;
    if (!isFlowActive(flowId, signal)) {
      return { completedCount: 0, failedCount: 0, generatedScenes: [], cancelled: true };
    }
    addLog(
      generationProvider === "flow"
        ? `🚀 Enviando ${total} cenas para o Google Flow em fila sequencial pela aba conectada...`
        : `🚀 Disparando ${total} chamadas independentes ao motor interno (máximo de 16 imagens em paralelo)...`,
      'info',
    );

    // Mark all requested scenes as queued. A worker changes each one to
    // "generating" only when it actually starts the API request.
    setScenes(prev => prev.map(s =>
      scenesToProcess.find(b => b.id === s.id)
        ? { ...s, status: 'queued', error: undefined }
        : s
    ));

    let completedCount = 0;
    let failedCount = 0;

    // Dispatch all scenes into the queue. The semaphore inside sogniService
    // keeps at most sixteen active Sogni Unlimited image projects at a time.
    // This guarantees N scenes = N independent API calls.
    const generateOneScene = async (scene: Scene) => {
      if (!isFlowActive(flowId, signal)) {
        return { id: scene.id, imageUrl: null, imagePrompt: "", imageStylePrompt: "", motionPrompt: "", success: false };
      }
      setScenes(prev => prev.map(s =>
        s.id === scene.id ? { ...s, status: 'generating', error: undefined } : s
      ));
      try {
        const generatedFrame = await service.generateFrame(
          scene,
          rawRefImage,
          effectiveStyle,
          "Não existe personagem de referência obrigatório. A imagem enviada define somente estilo; inclua apenas personagens, veículos, objetos e lugares exigidos pelo prompt desta cena.",
          undefined,
          undefined,
          signal,
          batchId,
          Math.max(timelineTotal, scene.id + 1),
          "style",
          imageQualityMode,
          generationProvider,
          approveFlowCredits,
          (message) => {
            generationProvider = "sogni";
            if (!providerFallbackLogged) {
              providerFallbackLogged = true;
              addLog(message, "warning");
            }
          },
        );
        const imageUrl = generatedFrame.url;

        if (!isFlowActive(flowId, signal)) {
          return { id: scene.id, imageUrl: null, imagePrompt: "", imageStylePrompt: "", motionPrompt: "", success: false };
        }

        // generateFrame returns a full image URL (https://) or data: URL
        const finalUrl = imageUrl.startsWith('http') || imageUrl.startsWith('data:')
          ? imageUrl
          : `data:image/jpeg;base64,${imageUrl}`;

        const motionPrompt =
          scene.videoMotionPrompt?.trim() || DEFAULT_LOCKED_ANIMATION_PROMPT;

        // Update this scene as soon as it completes (no waiting for the whole batch)
        setScenes(prev => prev.map(s =>
          s.id === scene.id
            ? {
                ...s,
                status: 'completed',
                imageUrl: finalUrl,
                imagePrompt: generatedFrame.prompt,
                imageStylePrompt: generatedFrame.stylePrompt,
                videoMotionPrompt: motionPrompt,
              }
            : s
        ));

        completedCount++;
        addLog(`✅ [${completedCount}/${total}] Cena ${scene.time} gerada!`, 'success');

        const completedScene: Scene = {
          ...scene,
          status: "completed",
          imageUrl: finalUrl,
          imagePrompt: generatedFrame.prompt,
          imageStylePrompt: generatedFrame.stylePrompt,
          videoMotionPrompt: motionPrompt,
        };
        if (onSceneReady) {
          void onSceneReady(completedScene).catch(error => {
            addLog(
              `Falha ao encaminhar a cena ${scene.time} para a fila de vídeo: ${error?.message || error}`,
              "error",
            );
          });
        }

        return {
          id: scene.id,
          imageUrl: finalUrl,
          imagePrompt: generatedFrame.prompt,
          imageStylePrompt: generatedFrame.stylePrompt,
          motionPrompt,
          success: true,
        };
      } catch (err: any) {
        if (!isFlowActive(flowId, signal) || err?.name === "AbortError") {
          return { id: scene.id, imageUrl: null, imagePrompt: "", imageStylePrompt: "", motionPrompt: "", success: false };
        }
        setScenes(prev => prev.map(s =>
          s.id === scene.id ? { ...s, status: 'failed', error: err.message } : s
        ));
        failedCount++;
        addLog(`❌ [${failedCount} falhas] Cena ${scene.time}: ${err.message}`, 'error');
        return {
          id: scene.id,
          imageUrl: null,
          imagePrompt: "",
          imageStylePrompt: "",
          motionPrompt: "",
          success: false,
        };
      }
    };

    const runImageWorkers = async () => {
      const results: Awaited<ReturnType<typeof generateOneScene>>[] =
        new Array(scenesToProcess.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < scenesToProcess.length && isFlowActive(flowId, signal)) {
          const index = cursor++;
          results[index] = await generateOneScene(scenesToProcess[index]);
        }
      };
      const workerCount = Math.min(
        SOGNI_IMAGE_CONCURRENCY,
        scenesToProcess.length,
      );
      await Promise.all(
        Array.from({ length: workerCount }, () => worker()),
      );
      return results.filter(Boolean);
    };

    const results = generationProvider === "flow"
      ? await (async () => {
          const sequentialResults: Awaited<ReturnType<typeof generateOneScene>>[] = [];
          for (const scene of scenesToProcess) {
            if (!isFlowActive(flowId, signal)) break;
            sequentialResults.push(await generateOneScene(scene));
          }
          return sequentialResults;
        })()
      : await runImageWorkers();
    if (!isFlowActive(flowId, signal)) {
      return { completedCount, failedCount, generatedScenes: [], cancelled: true };
    }
    const generatedScenes = scenesToProcess
      .map((scene) => {
        const result = results.find((item) => item.id === scene.id);
        return result?.success && result.imageUrl
          ? {
              ...scene,
              imageUrl: result.imageUrl,
              imagePrompt: result.imagePrompt,
              imageStylePrompt: result.imageStylePrompt,
              videoMotionPrompt: result.motionPrompt,
              status: "completed" as const,
            }
          : null;
      })
      .filter(Boolean) as Scene[];

    addLog(`🎬 Geração concluída: ${completedCount} imagens geradas, ${failedCount} falhas.`, completedCount > 0 ? 'success' : 'error');
    return { completedCount, failedCount, generatedScenes, cancelled: false };
  };

  const runVideoGenerationLoop = async (
    sceneList: Scene[],
    service: CineGenService,
    flowId: number,
    signal: AbortSignal,
    pipelined: boolean = false,
  ) => {
    const candidates = sceneList.filter((scene) => scene.imageUrl);
    if (candidates.length === 0) return { completedCount: 0, failedCount: 0 };
    if (!isFlowActive(flowId, signal)) {
      return { completedCount: 0, failedCount: 0 };
    }

    const candidateIds = new Set(candidates.map(scene => scene.id));
    setScenes(previous => previous.map(scene =>
      candidateIds.has(scene.id) &&
      scene.videoStatus !== "generating" &&
      scene.videoStatus !== "completed"
        ? { ...scene, videoStatus: "queued" }
        : scene
    ));

    if (!pipelined) {
      setIsGeneratingVideos(true);
      setStage(ProcessingStage.ANIMATING_VIDEOS);
    }
    addLog(`Iniciando animação por IA de ${candidates.length} cenas (máximo de ${SOGNI_VIDEO_CONCURRENCY} vídeos em paralelo).`, "info");

    let cursor = 0;
    let completedCount = 0;
    let failedCount = 0;
    if (candidates.some((scene) => (scene.durationSeconds || effectiveSceneDuration) > 20)) {
      addLog("Vídeos por IA acima de 20s serão limitados a 20s; o tempo completo continuará preservado na timeline SRT.", "warning");
    }

    const worker = async () => {
      while (cursor < candidates.length && isFlowActive(flowId, signal)) {
        const scene = candidates[cursor++];
        const duration = Math.min(
          Math.max(scene.durationSeconds || effectiveSceneDuration, 1),
          20,
        );
        setScenes((previous) => previous.map((item) =>
          item.id === scene.id ? { ...item, videoStatus: "generating" } : item
        ));

        try {
          const animationDirection =
            scene.videoMotionPrompt?.trim() || DEFAULT_LOCKED_ANIMATION_PROMPT;
          const motionPrompt = buildLtxAnimationPrompt(animationDirection);
          const videoUrl = await generateSogniVideo({
            prompt: motionPrompt,
            imageUrl: scene.imageUrl,
            duration,
            signal,
          });
          if (!isFlowActive(flowId, signal)) return;
          completedCount++;
          setScenes((previous) => previous.map((item) =>
            item.id === scene.id
              ? { ...item, videoMotionPrompt: motionPrompt, videoUrl, videoStatus: "completed" }
              : item
          ));
          addLog(`Vídeo ${completedCount}/${candidates.length}: cena ${scene.time} animada.`, "success");
        } catch (error: any) {
          if (!isFlowActive(flowId, signal) || error?.name === "AbortError") return;
          failedCount++;
          setScenes((previous) => previous.map((item) =>
            item.id === scene.id ? { ...item, videoStatus: "failed" } : item
          ));
          addLog(`Falha no vídeo da cena ${scene.time}: ${error?.message || "erro desconhecido"}`, "error");
        }
      }
    };

    const videoWorkers = Math.min(SOGNI_VIDEO_CONCURRENCY, candidates.length);
    await Promise.all(Array.from({ length: videoWorkers }, () => worker()));
    if (!isFlowActive(flowId, signal)) {
      return { completedCount, failedCount };
    }
    if (!pipelined) setIsGeneratingVideos(false);
    addLog(`Animação por IA concluída: ${completedCount} vídeos, ${failedCount} falhas.`, failedCount ? "warning" : "success");
    return { completedCount, failedCount };
  };

  const createVideoPipelineScheduler = (
    service: CineGenService,
    flowId: number,
    signal: AbortSignal,
  ) => {
    // Cada fila inicia um projeto LTX independente; o semáforo do serviço
    // confirma que até quatro chamadas de vídeo ficam ativas ao mesmo tempo.
    const laneCount = SOGNI_VIDEO_CONCURRENCY;
    const lanes: Promise<void>[] = Array.from({ length: laneCount }, () => Promise.resolve());
    let nextLane = 0;
    let completedCount = 0;
    let failedCount = 0;
    let queuedCount = 0;

    return {
      enqueue(scene: Scene): Promise<void> {
        if (scene.mediaType !== "video" || !scene.imageUrl) return Promise.resolve();
        setScenes(previous => previous.map(item =>
          item.id === scene.id ? { ...item, videoStatus: "queued" } : item
        ));
        if (queuedCount === 0) {
          setIsGeneratingVideos(true);
          addLog("Fluxo encadeado ativo: cada cena V será animada assim que seu quadro ficar pronto.", "info");
        }
        queuedCount++;
        const laneIndex = nextLane++ % laneCount;
        const task = lanes[laneIndex].then(async () => {
          if (!isFlowActive(flowId, signal)) return;
          const result = await runVideoGenerationLoop([scene], service, flowId, signal, true);
          completedCount += result.completedCount;
          failedCount += result.failedCount;
        });
        const safeTask = task.catch((error) => {
          failedCount++;
          addLog(`Falha inesperada na fila de vídeo da cena ${scene.time}: ${error?.message || error}`, "error");
        });
        lanes[laneIndex] = safeTask;
        return safeTask;
      },
      async drain() {
        await Promise.all(lanes);
        setIsGeneratingVideos(false);
        return { completedCount, failedCount, queuedCount };
      },
    };
  };

  // --- PIPELINE ---

  const startPipeline = async () => {
    if (!scriptText.trim() && !audioFile && srtCues.length === 0) {
      addLog("Erro: forneça prompts/roteiro, um arquivo de áudio ou um SRT.", 'error');
      return;
    }
    if (subtitleMode === "audio" && !audioFile) {
      addLog("Modo por áudio selecionado, mas nenhum áudio foi carregado.", "error");
      return;
    }
    if ((subtitleMode === "script" || subtitleMode === "text-srt-8") && !scriptText.trim()) {
      addLog("Modo por roteiro selecionado, mas o roteiro está vazio.", "error");
      return;
    }
    if (subtitleMode === "srt-sync" && srtCues.length === 0) {
      addLog("Modo SRT sincronizado selecionado, mas nenhum SRT válido foi carregado.", "error");
      return;
    }
    if (imageProvider === "flow" && (!flowConnection.connected || !approveFlowCredits)) {
      addLog(
        !flowConnection.connected
          ? "Google Flow não está conectado. O projeto continuará automaticamente no motor interno Sogni/Krea."
          : "O uso de créditos do Flow não foi autorizado. O projeto continuará automaticamente no motor interno Sogni/Krea.",
        "warning",
      );
    }
    const { flowId, controller } = beginFlow();
    const ensureFlowActive = () => {
      if (!isFlowActive(flowId, controller.signal)) {
        throw new DOMException("Fluxo cancelado pelo usuário.", "AbortError");
      }
    };
    const service = new CineGenService();
    setStage(ProcessingStage.ANALYZING_AUDIO);
    setScenes([]); // Clear previous run
    setCapCutDraftPath(null);
    setSynchronizationProgress(0);
    setSynchronizationMessage("");

    let currentScript = scriptText;

    try {
      // 1. Transcription (if Audio present)
      if (audioFile && srtCues.length === 0) {
        setStage(ProcessingStage.TRANSCRIBING);
        addLog(`Transcrevendo automaticamente ${audioFile.name} com Gemini 3.6 Flash...`, "info");
        
        try {
          const transcribed = await service.transcribeAudio(audioFile, controller.signal);
          ensureFlowActive();
          if (transcribed && transcribed.trim().length > 0) {
            currentScript = transcribed;
            setScriptText(currentScript);
            addLog("Transcrição do áudio concluída com sucesso.", 'success');
          } else {
            addLog("A transcrição não retornou texto; será usado somente um roteiro real informado pelo usuário.", 'warning');
            if (/^Cenas narradas sincronizadas com o áudio/i.test(currentScript.trim())) {
              currentScript = "";
              setScriptText("");
            }
          }
        } catch (audioErr: any) {
          if (audioErr?.name === "AbortError") throw audioErr;
          throw new Error(`A geração foi interrompida porque o áudio não pôde ser transcrito: ${audioErr.message}`);
        }
      } else if (audioFile && srtCues.length > 0) {
        addLog(
          `Áudio e SRT vinculados: a transcrição foi dispensada porque ${srtCues.length} blocos já possuem tempos reais.`,
          "success",
        );
      }

      // Never invent a generic script from audio: it creates dozens of nearly
      // identical prompts and wastes image jobs.
      if ((!currentScript || currentScript.trim().length === 0) && srtCues.length === 0) {
        throw new Error(
          "Não foi possível transcrever o áudio pelo Gemini. Verifique a GEMINI_API_KEY no .env.local ou cole/importe o roteiro."
        );
      }

      // 2. Breakdown
      setStage(ProcessingStage.SCRIPTING);
      
      const targetCount =
        srtCues.length > 0
          ? srtCues.length
          : subtitleMode === "storyboard" && audioDuration > 0 && sceneInterval > 0
          ? Math.max(1, Math.ceil(audioDuration / effectiveSceneDuration))
          : undefined;
      addLog(
        srtCues.length > 0
          ? `SRT ativo: ${srtCues.length} blocos de legenda com tempos reais; as cenas visuais serão alinhadas à duração do áudio.`
          : targetCount
          ? `O áudio definiu ${targetCount} cenas; distribuição selecionada: ${videoPercentage}% vídeo e ${imagePercentage}% imagem.`
          : `A quantidade de cenas será definida pelo roteiro; distribuição selecionada: ${videoPercentage}% vídeo e ${imagePercentage}% imagem.`,
        "info",
      );

      addLog("Gerando decupagem de cenas a partir do roteiro...", 'info');
      const structuredPrompts = parseStructuredPromptBlocks(currentScript);
      const explicitSceneHeadingCount = countExplicitSceneHeadings(currentScript);
      if (
        explicitSceneHeadingCount > 0 &&
        structuredPrompts.length !== explicitSceneHeadingCount
      ) {
        throw new Error(
          `Proteção do roteiro: encontrei ${explicitSceneHeadingCount} cabeçalhos CENA, mas reconheci ${structuredPrompts.length} prompts completos. Nenhuma imagem ou vídeo foi solicitado. Revise apenas os blocos sem conteúdo.`,
        );
      }
      const visualPromptBlocks = currentScript.trim()
        ? parseVisualPromptBlocks(currentScript)
        : [];
      const animationPromptBlocks = animationScriptText.trim()
        ? parseVisualPromptBlocks(animationScriptText)
        : [];
      if (
        srtCues.length > 0 &&
        currentScript.trim() &&
        visualPromptBlocks.length === 0
      ) {
        throw new Error(
          "O SRT foi reconhecido, mas o arquivo de prompts não possui blocos identificáveis. Numere os prompts ou use cabeçalhos CENA.",
        );
      }
      if (srtCues.length > 0 && visualPromptBlocks.length > srtCues.length) {
        throw new Error(
          `Há ${visualPromptBlocks.length} prompts visuais para ${srtCues.length} blocos SRT. Para manter tempos exatos, use no máximo um prompt por bloco de legenda.`,
        );
      }

      const directPromptMode = sceneInterval === 0 && !audioFile && srtCues.length === 0;
      const directPrompts = directPromptMode ? parsePromptListBlocks(currentScript) : [];
      let rawScenes: Omit<Scene, "id" | "status">[];
      if (srtCues.length > 0) {
        const visualSceneCount =
          visualPromptBlocks.length > 0
            ? visualPromptBlocks.length
            : srtCues.length;
        rawScenes = Array.from({ length: visualSceneCount }, (_, index) => {
          const cueStartIndex = Math.floor((index * srtCues.length) / visualSceneCount);
          const nextCueIndex = Math.floor(((index + 1) * srtCues.length) / visualSceneCount);
          const cueEndExclusive = Math.max(cueStartIndex + 1, nextCueIndex);
          const groupedCues = srtCues.slice(cueStartIndex, cueEndExclusive);
          const firstCue = groupedCues[0];
          const lastCue = groupedCues[groupedCues.length - 1];
          const visualPrompt = visualPromptBlocks[index];
          const startSeconds = firstCue.startSeconds;
          const endSeconds = lastCue.endSeconds;

          return {
            time: formatTimelineTime(startSeconds),
            startSeconds,
            endSeconds,
            sourceCueStart: firstCue.index,
            sourceCueEnd: lastCue.index,
            durationSeconds: Math.max(0.1, endSeconds - startSeconds),
            subtitle: groupedCues.map((cue) => cue.text).join(" "),
            action:
              visualPrompt?.prompt ||
              groupedCues.map((cue) => cue.text).join(" "),
            mediaType: visualPrompt?.mediaType,
          };
        });
      } else {
        rawScenes = directPromptMode
          ? service.generateDirectPromptBreakdown(currentScript, effectiveSceneDuration)
          : structuredPrompts.length >= 2
          ? service.generatePromptBlockBreakdown(
              currentScript,
              subtitleMode === "text-srt-8" ? 8 : effectiveSceneDuration,
            )
          : subtitleMode === "text-srt-8"
            ? service.generateTextSrtBreakdown(currentScript, 8)
            : subtitleMode === "storyboard"
              ? await service.generateSceneBreakdown(currentScript, targetCount, effectiveSceneDuration)
              : await service.generateSubtitleBreakdown(currentScript, targetCount, effectiveSceneDuration);
      }
      if (animationPromptBlocks.length > 0) {
        rawScenes = rawScenes.map((scene, index) => ({
          ...scene,
          videoMotionPrompt:
            animationPromptBlocks[index]?.prompt?.trim() ||
            scene.videoMotionPrompt,
        }));
        const matched = Math.min(rawScenes.length, animationPromptBlocks.length);
        addLog(
          `${matched} prompt(s) de animação associado(s) às cenas na mesma ordem. ` +
          (matched < rawScenes.length
            ? `${rawScenes.length - matched} cena(s) sem prompt manual permanecerão imóveis, sem movimento inventado.`
            : "O LTX‑2.3 usará os comandos manuais, sem reutilizar o prompt da imagem."),
          matched === rawScenes.length ? "success" : "warning",
        );
        if (animationPromptBlocks.length > rawScenes.length) {
          addLog(
            `${animationPromptBlocks.length - rawScenes.length} prompt(s) de animação excedente(s) foram ignorados.`,
            "warning",
          );
        }
      }
      ensureFlowActive();
      if (srtCues.length > 0) {
        addLog(
          visualPromptBlocks.length > 0
            ? `Sincronização pronta: ${visualPromptBlocks.length} cenas visuais distribuídas sobre ${srtCues.length} blocos SRT, preservando toda a duração.`
            : `Sincronização pronta: ${srtCues.length} blocos SRT transformados em cenas visuais 1:1.`,
          "success",
        );
      } else if (directPromptMode) {
        addLog(
          `Modo sem corte: ${directPrompts.length} prompt(s) preservado(s), um por cena, sem divisão automática nem reescrita.`,
          "success",
        );
      } else if (structuredPrompts.length >= 2) {
        addLog(
          `Roteiro estruturado reconhecido: ${rawScenes.length} prompts, cada bloco preservado como uma cena independente.`,
          "success",
        );
      } else if (subtitleMode === "text-srt-8") {
        addLog(`SRT de texto concluído: ${rawScenes.length} cenas fixas de 8 segundos, na ordem do roteiro.`, "success");
      } else if (subtitleMode !== "storyboard") {
        const sourceLabel = subtitleMode === "audio" ? "áudio" : subtitleMode === "script" ? "roteiro" : "áudio/roteiro";
        addLog(`Modo SRT ativo: legendas sincronizadas por ${sourceLabel}, uma por cena.`, "success");
      }
      
      const mediaPlan = buildMediaPlan(rawScenes.length, videoPercentage);
      const resolvedMediaPlan = rawScenes.map(
        (scene, index) => scene.mediaType || mediaPlan[index],
      );
      if (rawScenes.length > 250) {
        throw new Error(
          `Proteção de segurança: a divisão produziu ${rawScenes.length} cenas. Revise os separadores; o sistema não iniciará mais de 250 chamadas automaticamente.`,
        );
      }
      const initialScenes: Scene[] = rawScenes.map((s, idx) => ({
        ...s,
        action: s.action.trim(),
        subtitle: s.subtitle?.trim() || undefined,
        id: idx,
        mediaType: resolvedMediaPlan[idx],
        status: 'pending',
        videoStatus: resolvedMediaPlan[idx] === "video" ? "idle" : undefined,
      }));
      setScenes(initialScenes);
      const plannedVideoCount = resolvedMediaPlan.filter(type => type === "video").length;
      const plannedImageCount = resolvedMediaPlan.length - plannedVideoCount;
      addLog(
        `Decupagem concluída: ${initialScenes.length} cenas (${plannedVideoCount} vídeo, ${plannedImageCount} imagem).`,
        "success",
      );

      // 3. Image Generation Loop
      setStage(ProcessingStage.GENERATING_IMAGES);
      const rawRefImage = refImage;
      addLog(
        imageQualityMode === "studio"
          ? "Qualidade máxima ativa: quadros em 1920×1080, direção sensível à cena e acabamento detalhado."
          : "Modo rápido ativo: quadros em 1280×720 com menor tempo de geração.",
        "info",
      );
      if (rawRefImage) {
        addLog(
          "Referência de estilo ativa: técnica, cores e acabamento serão mantidos; o conteúdo continuará vindo de cada cena do roteiro.",
          "info",
        );
      }
      addLog(
        "Cada prompt do roteiro controla o conteúdo da cena; o prompt de estilo e a referência visual controlam somente a aparência.",
        "info"
      );

      const videoScheduler = createVideoPipelineScheduler(
        service,
        flowId,
        controller.signal,
      );
      const generation = await runGenerationLoop(
        initialScenes,
        service,
        rawRefImage,
        flowId,
        controller.signal,
        initialScenes.length,
        scene => videoScheduler.enqueue(scene),
      );
      ensureFlowActive();

      const videoGeneration = await videoScheduler.drain();
      const videoFailedCount = videoGeneration.failedCount;
      ensureFlowActive();

      setStage(ProcessingStage.COMPLETED);
      if (generation.failedCount === 0 && videoFailedCount === 0) {
        addLog(
          `Projeto concluído: ${plannedImageCount} imagem(ns) e ${plannedVideoCount} vídeo(s) processados.`,
          "success",
        );
      } else {
        addLog(
          `${generation.failedCount} quadro(s) e ${videoFailedCount} vídeo(s) falharam. Use as opções de nova tentativa para concluir.`,
          'warning'
        );
      }

    } catch (error: any) {
      if (error?.name === "AbortError") return;
      addLog(`Erro no Fluxo: ${error.message}`, 'error');
      setStage(ProcessingStage.IDLE);
    } finally {
      if (activeFlowAbortRef.current === controller) {
        activeFlowAbortRef.current = null;
      }
    }
  };

  // --- REGENERATION HANDLERS ---

  const handleRetryFailed = async () => {
    const failedScenes = scenes.filter(s => s.status === 'failed');
    if (failedScenes.length === 0) {
        addLog("Nenhuma cena com falha para tentar novamente.", 'info');
        return;
    }

    const { flowId, controller } = beginFlow();
    addLog(`Tentando gerar novamente ${failedScenes.length} cenas que falharam...`, 'warning');
    setStage(ProcessingStage.GENERATING_IMAGES);
    
    const service = new CineGenService();
    const rawRefImage = refImage;
    const videoScheduler = createVideoPipelineScheduler(service, flowId, controller.signal);

    try {
      await runGenerationLoop(
        failedScenes,
        service,
        rawRefImage,
        flowId,
        controller.signal,
        scenes.length,
        scene => videoScheduler.enqueue(scene),
      );
      await videoScheduler.drain();
      if (isFlowActive(flowId, controller.signal)) {
        setStage(ProcessingStage.COMPLETED);
        addLog("Reprocessamento de tentativas concluído.", 'success');
      }
    } finally {
      if (activeFlowAbortRef.current === controller) {
        activeFlowAbortRef.current = null;
      }
    }
  };

  const handleRegenerateSingle = async (requestedScene: Scene): Promise<boolean> => {
      const sceneToRegen = scenes.find((scene) => scene.id === requestedScene.id) || requestedScene;
      if (sceneToRegen.status === 'generating') {
        addLog(`A Cena ${sceneToRegen.time} já está sendo gerada.`, 'warning');
        return false;
      }
      if (activeFlowAbortRef.current) {
        addLog("Há um fluxo em andamento. Cancele-o antes de regerar apenas uma cena.", 'warning');
        return false;
      }
      const { flowId, controller } = beginFlow();
      addLog(`Regerando quadro individual: ${sceneToRegen.time}`, 'info');
      setStage(ProcessingStage.GENERATING_IMAGES);
      
      const service = new CineGenService();
      const rawRefImage = refImage;
      const videoScheduler = createVideoPipelineScheduler(service, flowId, controller.signal);

      // Re-use loop logic but for array of 1
      try {
        const generation = await runGenerationLoop(
          [sceneToRegen],
          service,
          rawRefImage,
          flowId,
          controller.signal,
          scenes.length,
          scene => videoScheduler.enqueue(scene),
        );
        await videoScheduler.drain();
        if (isFlowActive(flowId, controller.signal)) {
          setStage(ProcessingStage.COMPLETED);
          return generation.completedCount === 1;
        }
        return false;
      } catch (err: any) {
        addLog(`Erro ao regerar Cena ${sceneToRegen.time}: ${err?.message || 'erro desconhecido'}`, 'error');
        return false;
      } finally {
        if (activeFlowAbortRef.current === controller) {
          activeFlowAbortRef.current = null;
        }
      }
  };

  const handleAnimateReadyScenes = async () => {
    const readyScenes = scenes.filter(
      scene =>
        scene.mediaType === "video" &&
        scene.status === "completed" &&
        scene.imageUrl &&
        !scene.videoUrl,
    );
    const { flowId, controller } = beginFlow();
    try {
      await runVideoGenerationLoop(
        readyScenes,
        new CineGenService(),
        flowId,
        controller.signal,
      );
      if (isFlowActive(flowId, controller.signal)) {
        setStage(ProcessingStage.COMPLETED);
      }
    } finally {
      if (activeFlowAbortRef.current === controller) {
        activeFlowAbortRef.current = null;
      }
    }
  };

  const safeProjectName = (projectName.trim() || "Minha História")
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const mediaUrlToBlob = async (
    url: string,
    expectedType: "image" | "video",
  ): Promise<Blob> => {
    const isRemoteMedia = /^https?:\/\//i.test(url);
    const proxyPath = `/api/cinegen/media?url=${encodeURIComponent(url)}`;
    const downloadUrls = isRemoteMedia
      ? Array.from(
          new Set([
            proxyPath,
            `http://127.0.0.1:3006${proxyPath}`,
          ]),
        )
      : [url];
    let lastError: Error | null = null;

    for (const downloadUrl of downloadUrls) {
      try {
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ao baixar mídia.`);
        }
        const contentType = (response.headers.get("content-type") || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!contentType.startsWith(`${expectedType}/`)) {
          throw new Error(
            `Resposta inválida: era esperado ${expectedType}, mas o servidor retornou ${contentType || "tipo desconhecido"}.`,
          );
        }
        const blob = await response.blob();
        if (blob.size < 1024) {
          throw new Error(`Mídia incompleta: apenas ${blob.size} bytes recebidos.`);
        }
        return blob;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError || new Error("Falha ao baixar mídia.");
  };

  const extensionForBlob = (blob: Blob, fallback: string) => {
    const extensions: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/mp4": "m4a",
    };
    return extensions[blob.type] || fallback;
  };

  const handleSynchronizeProject = async (): Promise<boolean> => {
    if (isSynchronizingProject) return false;
    if (!audioFile) {
      addLog("Carregue a narração para preparar o rascunho do CapCut.", "warning");
      return false;
    }
    const availableScenes = scenes.filter(scene => (
      scene.status === "completed" && Boolean(scene.imageUrl || scene.videoUrl)
    ));
    if (availableScenes.length !== scenes.length || scenes.length === 0) {
      addLog(
        `A sincronização precisa de todas as cenas prontas. Disponíveis: ${availableScenes.length}/${scenes.length}.`,
        "warning",
      );
      return false;
    }

    synchronizationAbortRef.current?.abort();
    const controller = new AbortController();
    synchronizationAbortRef.current = controller;
    setCapCutDraftPath(null);
    setSynchronizationProgress(0);
    setSynchronizationMessage("Preparando o rascunho do CapCut...");
    setIsSynchronizingProject(true);
    addLog(
      "Sincronização iniciada: as cenas e a narração serão copiadas diretamente para um novo rascunho do CapCut, nos tempos exatos do SRT.",
      "info",
    );

    try {
      const result = await prepareCapCutDraft({
        projectName: safeProjectName,
        scenes,
        audioFile,
        audioDurationSeconds: audioDuration,
        srtText: srtText.trim() || generateSrtSubtitles(scenes, effectiveSceneDuration),
        fallbackDurationSeconds: effectiveSceneDuration,
        width: imageQualityMode === "studio" ? 1920 : 1280,
        height: imageQualityMode === "studio" ? 1080 : 720,
        signal: controller.signal,
        onProgress: (progress, message) => {
          setSynchronizationProgress(progress);
          setSynchronizationMessage(message);
        },
      });
      if (!controller.signal.aborted) {
        setCapCutDraftPath(result.projectPath);
        setSynchronizationProgress(100);
        setSynchronizationMessage(`Rascunho pronto: ${result.projectName}`);
        addLog(
          `Projeto criado diretamente no CapCut com ${result.sceneCount} cena(s): ${result.projectPath}`,
          "success",
        );
        return true;
      }
      return false;
    } catch (error: any) {
      if (error?.name === "AbortError") {
        setSynchronizationMessage("Sincronização cancelada.");
        addLog("Preparação do CapCut cancelada pelo usuário.", "warning");
      } else {
        setSynchronizationMessage("Falha na sincronização.");
        addLog(`Falha ao preparar o CapCut: ${error?.message || "erro desconhecido"}`, "error");
      }
      return false;
    } finally {
      if (synchronizationAbortRef.current === controller) {
        synchronizationAbortRef.current = null;
      }
      setIsSynchronizingProject(false);
    }
  };

  const cancelSynchronization = () => {
    synchronizationAbortRef.current?.abort();
  };

  // Único ponto de exportação: sempre baixa um pacote completo e organizado.
  const downloadZip = async () => {
    if (isExportingProject) return;
    setIsExportingProject(true);
    addLog("Preparando o projeto completo para download...", "info");

    try {
      const zip = new JSZip();
      const folder = zip.folder(safeProjectName);
      if (!folder) throw new Error("Não foi possível criar a pasta do projeto.");

      const exportedAt = new Date().toISOString();
      const sceneManifest = scenes.map((scene, index) => ({
        numero: index + 1,
        id: scene.id,
        tipoSaida: scene.mediaType === "video" ? "V - vídeo" : "I - imagem",
        tempo: scene.time,
        inicioSegundos: scene.startSeconds ?? null,
        fimSegundos: scene.endSeconds ?? null,
        duracaoSegundos: scene.durationSeconds || effectiveSceneDuration,
        blocosSrt: scene.sourceCueStart
          ? `${scene.sourceCueStart}-${scene.sourceCueEnd || scene.sourceCueStart}`
          : null,
        fala: scene.subtitle || "",
        descricao: scene.action,
        promptImagem: scene.imagePrompt || "",
        promptEstilo: scene.imageStylePrompt || "",
        promptAnimacao: scene.videoMotionPrompt || "",
        imagemGerada: Boolean(scene.imageUrl),
        videoGerado: Boolean(scene.videoUrl),
        status: scene.status,
        erro: scene.error || null,
      }));

      folder.file("00_PROJETO.json", JSON.stringify({
        nome: safeProjectName,
        exportadoEm: exportedAt,
        estiloVisual: effectiveStyle,
        presetVisual: selectedStyle,
        promptVisualPersonalizado: customStylePrompt,
        personagemReferencia: Boolean(refImage),
        modoCenas: subtitleMode,
        modoEdicao: "distribuição mista V/I",
        porcentagemVideo: videoPercentage,
        porcentagemImagem: imagePercentage,
        qualidadeImagem: imageQualityMode === "studio"
          ? "Máxima — 1920x1080, 8 passos Turbo e direção por cena"
          : "Rápida — 1280x720, 8 passos",
        videosPlanejados: scenes.filter(scene => scene.mediaType === "video").length,
        imagensPlanejadas: scenes.filter(scene => scene.mediaType !== "video").length,
        intervaloSegundos: sceneInterval,
        modoSemCorte: sceneInterval === 0,
        duracaoAudioSegundos: audioDuration,
        srtOriginal: Boolean(srtText),
        totalBlocosSrt: srtCues.length,
        duracaoSrtSegundos: srtDuration,
        totalCenas: scenes.length,
        cenas: sceneManifest,
      }, null, 2));
      folder.file("01_PROMPTS_VISUAIS.txt", scriptText || "Prompts visuais não informados; foram usadas as falas do SRT.");
      folder.file(
        "02_PROMPTS_ANIMACAO_LTX.txt",
        animationScriptText || "Prompts de animação não informados; as cenas sem comando manual permaneceram imóveis.",
      );
      folder.file(
        "03_LEGENDAS.srt",
        srtText.trim() || generateSrtSubtitles(scenes, effectiveSceneDuration),
      );
      folder.file("04_CENAS.json", JSON.stringify(sceneManifest, null, 2));
      const csvCell = (value: unknown) =>
        `"${String(value ?? "").replace(/"/g, '""')}"`;
      folder.file(
        "05_TIMELINE_SINCRONIZADA.csv",
        [
          [
            "cena",
            "inicio_segundos",
            "fim_segundos",
            "duracao_segundos",
            "bloco_srt_inicial",
            "bloco_srt_final",
            "tipo",
            "fala",
            "arquivo_base",
          ].map(csvCell).join(","),
          ...scenes.map((scene, index) => {
            const number = String(index + 1).padStart(4, "0");
            const start = scene.startSeconds ?? index * effectiveSceneDuration;
            const end =
              scene.endSeconds ??
              start + (scene.durationSeconds || effectiveSceneDuration);
            return [
              index + 1,
              start.toFixed(3),
              end.toFixed(3),
              (end - start).toFixed(3),
              scene.sourceCueStart || "",
              scene.sourceCueEnd || "",
              scene.mediaType === "video" ? "video" : "imagem",
              scene.subtitle || "",
              `cena_${number}_${scene.time.replace(/:/g, "-")}`,
            ].map(csvCell).join(",");
          }),
        ].join("\n"),
      );
      folder.file(
        "05_LEIA-ME.txt",
        [
          `Projeto: ${safeProjectName}`,
          `Exportado em: ${exportedAt}`,
          `Sincronização: ${srtCues.length > 0 ? `${srtCues.length} blocos do SRT original` : "gerada pelas cenas"}`,
          "",
          "PASTAS",
          "- cenas_imagens: imagens numeradas na ordem da história",
          "- cenas_videos: saídas finais das cenas V",
          "- prompts: descrição, fala e prompts usados em cada cena",
          "- audio: narração original, quando carregada",
          "- referencia: imagem de personagem/estilo, quando carregada",
          "",
          "O arquivo 05_TIMELINE_SINCRONIZADA.csv informa o segundo exato de entrada e saída de cada cena.",
          "O arquivo 03_LEGENDAS.srt preserva todos os blocos e timestamps do SRT enviado.",
          "Para receber a timeline já montada, use “Preparar no CapCut”. Essa ação cria um rascunho direto na pasta local do CapCut sem renderizar vídeo final.",
          "",
          "Os nomes começam com o número da cena para preservar a ordem correta.",
        ].join("\n")
      );

      const promptsFolder = folder.folder("prompts");
      const imagesFolder = folder.folder("cenas_imagens");
      const videosFolder = folder.folder("cenas_videos");
      let mediaCount = 0;
      const mediaFailures: string[] = [];

      for (const [idx, scene] of scenes.entries()) {
        const sceneNumber = String(idx + 1).padStart(4, "0");
        const time = scene.time.replace(/:/g, "-");
        const baseName = `cena_${sceneNumber}_${time}`;

        promptsFolder?.file(
          `${baseName}.txt`,
          [
            `CENA ${sceneNumber}`,
            `Tempo: ${scene.time}`,
            `Início exato: ${scene.startSeconds ?? "definido pelo intervalo"}s`,
            `Fim exato: ${scene.endSeconds ?? "definido pelo intervalo"}s`,
            `Duração: ${scene.durationSeconds || effectiveSceneDuration}s`,
            `Blocos SRT: ${scene.sourceCueStart
              ? `${scene.sourceCueStart} a ${scene.sourceCueEnd || scene.sourceCueStart}`
              : "não vinculados"}`,
            "",
            `Fala/legenda:\n${scene.subtitle || "Sem fala"}`,
            "",
            `Descrição visual:\n${scene.action}`,
            "",
            `Prompt da imagem:\n${scene.imagePrompt || "Não registrado"}`,
            "",
            `Estilo visual:\n${scene.imageStylePrompt || effectiveStyle}`,
            "",
            `Prompt de animação:\n${scene.videoMotionPrompt || "Não gerado"}`,
          ].join("\n")
        );

        if (scene.mediaType !== "video") {
          if (!scene.imageUrl || !imagesFolder) {
            mediaFailures.push(`cena ${idx + 1}: imagem ausente`);
          } else {
            try {
              const imageBlob = await mediaUrlToBlob(scene.imageUrl, "image");
              imagesFolder.file(`${baseName}.${extensionForBlob(imageBlob, "jpg")}`, imageBlob);
              mediaCount++;
            } catch (error: any) {
              mediaFailures.push(
                `cena ${idx + 1}: ${error?.message || "falha ao baixar imagem"}`,
              );
            }
          }
        }

        if (scene.mediaType === "video") {
          if (!scene.videoUrl || !videosFolder) {
            mediaFailures.push(`cena ${idx + 1}: vídeo ausente`);
          } else {
            try {
              const videoBlob = await mediaUrlToBlob(scene.videoUrl, "video");
              videosFolder.file(`${baseName}.${extensionForBlob(videoBlob, "mp4")}`, videoBlob);
              mediaCount++;
            } catch (error: any) {
              mediaFailures.push(
                `cena ${idx + 1}: ${error?.message || "falha ao baixar vídeo"}`,
              );
            }
          }
        }
      }

      if (audioFile) {
        const audioFolder = folder.folder("audio");
        const originalExtension = audioFile.name.includes(".")
          ? audioFile.name.split(".").pop() || extensionForBlob(audioFile, "mp3")
          : extensionForBlob(audioFile, "mp3");
        audioFolder?.file(`narracao_original.${originalExtension}`, audioFile);
      }

      if (refImage) {
        try {
          const referenceBlob = await mediaUrlToBlob(refImage, "image");
          folder.folder("referencia")?.file(
            `referencia_personagem_estilo.${extensionForBlob(referenceBlob, "png")}`,
            referenceBlob
          );
        } catch (error: any) {
          addLog(`A referência não pôde ser incluída: ${error?.message || "erro"}`, "warning");
        }
      }

      if (mediaFailures.length > 0) {
        const preview = mediaFailures.slice(0, 3).join("; ");
        const remaining = mediaFailures.length - 3;
        throw new Error(
          `Exportação cancelada para não criar arquivos danificados: ${preview}${
            remaining > 0 ? `; e mais ${remaining} falha(s)` : ""
          }.`,
        );
      }

      if (mediaCount !== scenes.length || mediaCount === 0) {
        throw new Error(
          `Exportação incompleta bloqueada: ${mediaCount}/${scenes.length} mídias válidas.`,
        );
      }

      const blob = await zip.generateAsync({ type: "blob", streamFiles: true });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeProjectName}_PROJETO_COMPLETO.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

      addLog(`Projeto completo baixado: ${mediaCount} arquivo(s) de mídia e ${scenes.length} cena(s).`, "success");
    } catch (e: any) {
      addLog(`Falha ao baixar projeto: ${e.message}`, "error");
    } finally {
      setIsExportingProject(false);
    }
  };

  const handleSceneClick = (scene: Scene) => {
    setSelectedScene(scene);
  };

  const modalScene = selectedScene
    ? scenes.find((scene) => scene.id === selectedScene.id) || selectedScene
    : null;
  const modalSceneIndex = modalScene
    ? scenes.findIndex((scene) => scene.id === modalScene.id)
    : -1;

  const navigateModalScene = (direction: -1 | 1) => {
    if (modalSceneIndex < 0) return;
    const nextScene = scenes[modalSceneIndex + direction];
    if (nextScene) setSelectedScene(nextScene);
  };

  const completedImages = scenes.filter(
    scene => scene.mediaType !== "video" && scene.status === "completed",
  ).length;
  const completedVideos = scenes.filter((scene) => scene.videoStatus === "completed").length;
  const completedOutputs = completedImages + completedVideos;
  const projectProgress = scenes.length === 0
    ? 0
    : Math.round((completedOutputs / scenes.length) * 100);
  const stageLabel: Record<ProcessingStage, string> = {
    [ProcessingStage.IDLE]: "Pronto para iniciar",
    [ProcessingStage.ANALYZING_AUDIO]: "Analisando áudio",
    [ProcessingStage.TRANSCRIBING]: "Transcrevendo com Gemini",
    [ProcessingStage.SCRIPTING]: "Dividindo o roteiro",
    [ProcessingStage.GENERATING_IMAGES]: "Gerando imagens",
    [ProcessingStage.GENERATING_VIDEO_PROMPTS]: "Criando movimentos",
    [ProcessingStage.ANIMATING_VIDEOS]: "Animando com LTX‑2.3",
    [ProcessingStage.COMPLETED]: "Projeto concluído",
  };

  const detectedPromptBlocks = scriptText.trim()
    ? parseVisualPromptBlocks(scriptText)
    : [];
  const detectedAnimationPromptBlocks = animationScriptText.trim()
    ? parseVisualPromptBlocks(animationScriptText)
    : [];
  const structuredPromptCount = detectedPromptBlocks.length;
  const animationPromptCount = detectedAnimationPromptBlocks.length;
  const taggedPromptCount = detectedPromptBlocks.filter(block => block.mediaType).length;
  const hasExplicitMediaPlan =
    taggedPromptCount > 0 && taggedPromptCount === structuredPromptCount;
  const explicitVideoCount = detectedPromptBlocks.filter(
    block => block.mediaType === "video",
  ).length;
  const explicitImageCount = detectedPromptBlocks.filter(
    block => block.mediaType === "image",
  ).length;
  const hasSrtSync = srtCues.length > 0;
  const synchronizedVisualSceneCount = hasSrtSync
    ? structuredPromptCount || srtCues.length
    : structuredPromptCount;

  return (
    <div className="studio-shell flex min-h-screen w-full flex-col text-gray-200">

      {/* Modal */}
      {modalScene && (
        <ImageModal
          scene={modalScene}
          selectedStyle={effectiveStyle}
          sceneInterval={modalScene.durationSeconds || effectiveSceneDuration}
          sceneIndex={modalSceneIndex}
          sceneCount={scenes.length}
          onClose={() => setSelectedScene(null)}
          onPrevious={() => navigateModalScene(-1)}
          onNext={() => navigateModalScene(1)}
          onRegenerate={handleRegenerateSingle}
          onGenerateVideoPrompt={handleGenerateVideoPrompt}
          onAnimateScene={handleAnimateScene}
        />
      )}

      {/* ══════════════ TOP HEADER BAR ══════════════ */}
      <div className="studio-topbar flex-shrink-0">
        {/* Brand Row */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-cinema-gold/35 bg-cinema-gold/10 shadow-lg shadow-cinema-gold/5">
              <i className="fas fa-film text-cinema-gold text-xl"></i>
            </div>
            <div>
              <h1 className="font-serif text-xl text-cinema-gold font-bold leading-none">CineGen IA</h1>
              <p className="mt-1 text-[10px] text-gray-400 uppercase tracking-[0.22em]">Estúdio de animação cinematográfica</p>
            </div>
            <span className="ml-2 bg-cinema-gold/10 text-cinema-gold text-[10px] px-2.5 py-1 rounded-lg font-bold border border-cinema-gold/25">v3.0</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-2 py-0.5 rounded border font-mono flex items-center gap-1 ${
              imageProvider === "flow"
                ? flowConnection.connected
                  ? "bg-blue-900/60 text-blue-200 border-blue-600/50"
                  : "bg-amber-950/70 text-amber-200 border-amber-600/50"
                : "bg-green-900/60 text-green-300 border-green-700/40"
            }`}>
              <i className="fas fa-bolt text-cinema-gold text-[8px]"></i>
              {imageProvider === "flow"
                ? `Google Flow · ${flowConnection.connected ? flowConnection.plan || "conectado" : "desconectado"} + LTX‑2.3 · 1 imagem + 1 vídeo`
                : "Krea 2 Turbo + LTX‑2.3 · Unlimited · 16 imagens + 4 vídeos"}
            </span>
            {scenes.some(s => s.status === 'failed') && (
              <button
                onClick={handleRetryFailed}
                disabled={stage === ProcessingStage.GENERATING_IMAGES}
                className="bg-red-800/90 hover:bg-red-700 border border-red-600 text-red-100 px-3 py-1 rounded text-[10px] font-bold uppercase transition disabled:opacity-50"
              >
                <i className="fas fa-redo-alt mr-1"></i>Tentar Falhas ({scenes.filter(s => s.status === 'failed').length})
              </button>
            )}
          </div>
        </div>

        <div className="studio-project-heading">
          <div>
            <h2><i className="fas fa-diagram-project"></i> Projeto — funcionamento detalhado</h2>
            <p>Configure o fluxo completo; a IA transcreve, divide, cria os prompts e envia cada cena ao modelo correto.</p>
          </div>
          <div className="studio-output-pill">
            <span><b>V</b> vídeo</span>
            <span><b>I</b> imagem</span>
          </div>
        </div>
        <div className="studio-workflow-steps">
          {[
            ["1", "Escolha o estilo"],
            ["2", "Envie áudio ou roteiro"],
            ["3", "Defina V / I"],
            ["4", "Análise da IA"],
            ["5", "Salvar e exportar"],
          ].map(([number, label], index) => (
            <React.Fragment key={number}>
              <div className={`studio-workflow-step ${index === 0 ? "is-active" : ""}`}>
                <span>{number}</span>{label}
              </div>
              {index < 4 && <i className="fas fa-arrow-right studio-step-arrow"></i>}
            </React.Fragment>
          ))}
        </div>

        {/* Controls Row */}
        <div className="studio-controls-grid">

          {/* Style selector compact */}
          <div className="studio-control-card studio-style-card flex flex-col gap-2">
            <span className="studio-card-title"><i className="fas fa-palette mr-2 text-cinema-gold"></i>Estilo visual</span>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Motor de geração das cenas">
              <button
                type="button"
                onClick={() => setImageProvider("sogni")}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  imageProvider === "sogni"
                    ? "border-cinema-gold bg-cinema-gold/15 text-white"
                    : "border-white/10 bg-black/20 text-gray-400 hover:border-white/25"
                }`}
              >
                <span className="block text-[11px] font-bold">Krea 2 Turbo</span>
                <small className="block text-[9px] opacity-75">16 imagens em paralelo</small>
              </button>
              <button
                type="button"
                onClick={() => setImageProvider("flow")}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  imageProvider === "flow"
                    ? "border-blue-500 bg-blue-500/10 text-white"
                    : "border-white/10 bg-black/20 text-gray-400 hover:border-white/25"
                }`}
              >
                <span className="block text-[11px] font-bold">Google Flow</span>
                <small className={`block text-[9px] ${
                  flowConnection.connected ? "text-green-300" : "text-amber-300"
                }`}>
                    {flowConnection.connected
                      ? `${flowConnection.plan || "Conta conectada"} · v${flowConnection.extensionVersion || "antiga"}`
                      : flowConnection.installed
                      ? flowConnection.extensionVersion === REQUIRED_FLOW_CONNECTOR_VERSION
                        ? "Abra a aba do Flow"
                        : "Atualize o conector"
                      : "Conector não detectado"}
                </small>
              </button>
            </div>
            {imageProvider === "flow" && (
              <div className="rounded-lg border border-blue-500/25 bg-blue-950/20 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-semibold ${
                    flowConnection.connected ? "text-green-300" : "text-amber-300"
                  }`}>
                    <i className={`fas ${flowConnection.connected ? "fa-circle-check" : "fa-circle-exclamation"} mr-1`}></i>
                    {flowConnection.connected
                      ? `Flow conectado pela aba do navegador${flowConnection.plan ? ` · ${flowConnection.plan}` : ""} · conector v${flowConnection.extensionVersion || "antiga"}`
                      : flowConnection.installed
                        ? flowConnection.extensionVersion === REQUIRED_FLOW_CONNECTOR_VERSION
                          ? "Conector ativo; abra e mantenha um projeto do Flow conectado."
                          : "Versão antiga detectada. Recarregue o CineGen Flow Connector."
                        : "Atualize/recarregue o CineGen Flow Connector 1.3."}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleConnectGoogleFlow()}
                    className="shrink-0 rounded border border-blue-400/40 bg-blue-500/10 px-2 py-1 text-[9px] font-bold text-blue-200 hover:bg-blue-500/20"
                  >
                    <i className={`fas ${flowConnection.connected ? "fa-arrow-up-right-from-square" : "fa-link"} mr-1`}></i>
                    {flowConnection.connected ? "Abrir Flow" : "Conectar conta Google"}
                  </button>
                </div>
                <label className="flex cursor-pointer items-start gap-2 rounded border border-white/10 bg-black/20 p-2">
                  <input
                    type="checkbox"
                    checked={approveFlowCredits}
                    onChange={(event) => setApproveFlowCredits(event.target.checked)}
                    className="mt-0.5 accent-yellow-400"
                  />
                  <span className="text-[9px] leading-relaxed text-gray-300">
                    Autorizo o Flow a consumir os créditos necessários para gerar as cenas deste projeto.
                  </span>
                </label>
                <p className="text-[9px] leading-relaxed text-gray-500">
                  O Flow gera os quadros em fila na conta conectada. Depois, as cenas V são animadas normalmente pela API LTX‑2.3 do CineGen.
                </p>
              </div>
            )}
            <div className="studio-quality-switch" role="group" aria-label="Qualidade das imagens">
              <button
                type="button"
                onClick={() => setImageQualityMode("studio")}
                className={imageQualityMode === "studio" ? "is-active" : ""}
                title="1080p, direção de câmera inteligente e acabamento detalhado"
              >
                <i className="fas fa-gem"></i>
                <span>Qualidade máxima</span>
                <small>1080p · 8 passos Turbo</small>
              </button>
              <button
                type="button"
                onClick={() => setImageQualityMode("standard")}
                className={imageQualityMode === "standard" ? "is-active" : ""}
                title="720p e geração mais rápida"
              >
                <i className="fas fa-bolt"></i>
                <span>Rápido · recomendado</span>
                <small>720p · 8 passos · ~23s</small>
              </button>
            </div>
            <select
              value={selectedStyle}
              onChange={e => setSelectedStyle(e.target.value)}
              className="studio-field text-[12px] text-gray-200 px-3 py-2 cursor-pointer w-full"
            >
              <option value="none">Nenhum preset — usar somente meu prompt</option>
              {["Massinha (Estilo Aardman)","Estúdio Laika (Estilo Coraline)","Stop Motion Wes Anderson","Estilo Lego Movie","Gótico Tim Burton","Animação de Recorte de Papel","Feltro e Lã","Stop Motion Vintage Anos 1930"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <textarea
              value={customStylePrompt}
              onChange={e => setCustomStylePrompt(e.target.value)}
              placeholder="Meu prompt de estilo visual (opcional)"
              rows={3}
              className="studio-field text-[12px] text-gray-200 px-3 py-2 w-full resize-y leading-snug"
            />
            <span className="text-[10px] text-cinema-gold max-w-72 leading-tight">
              {customStylePrompt.trim()
                ? `${imageProvider === "flow" ? "Estilo para o Google Flow" : "Style Prompt do Krea 2"} ativo (${customStylePrompt.trim().length} caracteres)`
                : selectedStyle === "none"
                  ? "Nenhum preset ativo — escreva o estilo desejado acima."
                  : `Preset ativo: ${selectedStyle}`}
            </span>
            <span className="text-[9px] text-gray-500 max-w-64 leading-tight">
              {imageProvider === "flow"
                ? "O estilo acompanha cada prompt enviado ao Google Flow. O roteiro continua determinando o conteúdo exclusivo de cada cena."
                : "Enviado separadamente ao campo Custom Style do Krea 2 Turbo. O roteiro continua sendo o conteúdo principal de cada cena."}
            </span>
          </div>

          {/* Interval */}
          <div className="studio-control-card studio-interval-card flex flex-col gap-3">
            <span className="studio-card-title"><i className="fas fa-scissors mr-2 text-cinema-gold"></i>Intervalo / corte</span>
            <div className="flex flex-wrap gap-1">
              {[
                {value:0,label:"Nenhum"},
                {value:2,label:"2s"},
                {value:3,label:"3s"},
                {value:6,label:"6s"},
                {value:8,label:"8s"},
                {value:10,label:"10s"},
                {value:15,label:"15s"},
                {value:30,label:"30s"},
                {value:60,label:"1m"},
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setSceneInterval(opt.value)}
                  disabled={
                    hasSrtSync ||
                    (subtitleMode === "text-srt-8" && opt.value !== 8)
                  }
                  className={`text-[11px] px-2.5 py-1.5 rounded border font-mono transition ${
                    sceneInterval === opt.value
                      ? 'bg-cinema-gold text-black border-cinema-gold font-bold shadow'
                      : 'bg-cinema-900 text-gray-400 border-cinema-700 hover:text-white hover:border-gray-500'
                  } disabled:cursor-not-allowed disabled:opacity-30`}
                >{opt.label}</button>
              ))}
            </div>
            {sceneInterval === 0 && (
              <span className="text-[9px] leading-tight text-green-400">
                Sem corte automático: cada prompt separado no roteiro vira uma cena exata.
              </span>
            )}
            {hasSrtSync && (
              <span className="text-[9px] leading-tight text-green-400">
                O SRT controla início e fim de cada cena; o intervalo manual fica desativado.
              </span>
            )}
          </div>

          {/* Reference Image */}
          <div className="studio-control-card studio-reference-card flex flex-col gap-2">
            <span className="studio-card-title">Referência visual do estilo</span>
            <div className="relative w-full min-h-16 bg-black/40 rounded-lg border border-dashed border-cinema-700 flex items-center justify-center overflow-hidden group cursor-pointer hover:border-cinema-gold transition">
              {refImage ? (
                <>
                  <img src={refImage} alt="Ref" className="w-full h-full object-cover" />
                  <button onClick={() => { setRefImage(null); setRefImageName(null); }} className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 flex items-center justify-center text-red-400 text-xs transition">
                    <i className="fas fa-times"></i>
                  </button>
                </>
              ) : (
                <i className="fas fa-user-circle text-cinema-gold/60 text-sm"></i>
              )}
              <input type="file" accept="image/*" onChange={handleRefImageUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
            </div>
            <span className="text-[10px] text-gray-400 max-w-[140px] truncate" title={refImageName || "Nenhuma referência"}>
              {refImageName || "Sem referência"}
            </span>
            {refImage && (
              <span className="text-[9px] leading-tight text-green-400">
                A IA estudará cores, traço, textura e acabamento. O conteúdo virá de cada prompt do roteiro.
              </span>
            )}
          </div>

          {/* Audio Upload */}
          <div className="studio-control-card studio-audio-card flex flex-col gap-2">
            <span className="studio-card-title">
              1. Áudio da Narração
              {audioDuration > 0 && (
                <span className="ml-2 text-cinema-gold font-bold">
                  {audioDuration}s • {hasSrtSync ? `${srtCues.length} blocos SRT` : subtitleMode === "text-srt-8" ? "8s por cena" : subtitleMode === "storyboard" ? `~${Math.ceil(audioDuration / effectiveSceneDuration)} cenas` : "1 cena por frase"}
                </span>
              )}
            </span>
            {!audioFile ? (
              <div className="studio-field relative flex min-h-12 items-center gap-3 px-3 py-2 border-dashed cursor-pointer transition group">
                <i className="fas fa-file-audio text-cinema-gold text-xs"></i>
                 <span className="text-[11px] text-gray-300">Carregar .mp3 / .wav / .m4a</span>
                <input type="file" accept="audio/*" onChange={handleAudioUpload} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="studio-field flex min-h-12 items-center gap-2 px-3 py-2">
                  <i className="fas fa-music text-cinema-gold text-xs"></i>
                  <span className="text-[10px] font-bold text-gray-200 truncate flex-1">{audioFile.name}</span>
                  {audioUrl && <audio controls src={audioUrl} className="h-7 w-32" />}
                  <button onClick={handleRemoveAudio} className="text-gray-400 hover:text-red-400 transition text-xs ml-1"><i className="fas fa-trash-alt"></i></button>
                </div>
                <span className="block text-[9px] leading-tight text-green-400">
                  <i className="fas fa-circle-check mr-1"></i>
                  {hasSrtSync
                    ? "O áudio seguirá os timestamps do SRT; nenhuma nova transcrição será necessária."
                    : "Ao gerar as cenas, o áudio será transcrito automaticamente."}
                </span>
              </div>
            )}
          </div>

          {/* Script */}
          <div className="studio-control-card studio-script-card flex flex-col gap-2">
            <span className="studio-card-title">
              2. Prompts visuais + SRT
            </span>
            <div className="flex gap-1 items-stretch">
            <textarea
              value={scriptText}
              onChange={e => setScriptText(e.target.value)}
              placeholder="Cole os prompts visuais numerados ou importe o TXT..."
              rows={2}
              className="studio-field w-full px-3 py-2 text-[11px] resize-none text-gray-200"
            />
              <label className="cursor-pointer px-2 py-1 rounded border border-cinema-700 text-cinema-gold hover:border-cinema-gold flex items-center" title="Importar prompts em TXT">
                <i className="fas fa-file-import text-xs"></i>
                <input type="file" accept=".txt,text/plain" onChange={handleScriptFileUpload} className="hidden" />
              </label>
            </div>
            {structuredPromptCount >= 1 && (
              <span className="block rounded border border-green-500/30 bg-green-500/10 px-2 py-1.5 text-[10px] font-bold text-green-400">
                <i className="fas fa-circle-check mr-1"></i>
                {structuredPromptCount} prompt(s) visual(is) detectado(s).
              </span>
            )}
            <div className="mt-1 border-t border-white/10 pt-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-violet-300">
                  <i className="fas fa-video mr-1"></i>
                  Prompts de animação LTX
                </span>
                <span className="text-[9px] text-gray-500">opcional · mesma ordem das cenas</span>
              </div>
              <div className="flex items-stretch gap-1">
                <textarea
                  value={animationScriptText}
                  onChange={event => setAnimationScriptText(event.target.value)}
                  placeholder="Cole um prompt de movimento por cena: ação, câmera, gestos e ambiente..."
                  rows={2}
                  className="studio-field w-full resize-y px-3 py-2 text-[11px] text-gray-200"
                />
                <label
                  className="flex cursor-pointer items-center rounded border border-violet-500/35 px-2 py-1 text-violet-300 hover:border-violet-400"
                  title="Importar prompts de animação em TXT"
                >
                  <i className="fas fa-file-video text-xs"></i>
                  <input
                    type="file"
                    accept=".txt,text/plain"
                    onChange={handleAnimationFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
              {animationPromptCount > 0 && (
                <span className={`mt-1 block rounded border px-2 py-1.5 text-[10px] font-bold ${
                  structuredPromptCount > 0 && animationPromptCount === structuredPromptCount
                    ? "border-green-500/30 bg-green-500/10 text-green-400"
                    : "border-violet-500/30 bg-violet-500/10 text-violet-300"
                }`}>
                  <i className="fas fa-circle-check mr-1"></i>
                  {animationPromptCount} prompt(s) de animação detectado(s).
                  {structuredPromptCount > 0 && animationPromptCount === structuredPromptCount
                    ? " Correspondência 1:1 pronta."
                    : " Cenas sem prompt manual permanecerão imóveis."}
                </span>
              )}
              <p className="mt-1 text-[9px] leading-tight text-gray-500">
                O primeiro campo gera a imagem. Este segundo campo controla somente movimento,
                câmera e ação do vídeo a partir do quadro pronto.
              </p>
            </div>
            {!hasSrtSync ? (
              <label className="studio-field relative flex min-h-10 cursor-pointer items-center gap-2 border-dashed px-3 py-2 text-[10px] text-gray-300 hover:border-cinema-gold">
                <i className="fas fa-closed-captioning text-cinema-gold"></i>
                Carregar SRT com os tempos reais da narração
                <input
                  type="file"
                  accept=".srt,application/x-subrip,text/plain"
                  onChange={handleSrtFileUpload}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </label>
            ) : (
              <div className="rounded border border-green-500/30 bg-green-500/10 px-2 py-2 text-[10px] text-green-300">
                <div className="flex items-center gap-2">
                  <i className="fas fa-circle-check"></i>
                  <strong className="truncate">{srtFileName}</strong>
                  <button
                    onClick={handleRemoveSrt}
                    className="ml-auto text-gray-400 hover:text-red-400"
                    title="Remover SRT"
                  >
                    <i className="fas fa-trash-alt"></i>
                  </button>
                </div>
                <div className="mt-1 text-[9px] text-gray-300">
                  {srtCues.length} blocos de legenda • até {formatTimelineTime(srtDuration)} • {synchronizedVisualSceneCount} cenas visuais
                </div>
                {structuredPromptCount > 0 && structuredPromptCount !== srtCues.length && (
                  <div className="mt-1 text-cinema-gold">
                    Os {structuredPromptCount} prompts serão distribuídos, em ordem, sobre os {srtCues.length} blocos SRT.
                  </div>
                )}
                {structuredPromptCount === srtCues.length && (
                  <div className="mt-1 text-green-400">
                    Correspondência exata 1:1 entre prompt e bloco SRT.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Scene division */}
          <div className="studio-control-card studio-scenes-card flex flex-col gap-2">
            <span className="studio-card-title"><i className="fas fa-clapperboard mr-2 text-cinema-gold"></i>3. Divisão das cenas</span>
            <select
              value={subtitleMode}
              onChange={e => {
                const mode = e.target.value as "storyboard" | "text-srt-8" | "auto" | "audio" | "script" | "srt-sync";
                setSubtitleMode(mode);
                if (mode === "text-srt-8") setSceneInterval(8);
              }}
              className="studio-field text-[11px] text-gray-200 px-3 py-2"
              title="Gera legendas SRT com cada cena"
            >
              <option value="storyboard">Cortes pelo tempo escolhido</option>
              <option value="text-srt-8">SRT de texto — cenas fixas de 8s</option>
              <option value="auto">SRT inteligente — 1 imagem por frase</option>
              <option value="audio">Frases da transcrição do áudio</option>
              <option value="script">Frases do roteiro escrito</option>
              <option value="srt-sync" disabled={!hasSrtSync}>SRT importado — tempos reais</option>
            </select>
          </div>

          {/* Video / image distribution */}
          <div className="studio-control-card studio-edit-card flex flex-col gap-2">
            <span className="studio-card-title"><i className="fas fa-chart-pie mr-2 text-cinema-gold"></i>4. Proporção V / I</span>
            <div className="grid grid-cols-2 gap-2">
              <div className="studio-media-count studio-media-video">
                <span>V · Vídeos</span>
                <strong>{hasExplicitMediaPlan ? explicitVideoCount : `${videoPercentage}%`}</strong>
              </div>
              <div className="studio-media-count studio-media-image">
                <span>I · Imagens</span>
                <strong>{hasExplicitMediaPlan ? explicitImageCount : `${imagePercentage}%`}</strong>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={videoPercentage}
              onChange={event => setVideoPercentage(Number(event.target.value))}
              disabled={hasExplicitMediaPlan}
              className="w-full accent-cinema-gold"
              aria-label="Proporção de vídeos"
            />
            {hasExplicitMediaPlan ? (
              <div className="rounded border border-green-500/30 bg-green-500/10 px-2 py-1.5 text-[10px] font-bold text-green-400">
                O roteiro controla a mídia: {explicitVideoCount} vídeo(s) + {explicitImageCount} imagem(ns).
                As etiquetas [VIDEO] e [IMAGEM] substituem a porcentagem.
              </div>
            ) : (
              <div className="flex items-center justify-between text-[10px]">
                <strong className="text-cinema-gold">{videoPercentage}% vídeo</strong>
                <span className="text-gray-500">cenas definidas pelo roteiro</span>
                <strong className="text-gray-200">{imagePercentage}% imagem</strong>
              </div>
            )}
            {scenes.some(scene => scene.mediaType === "video" && scene.status === "completed" && !scene.videoUrl) && (
              <button
                onClick={handleAnimateReadyScenes}
                disabled={isGeneratingVideos}
                className="rounded border border-cinema-gold/50 bg-cinema-gold/10 px-2 py-1 text-[10px] font-bold text-cinema-gold hover:bg-cinema-gold/20 disabled:opacity-50"
              >
                {isGeneratingVideos ? "Animando cenas V..." : "Animar cenas V pendentes"}
              </button>
            )}
          </div>

          {/* Project export */}
          <div className="studio-control-card studio-export-card flex flex-col gap-2">
            <span className="studio-card-title"><i className="fas fa-floppy-disk mr-2 text-cinema-gold"></i>5. Projeto e exportação</span>
            <div className="flex flex-col gap-2">
              <input
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                placeholder="Nome da história"
                className="studio-field w-full text-[11px] text-gray-200 px-3 py-2"
              />
              <div className="rounded-lg border border-cinema-gold/25 bg-black/25 p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-gray-200">
                    <i className="fas fa-link mr-2 text-cinema-gold"></i>
                    Preparar no CapCut
                  </span>
                  <span className={`text-[9px] font-bold ${
                    capCutDraftPath ? "text-green-400" : "text-gray-500"
                  }`}>
                    {capCutDraftPath ? "100% pronto" : `${synchronizationProgress}%`}
                  </span>
                </div>
                {(isSynchronizingProject || synchronizationProgress > 0) && (
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
                    <div
                      className="h-full rounded-full bg-cinema-gold transition-[width] duration-300"
                      style={{ width: `${synchronizationProgress}%` }}
                    />
                  </div>
                )}
                <p className="mb-2 text-[9px] leading-snug text-gray-500">
                  {synchronizationMessage || (
                    audioFile
                      ? "Cria um rascunho direto no CapCut com áudio, imagens e vídeos nos tempos exatos do SRT. Não renderiza MP4/WebM."
                      : "Carregue a narração para preparar a timeline do CapCut."
                  )}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {isSynchronizingProject ? (
                    <button
                      onClick={cancelSynchronization}
                      className="col-span-2 rounded border border-red-500/60 bg-red-950/60 px-2 py-2 text-[9px] font-bold uppercase text-red-200 hover:bg-red-800"
                    >
                      <i className="fas fa-stop mr-2"></i>
                      Cancelar sincronização
                    </button>
                  ) : (
                    <button
                      onClick={handleSynchronizeProject}
                      disabled={!audioFile || scenes.length === 0 || completedOutputs !== scenes.length || isGeneratingVideos}
                      className="col-span-2 rounded border border-cinema-gold/60 bg-cinema-gold/10 px-2 py-2 text-[9px] font-bold uppercase text-cinema-gold hover:bg-cinema-gold/20 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Cria um rascunho com a timeline pronta diretamente na pasta local do CapCut"
                    >
                      <i className="fas fa-wave-square mr-2"></i>
                      {capCutDraftPath ? "Preparar novo rascunho" : "Preparar no CapCut"}
                    </button>
                  )}
                </div>
              </div>
              <button
                onClick={downloadZip}
                disabled={
                  completedOutputs === 0 ||
                  completedOutputs !== scenes.length ||
                  isGeneratingVideos ||
                  isSynchronizingProject ||
                  isExportingProject
                }
                className="studio-primary rounded-lg px-3 py-2.5 text-[10px] font-bold uppercase disabled:cursor-not-allowed disabled:opacity-40"
                title="Baixa o ZIP com as cenas, áudio, SRT, prompts e timeline, sem renderizar vídeo final"
              >
                <i className={`fas ${isExportingProject ? "fa-spinner fa-spin" : "fa-file-zipper"} mr-2`}></i>
                {isExportingProject
                  ? isSynchronizingProject
                    ? `Sincronizando ${synchronizationProgress}%...`
                    : "Preparando projeto..."
                  : "Exportar projeto completo"}
              </button>
              <span className="text-[9px] leading-tight text-gray-500">
                ZIP com cenas numeradas, áudio, SRT, prompts e os tempos exatos. Não depende da sincronização do CapCut.
              </span>
            </div>
          </div>

          {/* Generate Button */}
          <div className="studio-control-card studio-generate-card flex flex-col justify-between gap-3">
            <span className="studio-card-title"><i className="fas fa-sparkles mr-2 text-cinema-gold"></i>Produção</span>
            <div className="flex gap-2">
              <button
                onClick={startPipeline}
                disabled={isGeneratingVideos || (stage !== ProcessingStage.IDLE && stage !== ProcessingStage.COMPLETED)}
                className={`px-5 py-2 rounded-lg font-bold uppercase tracking-wider transition-all shadow-xl text-xs whitespace-nowrap
                  ${(stage !== ProcessingStage.IDLE && stage !== ProcessingStage.COMPLETED)
                    ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                    : 'studio-primary'
                  }`}
              >
                {stage === ProcessingStage.IDLE || stage === ProcessingStage.COMPLETED ? (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-wand-magic-sparkles text-cinema-gold"></i>
                    Processar projeto
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <i className="fas fa-circle-notch fa-spin"></i> Processando...
                  </span>
                )}
              </button>
              {stage !== ProcessingStage.IDLE && stage !== ProcessingStage.COMPLETED && (
                <button
                  onClick={cancelActiveFlow}
                  className="rounded-lg border border-red-500/70 bg-red-950/70 px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-200 shadow-lg transition-colors hover:bg-red-800 hover:text-white"
                  title="Interromper o processamento atual"
                >
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <i className="fas fa-stop"></i>
                    Cancelar fluxo
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mx-4 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[10px] text-gray-300">
          <span className="font-bold uppercase tracking-wider text-cinema-gold">Fluxo selecionado</span>
          <span className="rounded bg-cinema-800 px-2 py-1">
            Estilo: {selectedStyle === "none" ? "somente prompt" : customStylePrompt.trim() ? "preset + prompt" : selectedStyle}
          </span>
          <span className="rounded bg-cinema-800 px-2 py-1">
            Referência: {!refImage ? "nenhuma" : "estilo analisado pela IA"}
          </span>
          <span className="rounded bg-cinema-800 px-2 py-1">
            Cenas: {hasSrtSync
              ? `${synchronizedVisualSceneCount} visuais • ${srtCues.length} blocos SRT sincronizados`
              : structuredPromptCount >= 1
              ? `${structuredPromptCount} prompts • um por cena`
              : sceneInterval === 0
                ? "um prompt por cena • sem corte automático"
                : subtitleMode === "text-srt-8"
                  ? "SRT de texto • 8s por cena"
                  : subtitleMode === "storyboard"
                    ? `${sceneInterval}s por corte`
                    : "uma por frase"}
          </span>
          <span className="rounded bg-cinema-800 px-2 py-1">
            Distribuição: {hasExplicitMediaPlan
              ? `${explicitVideoCount} V / ${explicitImageCount} I pelo roteiro`
              : `${videoPercentage}% V / ${imagePercentage}% I`}
          </span>
          <span className="rounded bg-cinema-800 px-2 py-1">
            Animação: {animationPromptCount > 0
              ? `${animationPromptCount} prompt(s) manual(is)`
              : "sem prompt: quadro imóvel"}
          </span>
          {!hasExplicitMediaPlan && (
            <span className="studio-ratio-summary">
              <i style={{ background: `conic-gradient(#8b5cf6 ${videoPercentage}%, #e0ad32 0)` }}></i>
              {videoPercentage}% vídeo · {imagePercentage}% imagem
            </span>
          )}
          <span className="rounded bg-cinema-800 px-2 py-1">Exportação: projeto completo em ZIP</span>
        </div>

        {synchronizedVisualSceneCount >= 1 &&
          scenes.length > 0 &&
          scenes.length !== synchronizedVisualSceneCount && (
            <div className="mx-4 mb-4 flex items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-[11px] text-amber-200">
              <i className="fas fa-triangle-exclamation text-cinema-gold"></i>
              <span>
                O resultado abaixo é da execução anterior ({scenes.length} cenas).
                Ao clicar em <strong>Processar projeto</strong>, ele será substituído por{" "}
                <strong>{synchronizedVisualSceneCount} cenas visuais</strong>
                {hasSrtSync ? ` sincronizadas com ${srtCues.length} blocos SRT.` : ", exatamente uma para cada prompt detectado."}
              </span>
            </div>
          )}

        {/* Progress bar when generating */}
        {(stage === ProcessingStage.GENERATING_IMAGES || stage === ProcessingStage.ANIMATING_VIDEOS) && scenes.length > 0 && (() => {
          const videoStage = stage === ProcessingStage.ANIMATING_VIDEOS;
          const stageScenes = videoStage
            ? scenes.filter(scene => scene.mediaType === "video")
            : scenes;
          const done = videoStage
            ? stageScenes.filter(s => s.videoStatus === 'completed' || s.videoStatus === 'failed').length
            : stageScenes.filter(s => s.status === 'completed' || s.status === 'failed').length;
          const pct = Math.round((done / Math.max(1, stageScenes.length)) * 100);
          return (
            <div className="px-4 pb-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] text-cinema-gold font-mono">
                  {videoStage ? "Vídeos" : "Quadros-base"}: {done}/{stageScenes.length}
                </span>
                <span className="text-[9px] text-gray-500">{pct}%</span>
              </div>
              <div className="w-full h-1 bg-cinema-700 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-cinema-gold to-yellow-500 transition-all duration-300 rounded-full" style={{width: `${pct}%`}}></div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ══════════════ STORYBOARD GRID (FULL HEIGHT) ══════════════ */}
      {/* A única visualização das cenas fica na timeline completa abaixo. */}
      <div className="hidden">
        {scenes.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 p-8">
            <div className="w-20 h-20 rounded-full bg-cinema-800 flex items-center justify-center mb-4 text-cinema-gold/30 border border-cinema-700">
              <i className="fas fa-film text-4xl"></i>
            </div>
            <p className="text-sm font-bold text-gray-400 mb-1">Nenhuma cena gerada ainda</p>
            <p className="text-[11px] text-gray-600 text-center max-w-xs">
              Configure o estilo, carregue o áudio ou escreva o roteiro e clique em <strong className="text-cinema-gold">Gerar Storyboard</strong>
            </p>
          </div>
        ) : (
          <div className="p-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-2">
            {scenes.map((scene) => (
              <div
                key={scene.id}
                onClick={() => handleSceneClick(scene)}
                className="bg-cinema-800 rounded border border-cinema-700 overflow-hidden flex flex-col cursor-pointer hover:border-cinema-gold transition-all shadow hover:shadow-cinema-gold/20 hover:-translate-y-0.5 group"
              >
                {/* Header */}
                <div className="px-2 py-1 bg-cinema-900 flex justify-between items-center border-b border-cinema-700">
                  <span className="text-[9px] font-mono text-cinema-gold font-bold">{scene.time}</span>
                  <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                    scene.status === 'completed' ? 'bg-green-900/80 text-green-300' :
                    scene.status === 'failed' ? 'bg-red-900/80 text-red-300' :
                    scene.status === 'generating' ? 'bg-blue-900/80 text-blue-300 animate-pulse' :
                    'bg-gray-700 text-gray-500'
                  }`}>
                    {scene.status === 'completed' ? '✓' :
                     scene.status === 'failed' ? '✗' :
                     scene.status === 'generating' ? '⟳' : '○'}
                  </span>
                </div>

                {/* Image Area */}
                <div className="aspect-video bg-black relative overflow-hidden">
                  {scene.imageUrl ? (
                    <img src={scene.imageUrl} alt={scene.action} className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {scene.status === 'generating' ? (
                        <i className="fas fa-spinner fa-spin text-cinema-gold"></i>
                      ) : scene.status === 'failed' ? (
                        <div className="flex flex-col items-center gap-1">
                          <i className="fas fa-exclamation-triangle text-red-400 text-xs"></i>
                          <button
                            onClick={e => { e.stopPropagation(); handleRegenerateSingle(scene); }}
                            className="bg-red-700 hover:bg-red-600 text-white px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
                          >↺ Regerar</button>
                        </div>
                      ) : (
                        <i className="fas fa-image text-gray-700 text-xs"></i>
                      )}
                    </div>
                  )}
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/75 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-center p-1.5">
                    <i className="fas fa-expand text-cinema-gold text-sm mb-1"></i>
                    <p className="text-[8px] text-gray-200 line-clamp-3">{scene.action}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ══════════════ BOTTOM BAR: Timeline + Log ══════════════ */}
      <div className="studio-scroll flex-1 overflow-y-auto px-4 pb-8">
        <Timeline
          scenes={scenes}
          sceneInterval={effectiveSceneDuration}
          audioFile={audioFile}
          audioDuration={audioDuration}
          onSelectScene={setSelectedScene}
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <section className="studio-panel p-5 xl:col-span-3">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-gray-200">
              Progresso do projeto
            </h3>
            <div className="mt-5 flex items-center gap-5">
              <div
                className="relative flex h-28 w-28 flex-shrink-0 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(#e0ad32 ${projectProgress}%, #2b2f34 ${projectProgress}% 100%)`,
                }}
              >
                <div className="flex h-20 w-20 flex-col items-center justify-center rounded-full bg-[#11151a]">
                  <strong className="text-2xl text-gray-100">{projectProgress}%</strong>
                  <span className="text-[9px] uppercase tracking-wider text-gray-500">concluído</span>
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-3 text-[11px]">
                <div className="flex justify-between text-gray-400">
                  <span>Imagens</span><strong className="text-green-400">{completedImages}/{scenes.length}</strong>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Vídeos LTX</span><strong className="text-cinema-gold">{completedVideos}/{scenes.length}</strong>
                </div>
                <div className="border-t border-white/5 pt-3 text-cinema-gold">{stageLabel[stage]}</div>
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-gray-400">
                  <span className="flex items-center gap-2">
                    <i className="far fa-clock text-cinema-gold"></i>
                    Tempo
                  </span>
                  <strong className="font-mono text-sm text-gray-100">
                    {formatElapsedTime(generationElapsedSeconds)}
                  </strong>
                </div>
              </div>
            </div>
          </section>

          <div className="xl:col-span-9">
            <LogViewer logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
