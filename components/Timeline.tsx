import React, { useState, useEffect, useRef } from 'react';
import { Scene } from '../types';
import { drawAnimatedScene } from '../utils/videoExporter';
import { getSceneStatusDisplay } from '../utils/sceneStatus';

interface TimelineProps {
  scenes: Scene[];
  sceneInterval: number;
  audioFile: File | null;
  audioDuration: number;
  onSelectScene?: (scene: Scene) => void;
}

export const Timeline: React.FC<TimelineProps> = ({
  scenes,
  sceneInterval,
  audioFile,
  audioDuration,
  onSelectScene
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedImagesRef = useRef<Map<number, HTMLImageElement>>(new Map());

  const sceneStartAt = (scene: Scene, index: number) =>
    scene.startSeconds ?? index * sceneInterval;
  const sceneEndAt = (scene: Scene, index: number) =>
    scene.endSeconds ??
    sceneStartAt(scene, index) + (scene.durationSeconds || sceneInterval);
  const sceneDurationAt = (scene: Scene, index: number) =>
    Math.max(0.1, sceneEndAt(scene, index) - sceneStartAt(scene, index));
  const usesSrtTiming = scenes.some(
    (scene) => scene.startSeconds !== undefined && scene.endSeconds !== undefined,
  );
  const scenesEnd = scenes.reduce(
    (maximum, scene, index) => Math.max(maximum, sceneEndAt(scene, index)),
    0,
  );
  const totalDuration = Math.max(
    scenesEnd,
    audioDuration,
    scenes.length > 0 ? 0 : 60,
  );
  const activeSceneIndex = (() => {
    if (scenes.length === 0) return 0;
    const exactIndex = scenes.findIndex(
      (scene, index) =>
        currentTime >= sceneStartAt(scene, index) &&
        currentTime < sceneEndAt(scene, index),
    );
    if (exactIndex >= 0) return exactIndex;
    let previousIndex = 0;
    scenes.forEach((scene, index) => {
      if (sceneStartAt(scene, index) <= currentTime) previousIndex = index;
    });
    return previousIndex;
  })();

  // Preload completed scene images for smooth timeline playback
  useEffect(() => {
    scenes.forEach((scene) => {
      if (scene.imageUrl && !loadedImagesRef.current.has(scene.id)) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          loadedImagesRef.current.set(scene.id, img);
        };
        img.src = scene.imageUrl;
      }
    });
  }, [scenes]);

  // Audio Sync Setup
  useEffect(() => {
    if (audioFile) {
      const url = URL.createObjectURL(audioFile);
      const audio = new Audio(url);
      audioRef.current = audio;

      return () => {
        audio.pause();
        URL.revokeObjectURL(url);
      };
    } else {
      audioRef.current = null;
    }
  }, [audioFile]);

  // Animation Loop for Preview Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let lastTimestamp = performance.now();

    const render = (now: number) => {
      const deltaTime = (now - lastTimestamp) / 1000;
      lastTimestamp = now;

      if (isPlaying) {
        setCurrentTime((prev) => {
          const next = prev + deltaTime;
          if (next >= totalDuration) {
            setIsPlaying(false);
            if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current.currentTime = 0;
            }
            return 0;
          }
          if (audioRef.current && Math.abs(audioRef.current.currentTime - next) > 0.3) {
            audioRef.current.currentTime = next;
          }
          return next;
        });
      }

      // Determine current scene index and progress
      const currentSceneIdx = activeSceneIndex;
      const currentSceneStart = scenes[currentSceneIdx]
        ? sceneStartAt(scenes[currentSceneIdx], currentSceneIdx)
        : 0;
      const currentSceneEnd = scenes[currentSceneIdx]
        ? sceneEndAt(scenes[currentSceneIdx], currentSceneIdx)
        : currentSceneStart + sceneInterval;
      const sceneProgress = Math.max(
        0,
        Math.min(
          1,
          (currentTime - currentSceneStart) /
            Math.max(0.1, currentSceneEnd - currentSceneStart),
        ),
      );

      const currentScene = scenes[currentSceneIdx];
      const img = currentScene ? loadedImagesRef.current.get(currentScene.id) : undefined;

      if (img) {
        drawAnimatedScene(ctx, img, canvas.width, canvas.height, sceneProgress, currentSceneIdx);
      } else {
        // Placeholder preview frame when scene image isn't ready
        ctx.fillStyle = '#121212';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#d4af37';
        ctx.font = '20px Cinzel, serif';
        ctx.textAlign = 'center';

        const sceneNum = currentSceneIdx + 1;
        const actionDesc = currentScene ? currentScene.action : 'Aguardando geração de cena...';
        ctx.fillText(
          `Cena ${sceneNum} (${currentSceneStart.toFixed(1)}s - ${currentSceneEnd.toFixed(1)}s)`,
          canvas.width / 2,
          canvas.height / 2 - 20,
        );

        ctx.fillStyle = '#a0a0a0';
        ctx.font = '14px Inter, sans-serif';
        ctx.fillText(actionDesc.length > 50 ? actionDesc.substring(0, 50) + '...' : actionDesc, canvas.width / 2, canvas.height / 2 + 20);
      }

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, currentTime, scenes, sceneInterval, totalDuration, activeSceneIndex]);

  // Handle Play/Pause
  const togglePlay = () => {
    if (!isPlaying) {
      if (currentTime >= totalDuration) setCurrentTime(0);
      if (audioRef.current) {
        audioRef.current.currentTime = currentTime;
        audioRef.current.play().catch(() => {});
      }
      setIsPlaying(true);
    } else {
      if (audioRef.current) audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (newTime: number) => {
    const clamped = Math.max(0, Math.min(newTime, totalDuration));
    setCurrentTime(clamped);
    if (audioRef.current) {
      audioRef.current.currentTime = clamped;
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div className="studio-panel overflow-hidden flex flex-col my-4">
      {/* Header Bar */}
      <div className="px-6 py-4 border-b border-white/5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          <div className="bg-cinema-gold/10 p-2 rounded-lg border border-cinema-gold/30">
            <i className="fas fa-film text-cinema-gold text-lg"></i>
          </div>
          <div>
            <h3 className="text-sm font-bold uppercase tracking-[0.13em] text-gray-100 flex items-center">
              Pré-visualização do projeto
              <span className="ml-2 bg-cinema-gold text-black text-[10px] font-extrabold px-2 py-0.5 rounded-full uppercase">
                Modo CapCut
              </span>
            </h3>
            <p className="text-xs text-gray-400">
              {scenes.length} Cenas • {formatTime(totalDuration)} Duração Total
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="bg-cinema-800 border border-cinema-700 rounded-lg px-3 py-2 text-gray-300">
            <i className="fas fa-chart-pie mr-2 text-cinema-gold"></i>
            {scenes.filter(scene => scene.mediaType === "video").length} V · {scenes.filter(scene => scene.mediaType !== "video").length} I
          </span>
          <span className="text-gray-500">Use “Exportar projeto completo” no painel superior.</span>
        </div>
      </div>

      {/* Main Preview & Controls Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 p-5">
        {/* Animated Canvas Player */}
        <div className="lg:col-span-5 flex flex-col items-center justify-center bg-black/70 rounded-xl border border-white/10 p-2 relative overflow-hidden group shadow-2xl">
          <div className="relative w-full aspect-video bg-cinema-900 rounded overflow-hidden flex items-center justify-center">
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              className="w-full h-full object-contain"
            />
            {/* Play Overlay Button */}
            <button
              onClick={togglePlay}
              className="absolute inset-0 m-auto w-14 h-14 bg-cinema-gold/90 hover:bg-yellow-400 text-black rounded-full flex items-center justify-center shadow-2xl opacity-80 group-hover:opacity-100 transition transform hover:scale-105"
            >
              <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'} text-xl ml-${isPlaying ? '0' : '1'}`}></i>
            </button>
          </div>

          <div className="w-full mt-2 flex items-center justify-between text-xs text-gray-400 px-1">
            <span className="font-mono text-cinema-gold font-bold">
              {formatTime(currentTime)} / {formatTime(totalDuration)}
            </span>
            <span className="text-[11px] text-gray-500">
              <i className="fas fa-magic mr-1 text-cinema-gold"></i> Movimento automático de câmera
            </span>
          </div>
        </div>

        {/* Timeline Tracks Section */}
        <div className="lg:col-span-7 flex flex-col justify-between space-y-4 min-w-0">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-gray-200">Cenas geradas</h4>
              <p className="mt-1 text-[10px] text-gray-500">{scenes.filter(scene => scene.status === 'completed').length} de {scenes.length} concluídas</p>
            </div>
            <span className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-1 text-[10px] text-gray-400">
              Krea 2 + LTX‑2.3 · {usesSrtTiming ? "tempos reais do SRT" : `${sceneInterval}s por cena`}
            </span>
          </div>
          {/* Timeline Controls & Scrubber */}
          <div className="bg-black/25 p-3 rounded-xl border border-white/10 flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-10 h-10 rounded-full bg-cinema-gold text-black flex items-center justify-center font-bold shadow hover:bg-yellow-400 transition"
            >
              <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'}`}></i>
            </button>

            <button
              onClick={() => handleSeek(0)}
              className="p-2 text-gray-400 hover:text-white transition text-sm"
              title="Voltar ao início"
            >
              <i className="fas fa-fast-backward"></i>
            </button>

            <div className="flex-1 flex flex-col">
              <div className="flex justify-between text-[11px] font-mono text-gray-400 mb-1">
                <span>{formatTime(currentTime)}</span>
                <span className="text-cinema-gold font-bold">
                  Cena Atual: {Math.min(activeSceneIndex + 1, scenes.length || 1)}
                </span>
                <span>{formatTime(totalDuration)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={totalDuration || 1}
                step={0.1}
                value={currentTime}
                onChange={(e) => handleSeek(parseFloat(e.target.value))}
                className="w-full accent-cinema-gold bg-cinema-900 rounded cursor-pointer h-2"
              />
            </div>
          </div>

          {/* Timeline Visual Track */}
          <div className="studio-scroll bg-black/25 border border-white/10 rounded-xl p-3 overflow-x-auto flex flex-col space-y-3 relative">
            {/* Audio Track Indicator */}
            <div className="flex items-center text-xs text-gray-400 gap-2 border-b border-cinema-700/50 pb-2">
              <i className="fas fa-volume-up text-cinema-gold"></i>
              <span className="font-bold text-gray-300">
                {audioFile ? `Áudio: ${audioFile.name}` : 'Roteiro de Áudio Sem Guiamento Direto'}
              </span>
              <span className="text-[10px] bg-cinema-800 px-2 py-0.5 rounded border border-cinema-700 text-gray-400 ml-auto">
                {usesSrtTiming ? "sincronizado por SRT" : `${sceneInterval}s por bloco`}
              </span>
            </div>

            {/* Video Clips Track */}
            <div className="flex gap-2 min-w-max relative py-1">
              {scenes.length === 0 ? (
                <div className="w-full py-8 text-center text-xs text-gray-500 italic">
                  Gere o storyboard para visualizar os clipes de 6 segundos na linha do tempo.
                </div>
              ) : (
                scenes.map((scene, idx) => {
                  const sceneStartTime = sceneStartAt(scene, idx);
                  const sceneEndTime = sceneEndAt(scene, idx);
                  const sceneDuration = sceneDurationAt(scene, idx);
                  const isActive = currentTime >= sceneStartTime && currentTime < sceneEndTime;
                  const generationStatus = getSceneStatusDisplay(scene);
                  const statusClass = {
                    idle: "border-gray-600/70 bg-black/80 text-gray-300",
                    queued: "border-amber-500/50 bg-amber-950/90 text-amber-200",
                    active: "border-blue-400/60 bg-blue-950/90 text-blue-200 animate-pulse",
                    success: "border-green-500/50 bg-green-950/90 text-green-200",
                    error: "border-red-500/60 bg-red-950/90 text-red-200",
                  }[generationStatus.tone];

                  return (
                    <div
                      key={scene.id}
                      onClick={() => {
                        handleSeek(sceneStartTime);
                        if (onSelectScene) onSelectScene(scene);
                      }}
                      className={`w-48 flex-shrink-0 bg-cinema-800 border rounded-xl overflow-hidden cursor-pointer transition-all hover:border-cinema-gold relative group ${
                        isActive
                          ? 'border-cinema-gold ring-2 ring-cinema-gold/50 shadow-lg scale-[1.02]'
                          : 'border-cinema-700 hover:scale-[1.01]'
                      }`}
                    >
                      {/* Thumbnail Container */}
                      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden">
                        {scene.mediaType === "video" && scene.videoUrl ? (
                          <video
                            src={scene.videoUrl}
                            muted
                            playsInline
                            preload="metadata"
                            className="w-full h-full object-cover"
                          />
                        ) : scene.mediaType !== "video" && scene.imageUrl ? (
                          <img
                            src={scene.imageUrl}
                            alt={`Cena ${idx + 1}`}
                            className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                          />
                        ) : (
                          <div className="text-center p-2 text-gray-600">
                            <i className={`fas ${scene.mediaType === "video" ? "fa-film" : "fa-image"} text-lg mb-1`}></i>
                            <p className="text-[10px]">
                              {scene.mediaType === "video"
                                ? scene.videoStatus === "generating"
                                  ? "Gerando vídeo..."
                                  : scene.videoStatus === "queued"
                                    ? "Na fila de vídeo"
                                    : "Vídeo pendente"
                                : `Cena ${idx + 1}`}
                            </p>
                          </div>
                        )}

                        {/* Scene Time Badge */}
                        <div className="absolute top-1 left-1 bg-black/80 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-cinema-gold border border-cinema-gold/30">
                          {scene.time} ({sceneDuration.toFixed(sceneDuration % 1 === 0 ? 0 : 1)}s)
                        </div>
                        <div className={`absolute bottom-1 left-1 rounded px-2 py-0.5 text-[9px] font-black ${
                          scene.mediaType === "video"
                            ? "bg-purple-600/90 text-white"
                            : "bg-cinema-gold/90 text-black"
                        }`}>
                          {scene.mediaType === "video" ? "V · VÍDEO" : "I · IMAGEM"}
                        </div>

                        <div className={`absolute right-1 top-1 rounded border px-1.5 py-0.5 text-[8px] font-bold shadow ${statusClass}`}>
                          {generationStatus.label}
                        </div>
                      </div>

                      {/* Action Caption */}
                      <div className="p-3 min-h-[78px]">
                        <div className="text-xl font-serif font-bold text-cinema-gold leading-none">
                          {String(idx + 1).padStart(2, '0')}
                        </div>
                        <div className="mt-2 text-[11px] font-medium text-gray-200 line-clamp-1">
                          {scene.subtitle || `Cena ${idx + 1}`}
                        </div>
                        <div className="mt-1 text-[10px] text-gray-500 line-clamp-2 leading-relaxed">
                          {scene.action}
                        </div>
                      </div>

                      {/* Active Indicator Bar */}
                      {isActive && (
                        <div className="h-1 bg-cinema-gold w-full animate-pulse"></div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
