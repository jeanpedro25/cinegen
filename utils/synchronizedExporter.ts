import { Scene } from '../types';
import { drawAnimatedScene } from './videoExporter';

export interface SynchronizedRenderOptions {
  audioFile: File;
  fallbackDurationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  sfxVolume?: number;
  signal?: AbortSignal;
  onProgress?: (progressPercent: number, message: string) => void;
}

type TimelineScene = {
  scene: Scene;
  start: number;
  end: number;
  duration: number;
};

type PreparedVisual =
  | { kind: 'image'; image: HTMLImageElement }
  | { kind: 'video'; video: HTMLVideoElement; duration: number };

const waitForMedia = (
  element: HTMLImageElement | HTMLVideoElement,
  readyEvent: 'load' | 'loadedmetadata',
  label: string,
  timeoutMs = 45_000,
) => new Promise<void>((resolve, reject) => {
  const timeout = window.setTimeout(() => {
    cleanup();
    reject(new Error(`Tempo esgotado ao preparar ${label}.`));
  }, timeoutMs);
  const cleanup = () => {
    window.clearTimeout(timeout);
    element.removeEventListener(readyEvent, handleReady);
    element.removeEventListener('error', handleError);
  };
  const handleReady = () => {
    cleanup();
    resolve();
  };
  const handleError = () => {
    cleanup();
    reject(new Error(`Não foi possível carregar ${label}.`));
  };
  element.addEventListener(readyEvent, handleReady, { once: true });
  element.addEventListener('error', handleError, { once: true });
});

const loadImage = async (url: string, label: string) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const ready = waitForMedia(image, 'load', label);
  image.src = url;
  await ready;
  return image;
};

const loadVideo = async (url: string, label: string) => {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'metadata';
  video.playsInline = true;
  video.controls = false;
  const ready = waitForMedia(video, 'loadedmetadata', label);
  video.src = url;
  video.load();
  await ready;
  return video;
};

const drawVideoCover = (
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
) => {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
    return;
  }
  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let drawWidth = width;
  let drawHeight = height;
  if (sourceRatio > targetRatio) {
    drawWidth = height * sourceRatio;
  } else {
    drawHeight = width / sourceRatio;
  }
  ctx.drawImage(
    video,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
};

const chooseRecorderMimeType = () => {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
};

const buildTimeline = (
  scenes: Scene[],
  fallbackDurationSeconds: number,
  masterDuration: number,
): TimelineScene[] => {
  let cursor = 0;
  const raw = scenes.map(scene => {
    const start = Math.max(0, scene.startSeconds ?? cursor);
    const declaredDuration = Math.max(
      0.05,
      scene.durationSeconds || fallbackDurationSeconds,
    );
    const declaredEnd = Math.max(
      start + 0.05,
      scene.endSeconds ?? start + declaredDuration,
    );
    cursor = declaredEnd;
    return { scene, start, declaredEnd };
  });

  return raw.filter(entry => entry.start < masterDuration).map((entry, index, activeEntries) => {
    const nextStart = activeEntries[index + 1]?.start;
    const end = index === activeEntries.length - 1
      ? Math.max(entry.declaredEnd, masterDuration)
      : Math.max(entry.start + 0.05, nextStart ?? entry.declaredEnd);
    const cappedEnd = masterDuration > 0
      ? Math.min(Math.max(entry.start + 0.05, end), masterDuration)
      : end;
    return {
      scene: entry.scene,
      start: entry.start,
      end: cappedEnd,
      duration: Math.max(0.05, cappedEnd - entry.start),
    };
  });
};

/**
 * Renders one final WebM whose master clock is the narration audio.
 * SRT timestamps control scene boundaries. Images are held for the exact
 * interval and videos are time-remapped so their last frame reaches the
 * corresponding scene boundary.
 */
