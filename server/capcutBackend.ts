import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_MEDIA_BYTES = 300 * 1024 * 1024;
const CAPCUT_TIMEBASE = 1_000_000;
const stagingRoot = path.join(os.tmpdir(), "cinegen-capcut-uploads");

interface CapCutSceneRequest {
  number?: number;
  time?: string;
  startSeconds?: number | null;
  endSeconds?: number | null;
  durationSeconds?: number | null;
  mediaType?: "image" | "video";
  imageUrl?: string | null;
  videoUrl?: string | null;
  subtitle?: string | null;
}

interface CapCutProjectRequest {
  projectName?: string;
  scenes?: CapCutSceneRequest[];
  audioUploadId?: string | null;
  audioFileName?: string | null;
  audioDurationSeconds?: number | null;
  srtText?: string | null;
  width?: number;
  height?: number;
}

interface MediaResult {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

interface Skeleton {
  material: any;
  segment: any;
  track: any;
  extras: Map<string, { collection: string; value: any }>;
}

interface TemplateBundle {
  content: any;
  meta: any;
  supportDirectory: string;
  photo: Skeleton;
  video: Skeleton;
  audio: Skeleton | null;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const LOCAL_CINEGEN_ORIGINS = new Set(
  [3003, 3004, 3005, 3006].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]),
);

function handleLocalCors(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = String(request.headers.origin || "");
  if (origin && LOCAL_CINEGEN_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-CineGen-File-Name",
    );
  }
  if (request.method === "OPTIONS") {
    if (!LOCAL_CINEGEN_ORIGINS.has(origin)) {
      sendJson(response, 403, { error: "Origem local não autorizada." });
      return true;
    }
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  return false;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`Arquivo maior que ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 100);
}

function capCutRoot(): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(
    localAppData,
    "CapCut",
    "User Data",
    "Projects",
    "com.lveditor.draft",
  );
}

function toCapCutPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function secondsToCapCut(value: number, allowZero = false): number {
  const converted = Math.round(value * CAPCUT_TIMEBASE);
  return allowZero ? Math.max(0, converted) : Math.max(1, converted);
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  ) {
    return true;
  }
  const match = host.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function validatePublicUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || isPrivateHostname(parsed.hostname)) {
    throw new Error("A URL da mídia não é pública e segura.");
  }
  return parsed;
}

function extensionFor(contentType: string, source = ""): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
  };
  if (byType[normalized]) return byType[normalized];
  try {
    const ext = path.extname(new URL(source).pathname).slice(1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch {
    // The source may be a data URI.
  }
  return normalized.startsWith("video/") ? "mp4" : "jpg";
}

async function loadMedia(value: string): Promise<MediaResult> {
  const inline = value.match(
    /^data:((?:image\/(?:png|jpe?g|webp))|(?:video\/(?:mp4|webm)));base64,([a-z0-9+/=\r\n]+)$/i,
  );
  if (inline) {
    const buffer = Buffer.from(inline[2].replace(/\s/g, ""), "base64");
    if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
      throw new Error("Mídia embutida vazia ou grande demais.");
    }
    return {
      buffer,
      contentType: inline[1].toLowerCase(),
      extension: extensionFor(inline[1]),
    };
  }

  validatePublicUrl(value);
  const response = await fetch(value, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao baixar uma mídia.`);
  }
  validatePublicUrl(response.url);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
    throw new Error("Mídia vazia ou maior que 300 MB.");
  }
  const contentType =
    response.headers.get("content-type") || "application/octet-stream";
  return {
    buffer,
    contentType,
    extension: extensionFor(contentType, response.url || value),
  };
}

