import JSZip from 'jszip';
import { Scene } from '../types';

/**
 * Format seconds to SRT timestamp format: HH:MM:SS,mmm
 */
export function formatSrtTimestamp(seconds: number): string {
  const pad = (num: number, size = 2) => String(num).padStart(size, '0');
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${String(millis).padStart(3, '0')}`;
}

/**
 * Generate SRT format subtitles for CapCut auto-captions
 */
export function generateSrtSubtitles(scenes: Scene[], intervalSeconds: number = 6): string {
  let fallbackCursor = 0;
  return scenes
    .map((scene, index) => {
      const startTime = scene.startSeconds ?? fallbackCursor;
      const endTime =
        scene.endSeconds ??
        startTime + (scene.durationSeconds || intervalSeconds);
      fallbackCursor = endTime;
      const startSrt = formatSrtTimestamp(startTime);
      const endSrt = formatSrtTimestamp(endTime);

      return `${index + 1}\n${startSrt} --> ${endSrt}\n${scene.subtitle || scene.action}\n`;
    })
    .join('\n');
}

/**
 * Render animated stop-motion / Ken Burns effect on canvas for a given scene frame
 */
export function drawAnimatedScene(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
  progress: number, // 0.0 to 1.0
  sceneIndex: number
) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  if (!img || !img.complete || img.naturalWidth === 0) {
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Gerando cena...', width / 2, height / 2);
    return;
  }

  // Ken Burns camera motion variations based on scene index
  const motionTypes = ['zoomIn', 'zoomOut', 'panRight', 'panLeft'];
  const motionType = motionTypes[sceneIndex % motionTypes.length];

  let scale = 1.0;
  let translateX = 0;
  let translateY = 0;

  // Add subtle stop-motion wiggle/grain frame jitter
  const stopMotionJitterX = (Math.sin(progress * 40) * 1.5);
  const stopMotionJitterY = (Math.cos(progress * 35) * 1.5);

  if (motionType === 'zoomIn') {
    scale = 1.0 + progress * 0.12; // 1.0 -> 1.12
  } else if (motionType === 'zoomOut') {
    scale = 1.12 - progress * 0.12; // 1.12 -> 1.0
  } else if (motionType === 'panRight') {
    scale = 1.08;
    translateX = (progress - 0.5) * 40;
  } else if (motionType === 'panLeft') {
    scale = 1.08;
    translateX = (0.5 - progress) * 40;
  }

  ctx.save();

  // Center transformation
  ctx.translate(width / 2 + translateX + stopMotionJitterX, height / 2 + translateY + stopMotionJitterY);
  ctx.scale(scale, scale);

  // Aspect ratio cover math
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const canvasRatio = width / height;

  let drawW = width;
  let drawH = height;

  if (imgRatio > canvasRatio) {
    drawW = height * imgRatio;
  } else {
    drawH = width / imgRatio;
  }

  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // Subtle stop-motion vignette
  const gradient = ctx.createRadialGradient(width / 2, height / 2, width * 0.35, width / 2, height / 2, width * 0.7);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Record animated canvas to WebM video blob
 */
export async function recordSceneVideo(
  imageUrl: string,
  sceneIndex: number,
  durationSeconds: number = 6,
  width: number = 1280,
  height: number = 720
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return reject(new Error('Canvas context unavailable'));
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;

    img.onload = () => {
      const stream = canvas.captureStream(30);
      let mediaRecorder: MediaRecorder;

      try {
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
      } catch {
        try {
          mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        } catch {
          mediaRecorder = new MediaRecorder(stream);
        }
      }

      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        resolve(blob);
      };

      const fps = 30;
      const totalFrames = durationSeconds * fps;
      let currentFrame = 0;

      mediaRecorder.start();

      const interval = setInterval(() => {
        currentFrame++;
        const progress = currentFrame / totalFrames;

        drawAnimatedScene(ctx, img, width, height, progress, sceneIndex);

        if (currentFrame >= totalFrames) {
          clearInterval(interval);
          mediaRecorder.stop();
        }
      }, 1000 / fps);
    };

    img.onerror = () => reject(new Error('Erro ao carregar imagem para renderização de vídeo'));
  });
}

/**
 * Generate full timeline video compiling all completed 6s scenes together
 */
export async function recordFullTimelineVideo(
  scenes: Scene[],
  intervalSeconds: number = 6,
  onProgress?: (progressPercent: number) => void,
  width: number = 1280,
  height: number = 720,
  audioFile?: File | null
): Promise<Blob> {
  const completedScenes = scenes.filter(s => s.status === 'completed' && s.imageUrl);
  if (completedScenes.length === 0) {
    throw new Error('Nenhuma cena concluída com imagem disponível');
  }

  // Preload images
  const loadedImages: HTMLImageElement[] = await Promise.all(
    completedScenes.map(scene => {
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = scene.imageUrl!;
      });
    })
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const transitionCanvas = document.createElement('canvas');
  transitionCanvas.width = width;
  transitionCanvas.height = height;
  const transitionCtx = transitionCanvas.getContext('2d')!;

  const stream = canvas.captureStream(30);
  let audioElement: HTMLAudioElement | null = null;
  let audioObjectUrl: string | null = null;
  let audioContext: AudioContext | null = null;

  if (audioFile) {
    audioObjectUrl = URL.createObjectURL(audioFile);
    audioElement = new Audio(audioObjectUrl);
    await new Promise<void>((resolve) => {
      audioElement!.onloadedmetadata = () => resolve();
      audioElement!.onerror = () => resolve();
      audioElement!.load();
    });

    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaElementSource(audioElement);
      const destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      const audioTrack = destination.stream.getAudioTracks()[0];
      if (audioTrack) stream.addTrack(audioTrack);
    } catch (error) {
      console.warn('Não foi possível incorporar o áudio ao vídeo final:', error);
    }
  }
  let mediaRecorder: MediaRecorder;

  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  } catch {
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    } catch {
      mediaRecorder = new MediaRecorder(stream);
    }
  }

  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      audioElement?.pause();
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      audioContext?.close().catch(() => {});
      const blob = new Blob(chunks, { type: 'video/webm' });
      resolve(blob);
    };

    const fps = 30;
    const framesPerScene = intervalSeconds * fps;
    const transitionFrames = Math.max(1, Math.min(Math.round(fps * 0.6), Math.floor(framesPerScene / 4)));
    const totalFrames = completedScenes.length * framesPerScene;
    let currentTotalFrame = 0;

    mediaRecorder.start();
    audioElement?.play().catch(() => {});

    const timer = setInterval(() => {
      currentTotalFrame++;

      const sceneIndex = Math.min(
        Math.floor(currentTotalFrame / framesPerScene),
        completedScenes.length - 1
      );
      const frameInScene = currentTotalFrame % framesPerScene;
      const sceneProgress = frameInScene / framesPerScene;

      const img = loadedImages[sceneIndex];
      drawAnimatedScene(ctx, img, width, height, sceneProgress, sceneIndex);

      // Crossfade the final 0.6s into the next scene. The Ken Burns motion is
      // still applied to both frames, producing a complete automatic edit.
      const transitionStart = framesPerScene - transitionFrames;
      if (frameInScene >= transitionStart && sceneIndex < loadedImages.length - 1) {
        const alpha = (frameInScene - transitionStart) / transitionFrames;
        drawAnimatedScene(
          transitionCtx,
          loadedImages[sceneIndex + 1],
          width,
          height,
          alpha * 0.12,
          sceneIndex + 1
        );
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.drawImage(transitionCanvas, 0, 0);
        ctx.restore();
      }

      if (onProgress) {
        onProgress(Math.floor((currentTotalFrame / totalFrames) * 100));
      }

      if (currentTotalFrame >= totalFrames) {
        clearInterval(timer);
        mediaRecorder.stop();
      }
    }, 1000 / fps);
  });
}

/**
 * Creates a complete ZIP package optimized for CapCut import
 */
export async function generateCapcutZip(
  scenes: Scene[],
  scriptText: string,
  audioFile: File | null,
  intervalSeconds: number = 6,
  onProgress?: (msg: string) => void
): Promise<Blob> {
  const zip = new JSZip();
  const completedScenes = scenes.filter(s => s.status === 'completed' && s.imageUrl);

  if (completedScenes.length === 0) {
    throw new Error('Nenhuma cena gerada para exportar para o CapCut.');
  }

  if (onProgress) onProgress('Gerando arquivo de legendas SRT...');

  // 1. SRT Subtitles file for CapCut
  const srtContent = generateSrtSubtitles(scenes, intervalSeconds);
  zip.file('02_LEGENDAS_CAPCUT.srt', srtContent);

  // 2. Script text
  zip.file('03_ROTEIRO_COMPLETO.txt', scriptText);

  // 3. Original Audio if provided
  if (audioFile) {
    const audioData = await audioFile.arrayBuffer();
    zip.file(`04_AUDIO_GUIA_${audioFile.name}`, audioData);
  }

  // 4. Instructions for CapCut
  const capcutInstructions = `=====================================================
INSTRUÇÕES DE IMPORTAÇÃO PARA O CAPCUT
=====================================================
1. Abra o CapCut (Mobile ou Desktop).
2. Crie um Novo Projeto.
3. Importe o vídeo "01_VIDEO_ANIMADO_TIMELINE_CAPCUT.webm" (ou adicione as imagens da pasta "cenas_imagens").
4. Importe o arquivo "02_LEGENDAS_CAPCUT.srt" para adicionar legendas automáticas perfeitamente sincronizadas a cada ${intervalSeconds} segundos!
5. ${audioFile ? `Adicione o áudio "04_AUDIO_GUIA_${audioFile.name}" na faixa de áudio.` : 'Adicione sua narração na faixa de áudio.'}
6. Prontinho! Seu projeto está 100% alinhado em cenas de ${intervalSeconds} segundos pronto para editar e publicar no TikTok / Shorts / Reels!
=====================================================`;

  zip.file('00_LEIA-ME_INSTRUCOES_CAPCUT.txt', capcutInstructions);

  // 5. Image Assets Folder
  const imagesFolder = zip.folder('cenas_imagens');
  completedScenes.forEach((scene, idx) => {
    if (scene.imageUrl && imagesFolder) {
      const base64Data = scene.imageUrl.split(',')[1];
      const timeClean = scene.time.replace(/:/g, '-');
      imagesFolder.file(`cena_${String(idx + 1).padStart(2, '0')}_${timeClean}.jpg`, base64Data, { base64: true });
    }
  });

  // 6. Generate full 6s timeline compiled video
  if (onProgress) onProgress('Renderizando vídeo animado de linha do tempo (6s por cena)...');
  
  try {
    const fullVideoBlob = await recordFullTimelineVideo(scenes, intervalSeconds, (p) => {
      if (onProgress) onProgress(`Renderizando vídeo da timeline CapCut: ${p}%`);
    }, 1280, 720, audioFile);
    zip.file('01_VIDEO_ANIMADO_TIMELINE_CAPCUT.webm', fullVideoBlob);
  } catch (err) {
    console.warn('Não foi possível renderizar o vídeo compilado, continuando sem o vídeo:', err);
  }

  // 7. Individual animated scene WebM clips
  const animFolder = zip.folder('cenas_animadas_clips_6s');
  for (let i = 0; i < completedScenes.length; i++) {
    const scene = completedScenes[i];
    if (scene.imageUrl && animFolder) {
      if (onProgress) onProgress(`Criando clipe de 6s animado para a cena ${i + 1}/${completedScenes.length}...`);
      try {
        const videoBlob = await recordSceneVideo(scene.imageUrl, i, intervalSeconds);
        const timeClean = scene.time.replace(/:/g, '-');
        animFolder.file(`cena_${String(i + 1).padStart(2, '0')}_${timeClean}_animada.webm`, videoBlob);
      } catch (e) {
        console.warn(`Falha ao gravar clipe animado da cena ${i + 1}`, e);
      }
    }
  }

  if (onProgress) onProgress('Empacotando arquivo ZIP do CapCut...');
  return await zip.generateAsync({ type: 'blob' });
}