export async function recordSynchronizedTimelineVideo(
  scenes: Scene[],
  options: SynchronizedRenderOptions,
): Promise<Blob> {
  const {
    audioFile,
    fallbackDurationSeconds = 6,
    width = 1280,
    height = 720,
    fps = 24,
    sfxVolume = 0.28,
    signal,
    onProgress,
  } = options;

  const usableScenes = scenes.filter(scene => (
    scene.status === 'completed' &&
    Boolean(scene.imageUrl || scene.videoUrl)
  ));
  if (usableScenes.length === 0) {
    throw new Error('Nenhuma cena concluída está disponível para sincronizar.');
  }
  if (signal?.aborted) throw new DOMException('Sincronização cancelada.', 'AbortError');

  // Create the context while the button click still carries user activation.
  // This avoids browsers suspending the audio track after media preparation.
  const audioContext = new AudioContext();
  const audioObjectUrl = URL.createObjectURL(audioFile);
  const narration = new Audio(audioObjectUrl);
  narration.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      narration.onloadedmetadata = () => resolve();
      narration.onerror = () => reject(new Error('Não foi possível carregar a narração.'));
      narration.load();
    });
  } catch (error) {
    URL.revokeObjectURL(audioObjectUrl);
    await audioContext.close().catch(() => {});
    throw error;
  }

  const masterDuration = Number.isFinite(narration.duration) && narration.duration > 0
    ? narration.duration
    : Math.max(
        ...usableScenes.map((scene, index) => (
          scene.endSeconds ??
          (scene.startSeconds ?? index * fallbackDurationSeconds) +
            (scene.durationSeconds || fallbackDurationSeconds)
        )),
      );
  const timeline = buildTimeline(usableScenes, fallbackDurationSeconds, masterDuration);
  if (timeline.length === 0) {
    URL.revokeObjectURL(audioObjectUrl);
    await audioContext.close().catch(() => {});
    throw new Error('As cenas não possuem tempos válidos dentro da duração do áudio.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(audioObjectUrl);
    await audioContext.close().catch(() => {});
    throw new Error('O navegador não disponibilizou o renderizador de vídeo.');
  }

  const mixDestination = audioContext.createMediaStreamDestination();
  const narrationSource = audioContext.createMediaElementSource(narration);
  const narrationGain = audioContext.createGain();
  narrationGain.gain.value = 1;
  narrationSource.connect(narrationGain).connect(mixDestination);
  const effectsGain = audioContext.createGain();
  effectsGain.gain.value = Math.max(0, Math.min(1, sfxVolume));
  effectsGain.connect(mixDestination);

  const prepared: PreparedVisual[] = new Array(timeline.length);
  let preparedCount = 0;
  let preparationCursor = 0;
  const prepareOne = async (index: number) => {
    const entry = timeline[index];
    const label = `a cena ${index + 1}`;
    if (entry.scene.mediaType === 'video' && entry.scene.videoUrl) {
      try {
        const video = await loadVideo(entry.scene.videoUrl, label);
        const source = audioContext.createMediaElementSource(video);
        source.connect(effectsGain);
        prepared[index] = {
          kind: 'video',
          video,
          duration: Number.isFinite(video.duration) ? video.duration : entry.duration,
        };
      } catch (videoError) {
        if (!entry.scene.imageUrl) throw videoError;
        prepared[index] = {
          kind: 'image',
          image: await loadImage(entry.scene.imageUrl, `a imagem-base da cena ${index + 1}`),
        };
      }
    } else if (entry.scene.imageUrl) {
      prepared[index] = {
        kind: 'image',
        image: await loadImage(entry.scene.imageUrl, label),
      };
    } else if (entry.scene.videoUrl) {
      const video = await loadVideo(entry.scene.videoUrl, label);
      const source = audioContext.createMediaElementSource(video);
      source.connect(effectsGain);
      prepared[index] = {
        kind: 'video',
        video,
        duration: Number.isFinite(video.duration) ? video.duration : entry.duration,
      };
    } else {
      throw new Error(`A cena ${index + 1} não possui imagem nem vídeo.`);
    }
    preparedCount += 1;
    onProgress?.(
      Math.max(1, Math.round((preparedCount / timeline.length) * 8)),
      `Preparando mídia ${preparedCount}/${timeline.length}...`,
    );
  };
  const worker = async () => {
    while (preparationCursor < timeline.length) {
      if (signal?.aborted) throw new DOMException('Sincronização cancelada.', 'AbortError');
      const index = preparationCursor++;
      await prepareOne(index);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(4, timeline.length) }, () => worker()),
    );
    if (signal?.aborted) throw new DOMException('Sincronização cancelada.', 'AbortError');
    await audioContext.resume();

    const canvasStream = canvas.captureStream(fps);
    const audioTrack = mixDestination.stream.getAudioTracks()[0];
    if (audioTrack) canvasStream.addTrack(audioTrack);
    const mimeType = chooseRecorderMimeType();
    const recorder = new MediaRecorder(canvasStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 160_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    return await new Promise<Blob>((resolve, reject) => {
      let timer = 0;
      let activeIndex = -1;
      let aborted = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearInterval(timer);
        narration.pause();
        prepared.forEach(item => {
          if (item?.kind === 'video') item.video.pause();
        });
        if (recorder.state !== 'inactive') recorder.stop();
        if (error) reject(error);
      };
      const handleAbort = () => {
        aborted = true;
        finish(new DOMException('Sincronização cancelada.', 'AbortError'));
      };
      signal?.addEventListener('abort', handleAbort, { once: true });

      recorder.onerror = () => finish(new Error('O navegador falhou ao gravar a timeline sincronizada.'));
      recorder.onstop = () => {
        signal?.removeEventListener('abort', handleAbort);
        if (aborted || settled) return;
        settled = true;
        resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
      };

      const first = prepared[0];
      if (first.kind === 'image') {
        drawAnimatedScene(ctx, first.image, width, height, 0, 0);
      } else {
        drawVideoCover(ctx, first.video, width, height);
      }

      recorder.start(1000);
      narration.currentTime = 0;
      narration.play().then(() => {
        const wallClockStart = performance.now();
        timer = window.setInterval(() => {
          const wallElapsed = (performance.now() - wallClockStart) / 1000;
          const elapsed = narration.currentTime > 0 ? narration.currentTime : wallElapsed;
          if (elapsed >= masterDuration || narration.ended) {
            onProgress?.(100, 'Finalizando o vídeo sincronizado...');
            if (recorder.state !== 'inactive') recorder.stop();
            window.clearInterval(timer);
            return;
          }

          while (
            activeIndex + 1 < timeline.length &&
            elapsed >= timeline[activeIndex + 1].start
          ) {
            const previousVisual = activeIndex >= 0 ? prepared[activeIndex] : undefined;
            if (previousVisual?.kind === 'video') {
              previousVisual.video.pause();
            }
            activeIndex += 1;
            const nextVisual = prepared[activeIndex];
            if (nextVisual.kind === 'video') {
              const targetDuration = timeline[activeIndex].duration;
              nextVisual.video.currentTime = 0;
              nextVisual.video.playbackRate = Math.max(
                0.25,
                Math.min(4, nextVisual.duration / targetDuration),
              );
              nextVisual.video.play().catch(() => {
                // Frame-by-frame time remapping below still keeps the visual aligned.
              });
            }
          }

          const index = Math.max(0, activeIndex);
          const entry = timeline[index];
          const visual = prepared[index];
          const sceneElapsed = Math.max(0, elapsed - entry.start);
          const progress = Math.max(0, Math.min(1, sceneElapsed / entry.duration));

          if (visual.kind === 'image') {
            drawAnimatedScene(ctx, visual.image, width, height, progress, index);
          } else {
            const desiredTime = Math.min(
              Math.max(0, visual.duration - 0.02),
              progress * visual.duration,
            );
            if (Math.abs(visual.video.currentTime - desiredTime) > 0.45) {
              try {
                visual.video.currentTime = desiredTime;
              } catch {
                // Some remote streams reject rapid seeking; playbackRate still applies.
              }
            }
            drawVideoCover(ctx, visual.video, width, height);
          }

          const renderProgress = 8 + Math.round((elapsed / masterDuration) * 92);
          onProgress?.(
            Math.min(99, renderProgress),
            `Sincronizando cenas com o áudio: ${Math.floor(elapsed)}s / ${Math.ceil(masterDuration)}s`,
          );
        }, 1000 / fps);
      }).catch(() => {
        finish(new Error('O navegador bloqueou a reprodução da narração. Clique novamente em sincronizar.'));
      });
    });
  } finally {
    narration.pause();
    prepared.forEach(item => {
      if (item?.kind === 'video') {
        item.video.pause();
        item.video.removeAttribute('src');
        item.video.load();
      }
    });
    URL.revokeObjectURL(audioObjectUrl);
    await audioContext.close().catch(() => {});
  }
}