async function parseJsonFile(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function findSkeleton(content: any, kind: "photo" | "video" | "audio"): Skeleton | null {
  const collection = kind === "audio" ? content?.materials?.audios : content?.materials?.videos;
  const material = Array.isArray(collection)
    ? collection.find((item: any) =>
        kind === "audio" ? true : String(item?.type).toLowerCase() === kind,
      )
    : null;
  if (!material) return null;

  const trackType = kind === "audio" ? "audio" : "video";
  const track = Array.isArray(content?.tracks)
    ? content.tracks.find(
        (candidate: any) =>
          candidate?.type === trackType &&
          Array.isArray(candidate.segments) &&
          candidate.segments.some((segment: any) => segment.material_id === material.id),
      )
    : null;
  const segment = track?.segments?.find(
    (candidate: any) => candidate.material_id === material.id,
  );
  if (!track || !segment) return null;

  const extras = new Map<string, { collection: string; value: any }>();
  for (const id of segment.extra_material_refs || []) {
    for (const [name, values] of Object.entries(content.materials || {})) {
      if (!Array.isArray(values)) continue;
      const found = values.find((candidate: any) => candidate?.id === id);
      if (found) {
        extras.set(id, { collection: name, value: found });
        break;
      }
    }
  }

  return {
    material: clone(material),
    segment: clone(segment),
    track: clone(track),
    extras,
  };
}

async function loadTemplates(root: string): Promise<TemplateBundle> {
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
  const withTimes = await Promise.all(
    entries.map(async (directory) => ({
      directory,
      mtime: (await fs.stat(directory)).mtimeMs,
    })),
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);

  let base: { content: any; meta: any; directory: string } | null = null;
  let fallbackBase: { content: any; meta: any; directory: string } | null = null;
  let photo: Skeleton | null = null;
  let video: Skeleton | null = null;
  let audio: Skeleton | null = null;

  for (const entry of withTimes) {
    const content = await parseJsonFile(path.join(entry.directory, "draft_content.json"));
    const meta = await parseJsonFile(path.join(entry.directory, "draft_meta_info.json"));
    if (!content || !meta) continue;
    fallbackBase ||= { content, meta, directory: entry.directory };
    if (!base && Array.isArray(content.tracks) && content.tracks.length === 0) {
      base = { content, meta, directory: entry.directory };
    }
    photo ||= findSkeleton(content, "photo");
    video ||= findSkeleton(content, "video");
    audio ||= findSkeleton(content, "audio");
    if (base && photo && video && audio) break;
  }

  const selectedBase = base || fallbackBase;
  if (!selectedBase || (!photo && !video)) {
    throw new Error(
      "O CapCut não possui um rascunho local compatível para servir de modelo.",
    );
  }
  photo ||= video;
  video ||= photo;
  if (!photo || !video) {
    throw new Error("Não foi possível localizar modelos de faixa do CapCut.");
  }

  return {
    content: clone(selectedBase.content),
    meta: clone(selectedBase.meta),
    supportDirectory: selectedBase.directory,
    photo,
    video,
    audio,
  };
}

function clearDraftContent(content: any): void {
  content.tracks = [];
  if (!content.materials || typeof content.materials !== "object") {
    content.materials = {};
  }
  for (const key of Object.keys(content.materials)) {
    if (Array.isArray(content.materials[key])) content.materials[key] = [];
  }
  if (Array.isArray(content.keyframes)) content.keyframes = [];
  else if (content.keyframes && typeof content.keyframes === "object") content.keyframes = {};
  if (Array.isArray(content.keyframe_graph_list)) content.keyframe_graph_list = [];
  if (Array.isArray(content.relationships)) content.relationships = [];
  if (Array.isArray(content.time_marks)) content.time_marks = [];
}

function addExtras(
  content: any,
  skeleton: Skeleton,
  segment: any,
  speed: number,
): void {
  const refs: string[] = [];
  for (const oldId of segment.extra_material_refs || []) {
    const source = skeleton.extras.get(oldId);
    if (!source) continue;
    const value = clone(source.value);
    value.id = randomUUID();
    if (source.collection === "speeds") value.speed = speed;
    if (!Array.isArray(content.materials[source.collection])) {
      content.materials[source.collection] = [];
    }
    content.materials[source.collection].push(value);
    refs.push(value.id);
  }
  segment.extra_material_refs = refs;
}

function makeVisualEntry(
  content: any,
  skeleton: Skeleton,
  options: {
    kind: "photo" | "video";
    filePath: string;
    fileName: string;
    width: number;
    height: number;
    sourceDuration: number;
    targetStart: number;
    targetDuration: number;
  },
): { material: any; segment: any } {
  const material = clone(skeleton.material);
  material.id = randomUUID();
  material.unique_id = "";
  material.type = options.kind;
  material.duration = options.sourceDuration;
  material.path = toCapCutPath(options.filePath);
  material.media_path = "";
  material.material_name = options.fileName;
  material.name = options.fileName;
  material.width = options.width;
  material.height = options.height;
  material.has_audio = options.kind === "video" && Boolean(material.has_audio);

  const speed = options.kind === "video"
    ? Math.max(0.01, options.sourceDuration / options.targetDuration)
    : 1;
  const segment = clone(skeleton.segment);
  segment.id = randomUUID();
  segment.material_id = material.id;
  segment.source_timerange = { start: 0, duration: options.sourceDuration };
  segment.target_timerange = {
    start: options.targetStart,
    duration: options.targetDuration,
  };
  segment.render_timerange = { start: 0, duration: 0 };
  segment.speed = speed;
  segment.is_loop = false;
  segment.render_index = 0;
  segment.track_render_index = 0;
  segment.keyframe_refs = [];
  addExtras(content, skeleton, segment, speed);
  content.materials.videos.push(material);
  return { material, segment };
}

function makeAudioEntry(
  content: any,
  skeleton: Skeleton,
  options: {
    filePath: string;
    fileName: string;
    duration: number;
  },
): { material: any; segment: any } {
  const material = clone(skeleton.material);
  material.id = randomUUID();
  material.unique_id = "";
  material.name = options.fileName;
  material.path = toCapCutPath(options.filePath);
  material.duration = options.duration;

  const segment = clone(skeleton.segment);
  segment.id = randomUUID();
  segment.material_id = material.id;
  segment.source_timerange = { start: 0, duration: options.duration };
  segment.target_timerange = { start: 0, duration: options.duration };
  segment.render_timerange = { start: 0, duration: 0 };
  segment.speed = 1;
  segment.track_render_index = 1;
  segment.keyframe_refs = [];
  addExtras(content, skeleton, segment, 1);
  content.materials.audios.push(material);
  return { material, segment };
}

function makeMetaMaterial(options: {
  id: string;
  filePath: string;
  fileName: string;
  kind: "photo" | "video" | "music";
  duration: number;
  width: number;
  height: number;
  createdAt: number;
  index: number;
}): any {
  const isPhoto = options.kind === "photo";
  return {
    ai_group_type: "",
    create_time: options.createdAt,
    duration: options.duration,
    enter_from: 0,
    extra_info: options.fileName,
    file_Path: toCapCutPath(options.filePath),
    height: options.height,
    id: options.id,
    import_time: options.createdAt + options.index,
    import_time_ms: Date.now() * 1000 + options.index,
    item_source: 1,
    material_color_tag: "",
    md5: "",
    metetype: options.kind,
    roughcut_time_range: isPhoto
      ? { duration: -1, start: -1 }
      : { duration: options.duration, start: 0 },
    sub_time_range: { duration: -1, start: -1 },
    type: 0,
    width: options.width,
  };
}

async function copySupportFiles(source: string, destination: string): Promise<void> {
  const excluded = new Set([
    ".locked",
    "draft_content.json",
    "draft_content.json.bak",
    "draft_meta_info.json",
    "template-2.tmp",
    "draft_cover.jpg",
    "timeline_layout.json",
    "draft_settings",
    "draft_virtual_store.json",
    "key_value.json",
  ]);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name === "Resources") continue;
    const target = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    const sourceFile = path.join(source, entry.name);
    if ((await fs.stat(sourceFile)).size <= 1024 * 1024) {
      await fs.copyFile(sourceFile, target);
    }
  }
}

async function uniqueProjectDirectory(root: string, requestedName: string): Promise<{
  name: string;
  directory: string;
}> {
  const base = safeName(requestedName, "CineGen");
  for (let index = 0; index < 1000; index += 1) {
    const name = index === 0 ? base : `${base} (${index + 1})`;
    const directory = path.join(root, name);
    try {
      await fs.mkdir(directory);
      return { name, directory };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Não foi possível escolher um nome livre no CapCut.");
}

function findAudioUpload(uploadId?: string | null): string | null {
  if (!uploadId || !/^[0-9a-f-]{36}$/i.test(uploadId)) return null;
  return path.join(stagingRoot, uploadId);
}

export async function createCapCutDraft(body: CapCutProjectRequest): Promise<{
  projectName: string;
  projectPath: string;
  sceneCount: number;
}> {
  const root = capCutRoot();
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Pasta de projetos do CapCut não encontrada: ${root}`);
  }
  const inputScenes = Array.isArray(body.scenes)
    ? body.scenes.filter((scene) => scene.imageUrl || scene.videoUrl)
    : [];
  if (!inputScenes.length) {
    throw new Error("Nenhuma cena pronta foi recebida para o CapCut.");
  }

  const templates = await loadTemplates(root);
  const target = await uniqueProjectDirectory(
    root,
    safeName(body.projectName || "CineGen", "CineGen"),
  );
  const resources = path.join(target.directory, "Resources", "CineGen");
  await fs.mkdir(resources, { recursive: true });

  try {
    await copySupportFiles(templates.supportDirectory, target.directory);
    const content = clone(templates.content);
    const meta = clone(templates.meta);
    clearDraftContent(content);
    const contentId = randomUUID();
    const draftId = randomUUID();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const nowMicros = Date.now() * 1000;
    const width = Math.max(256, Math.round(body.width || 1280));
    const height = Math.max(256, Math.round(body.height || 720));
    content.id = contentId;
    content.name = target.name;
    content.create_time = nowSeconds;
    content.update_time = nowSeconds;
    content.duration = 0;
    content.fps = 30;
    content.canvas_config = {
      ...(content.canvas_config || {}),
      ratio: "original",
      width,
      height,
    };

    const videoTrack = clone(templates.video.track);
    videoTrack.id = randomUUID();
    videoTrack.type = "video";
    videoTrack.name = "CineGen";
    videoTrack.segments = [];
    const metaMaterials: any[] = [];
    let cumulativeSeconds = 0;
    let totalBytes = 0;
    let coverSource: Buffer | null = null;

    for (const [index, scene] of inputScenes.entries()) {
      const requestedVideo = scene.mediaType === "video";
      const sourceUrl = requestedVideo ? scene.videoUrl : scene.imageUrl;
      if (!sourceUrl) {
        throw new Error(
          `Cena ${scene.number || index + 1}: ${
            requestedVideo ? "vídeo" : "imagem"
          } obrigatório ausente.`,
        );
      }
      const media = await loadMedia(sourceUrl);
      const expectedPrefix = requestedVideo ? "video/" : "image/";
      if (!media.contentType.toLowerCase().startsWith(expectedPrefix)) {
        throw new Error(
          `Cena ${scene.number || index + 1}: mídia inválida; esperado ${
            requestedVideo ? "vídeo" : "imagem"
          }, recebido ${media.contentType}.`,
        );
      }
      const targetStartSeconds = Number.isFinite(scene.startSeconds)
        ? Math.max(0, Number(scene.startSeconds))
        : cumulativeSeconds;
      const requestedDuration = Number.isFinite(scene.durationSeconds)
        ? Math.max(0.05, Number(scene.durationSeconds))
        : Number.isFinite(scene.endSeconds) && Number.isFinite(scene.startSeconds)
          ? Math.max(0.05, Number(scene.endSeconds) - Number(scene.startSeconds))
          : 6;
      const targetEndSeconds = Number.isFinite(scene.endSeconds)
        ? Math.max(targetStartSeconds + 0.05, Number(scene.endSeconds))
        : targetStartSeconds + requestedDuration;
      const targetDurationSeconds = targetEndSeconds - targetStartSeconds;
      const sourceDurationSeconds = requestedVideo
        ? Math.min(20, Math.max(4, Math.round(targetDurationSeconds)))
        : targetDurationSeconds;
      const number = String(scene.number || index + 1).padStart(4, "0");
      const fileName = `cena_${number}_${targetStartSeconds
        .toFixed(3)
        .replace(".", "-")}.${media.extension}`;
      const filePath = path.join(resources, fileName);
      await fs.writeFile(filePath, media.buffer);
      totalBytes += media.buffer.length;

      let mediaWidth = width;
      let mediaHeight = height;
      if (!requestedVideo && media.contentType.startsWith("image/")) {
        const metadata = await sharp(media.buffer).metadata().catch(() => null);
        mediaWidth = metadata?.width || width;
        mediaHeight = metadata?.height || height;
        coverSource ||= media.buffer;
      }

      const skeleton = requestedVideo ? templates.video : templates.photo;
      const sourceDuration = secondsToCapCut(sourceDurationSeconds);
      const targetStart = secondsToCapCut(targetStartSeconds, true);
      const targetDuration = secondsToCapCut(targetDurationSeconds);
      const entry = makeVisualEntry(content, skeleton, {
        kind: requestedVideo ? "video" : "photo",
        filePath,
        fileName,
        width: mediaWidth,
        height: mediaHeight,
        sourceDuration,
        targetStart,
        targetDuration,
      });
      videoTrack.segments.push(entry.segment);
      metaMaterials.push(
        makeMetaMaterial({
          id: randomUUID(),
          filePath,
          fileName,
          kind: requestedVideo ? "video" : "photo",
          duration: sourceDuration,
          width: mediaWidth,
          height: mediaHeight,
          createdAt: nowSeconds,
          index,
        }),
      );
      cumulativeSeconds = Math.max(cumulativeSeconds, targetEndSeconds);
    }
    videoTrack.segments.sort(
      (a: any, b: any) => a.target_timerange.start - b.target_timerange.start,
    );
    content.tracks.push(videoTrack);

    const uploadDirectory = findAudioUpload(body.audioUploadId);
    const stagedAudio = uploadDirectory
      ? (await fs.readdir(uploadDirectory).catch(() => []))[0]
      : null;
    const audioDurationSeconds = Number.isFinite(body.audioDurationSeconds)
      ? Math.max(0.05, Number(body.audioDurationSeconds))
      : 0;
    if (uploadDirectory && stagedAudio && audioDurationSeconds > 0 && templates.audio) {
      const sourceAudio = path.join(uploadDirectory, stagedAudio);
      const extension = path.extname(stagedAudio) || ".mp3";
      const audioFileName = `narracao_original${extension.toLowerCase()}`;
      const audioPath = path.join(resources, audioFileName);
      await fs.copyFile(sourceAudio, audioPath);
      const audioSize = (await fs.stat(audioPath)).size;
      totalBytes += audioSize;
      const audioDuration = secondsToCapCut(audioDurationSeconds);
      const audioEntry = makeAudioEntry(content, templates.audio, {
        filePath: audioPath,
        fileName: audioFileName,
        duration: audioDuration,
      });
      const audioTrack = clone(templates.audio.track);
      audioTrack.id = randomUUID();
      audioTrack.type = "audio";
      audioTrack.name = "Narração";
      audioTrack.segments = [audioEntry.segment];
      content.tracks.push(audioTrack);
      metaMaterials.push(
        makeMetaMaterial({
          id: randomUUID(),
          filePath: audioPath,
          fileName: audioFileName,
          kind: "music",
          duration: audioDuration,
          width: 0,
          height: 0,
          createdAt: nowSeconds,
          index: inputScenes.length + 1,
        }),
      );
      cumulativeSeconds = Math.max(cumulativeSeconds, audioDurationSeconds);
    }

    content.duration = secondsToCapCut(cumulativeSeconds);
    content.path = toCapCutPath(target.directory);
    meta.draft_name = target.name;
    meta.draft_fold_path = toCapCutPath(target.directory);
    meta.draft_root_path = toCapCutPath(root);
    meta.draft_id = draftId;
    meta.draft_cover = coverSource ? "draft_cover.jpg" : "";
    meta.tm_draft_create = nowMicros;
    meta.tm_draft_modified = nowMicros;
    meta.tm_duration = content.duration;
    meta.draft_timeline_materials_size_ = totalBytes;
    if (!Array.isArray(meta.draft_materials)) {
      meta.draft_materials = [];
    }
    for (const group of meta.draft_materials) {
      if (Array.isArray(group.value)) group.value = [];
    }
    let primaryGroup = meta.draft_materials.find((group: any) => group.type === 0);
    if (!primaryGroup) {
      primaryGroup = { type: 0, value: [] };
      meta.draft_materials.unshift(primaryGroup);
    }
    primaryGroup.value = metaMaterials;

    if (coverSource) {
      await sharp(coverSource)
        .resize(width, height, { fit: "cover" })
        .jpeg({ quality: 88 })
        .toFile(path.join(target.directory, "draft_cover.jpg"));
    }
    const contentJson = JSON.stringify(content);
    await fs.writeFile(path.join(target.directory, "draft_content.json"), contentJson);
    await fs.writeFile(path.join(target.directory, "draft_content.json.bak"), contentJson);
    await fs.writeFile(path.join(target.directory, "template-2.tmp"), contentJson);
    await fs.writeFile(
      path.join(target.directory, "draft_meta_info.json"),
      JSON.stringify(meta),
    );
    await fs.writeFile(
      path.join(target.directory, "timeline_layout.json"),
      JSON.stringify({
        dockItems: [
          {
            dockIndex: 0,
            ratio: 1,
            timelineIds: [contentId],
            timelineNames: ["Linha do tempo 01"],
          },
        ],
        layoutOrientation: 1,
      }),
    );
    await fs.writeFile(
      path.join(target.directory, "draft_settings"),
      `[General]\ndraft_create_time=${nowSeconds}\ndraft_last_edit_time=${nowSeconds}\nreal_edit_seconds=0\nreal_edit_keys=1\n`,
    );
    await fs.writeFile(
      path.join(target.directory, "draft_virtual_store.json"),
      JSON.stringify({
        draft_materials: [],
        draft_virtual_store: [
          { type: 0, value: [] },
          {
            type: 1,
            value: metaMaterials.map((item) => ({
              child_id: item.id,
              parent_id: "",
            })),
          },
          { type: 2, value: [] },
        ],
      }),
    );
    await fs.writeFile(path.join(target.directory, "key_value.json"), "{}");
    await fs.writeFile(path.join(target.directory, ".locked"), "");
    if (body.srtText?.trim()) {
      await fs.writeFile(
        path.join(resources, "03_LEGENDAS.srt"),
        body.srtText.trim(),
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(resources, "00_PROJETO_CINEGEN.json"),
      JSON.stringify(body, null, 2),
      "utf8",
    );

    if (uploadDirectory) {
      await fs.rm(uploadDirectory, { recursive: true, force: true });
    }
    return {
      projectName: target.name,
      projectPath: target.directory,
      sceneCount: inputScenes.length,
    };
  } catch (error) {
    await fs.rm(target.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function createCapCutAudioUploadHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (handleLocalCors(request, response)) return;
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para enviar a narração." });
      return;
    }
    try {
      const rawName = decodeURIComponent(
        String(request.headers["x-cinegen-file-name"] || "narracao.mp3"),
      );
      const fileName = safeName(rawName, "narracao.mp3");
      const buffer = await readBody(request, MAX_AUDIO_BYTES);
      if (!buffer.length) throw new Error("A narração enviada está vazia.");
      const uploadId = randomUUID();
      const directory = path.join(stagingRoot, uploadId);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, fileName), buffer);
      sendJson(response, 200, { uploadId, size: buffer.length });
    } catch (error: any) {
      sendJson(response, 400, { error: error?.message || "Falha ao enviar a narração." });
    }
  };
}

export function createCapCutProjectHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (handleLocalCors(request, response)) return;
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST para preparar o projeto do CapCut." });
      return;
    }
    try {
      const buffer = await readBody(request, MAX_JSON_BYTES);
      const body = JSON.parse(buffer.toString("utf8")) as CapCutProjectRequest;
      const result = await createCapCutDraft(body);
      sendJson(response, 200, result);
    } catch (error: any) {
      sendJson(response, 500, {
        error: error?.message || "Falha ao preparar o rascunho do CapCut.",
      });
    }
  };
}

export function createMediaProxyHandler() {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (handleLocalCors(request, response)) return;
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Use GET para baixar a mídia." });
      return;
    }
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const source = requestUrl.searchParams.get("url") || "";
      validatePublicUrl(source);
      const upstream = await fetch(source, { redirect: "follow" });
      if (!upstream.ok || !upstream.body) {
        throw new Error(`HTTP ${upstream.status} ao baixar mídia.`);
      }
      validatePublicUrl(upstream.url);
      const contentType =
        upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
      if (
        !contentType.startsWith("image/") &&
        !contentType.startsWith("video/") &&
        !contentType.startsWith("audio/")
      ) {
        await upstream.body.cancel();
        throw new Error(
          `A origem não retornou uma mídia válida (${contentType || "tipo desconhecido"}).`,
        );
      }
      const contentLength = Number(upstream.headers.get("content-length") || 0);
      if (contentLength > MAX_MEDIA_BYTES) {
        await upstream.body.cancel();
        throw new Error("Mídia maior que 300 MB.");
      }
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": contentLength > 0 ? String(contentLength) : undefined,
        "Cache-Control": "private, max-age=300",
      });
      Readable.fromWeb(upstream.body as any).pipe(response);
    } catch (error: any) {
      sendJson(response, 400, {
        error: error?.message || "Falha ao baixar mídia.",
      });
    }
  };
}
