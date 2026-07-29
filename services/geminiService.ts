
import { GoogleGenAI, Type } from "@google/genai";
import {
  TEXT_MODEL,
  constructSceneBreakdownPrompt,
  constructSubtitleBreakdownPrompt,
  constructImagePrompt,
  constructVideoMotionPrompt,
  type ImageQualityMode,
} from "../constants";
import { Scene } from "../types";
import { generateSogniImage, DEFAULT_SOGNI_API_KEY, DEFAULT_SOGNI_MODEL } from "./sogniService";
import { generateFlowImage } from "./flowConnectorService";
import { DEFAULT_LOCKED_ANIMATION_PROMPT } from "../utils/ltxPrompt";

// Helper to sleep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StructuredPromptBlock {
  number: number;
  prompt: string;
  mediaType?: "image" | "video";
  durationSeconds?: number;
}

/**
 * Conta somente cabeçalhos explícitos de cena no início de uma linha.
 * Ex.: "CENA 01 — Título", "Scene 2: Title" ou "## Cena 3".
 */
export function countExplicitSceneHeadings(script: string): number {
  if (!script.trim()) return 0;
  return Array.from(
    script.replace(/\r/g, "").matchAll(
      /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:cena|scene)\s*\d{1,4}\b[^\n]*$/gim,
    ),
  ).length;
}

/**
 * Reconhece roteiros que já contêm um prompt completo por cena.
 * Aceita blocos Markdown cercados por ``` e formatos "Cena 1:".
 */
export function parseStructuredPromptBlocks(script: string): StructuredPromptBlock[] {
  const normalized = script.replace(/\r/g, "").trim();
  if (!normalized) return [];

  // Formato de produção explícito:
  // 1 [VIDEO CURTO ~3-5s] MASTER_STYLE_PROMPT: ...
  // 2 [IMAGEM] MASTER_STYLE_PROMPT: ...
  //
  // O número pode estar com ou sem ".", ":", ")" ou "-". Cada marcador
  // inicia um prompt completo; o corpo pode ocupar uma ou várias linhas.
  const taggedBlocks: StructuredPromptBlock[] = [];
  const taggedPattern =
    /(?:^|\n)\s*(\d{1,4})\s*(?:[.):\-]\s*)?\[\s*((?:VIDEO|VÍDEO)(?:\s+CURTO)?|IMAGEM)\s*([^\]]*)\]\s*([\s\S]*?)(?=(?:\n\s*\n?\s*\d{1,4}\s*(?:[.):\-]\s*)?\[\s*(?:(?:VIDEO|VÍDEO)(?:\s+CURTO)?|IMAGEM)\b)|$)/gi;
  let taggedMatch: RegExpExecArray | null;
  while ((taggedMatch = taggedPattern.exec(normalized)) !== null) {
    const mediaLabel = taggedMatch[2].toLocaleUpperCase("pt-BR");
    const durationLabel = taggedMatch[3] || "";
    const prompt = taggedMatch[4].trim();
    if (!prompt) continue;

    const durationValues = Array.from(durationLabel.matchAll(/(\d{1,2})\s*s/gi))
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));

    taggedBlocks.push({
      number: Number(taggedMatch[1]),
      prompt,
      mediaType: mediaLabel.startsWith("VIDEO") || mediaLabel.startsWith("VÍDEO")
        ? "video"
        : "image",
      durationSeconds: durationValues.length > 0
        ? Math.max(4, Math.min(20, durationValues[durationValues.length - 1]))
        : undefined,
    });
  }
  if (taggedBlocks.length >= 1) return taggedBlocks;

  // Formato produzido a partir de um SRT:
  //
  // BLOCO 001
  // Tempo: 00:00:00,010 --> 00:00:03,210
  // Narração: ...
  // Prompt de animação:
  // [prompt completo]
  //
  // Cabeçalhos e explicações anteriores ao BLOCO 001 são ignorados.
  const srtPromptBlocks: StructuredPromptBlock[] = [];
  const srtPromptPattern =
    /(?:^|\n)\s*(?:bloco|block)\s*(\d{1,4})\s*\n([\s\S]*?)(?=(?:\n+\s*(?:bloco|block)\s*\d{1,4}\b)|$)/gi;
  let srtPromptMatch: RegExpExecArray | null;
  while ((srtPromptMatch = srtPromptPattern.exec(normalized)) !== null) {
    const body = srtPromptMatch[2].trim();
    const explicitPrompt = body.match(
      /(?:^|\n)\s*prompt(?:\s+de)?\s+(?:animação|animacao|imagem|image|vídeo|video)\s*:\s*\n?([\s\S]*)$/i,
    );
    const prompt = (explicitPrompt?.[1] || body)
      .replace(/^```(?:[a-z0-9_-]+)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    if (!prompt) continue;
    srtPromptBlocks.push({
      number: Number(srtPromptMatch[1]),
      prompt,
    });
  }
  if (srtPromptBlocks.length >= 1) return srtPromptBlocks;

  // Formatos CENA/SCENE flexíveis:
  //
  // SCENE 1 [00:00:00,010 --> 00:00:03,210]: prompt na mesma linha
  // CENA 2: prompt na mesma linha
  // CENA 03 — TÍTULO EDITORIAL
  // prompt completo em uma ou várias linhas
  //
  // Primeiro separamos o documento por cada cabeçalho real. Em seguida
  // decidimos se o texto útil está no próprio cabeçalho, abaixo dele, ou nos
  // dois lugares. Isso impede que a linha SCENE 2 seja consumida como corpo
  // da SCENE 1.
  const sceneHeadingBlocks: StructuredPromptBlock[] = [];
  const sceneHeadingPattern =
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:cena|scene)[ \t]*(\d{1,4})\b([^\n]*)/gi;
  const sceneHeadings: Array<{
    number: number;
    tail: string;
    index: number;
    end: number;
  }> = [];
  let sceneHeadingMatch: RegExpExecArray | null;
  while ((sceneHeadingMatch = sceneHeadingPattern.exec(normalized)) !== null) {
    sceneHeadings.push({
      number: Number(sceneHeadingMatch[1]),
      tail: sceneHeadingMatch[2] || "",
      index: sceneHeadingMatch.index,
      end: sceneHeadingPattern.lastIndex,
    });
  }

  const parseClockSeconds = (value: string): number | null => {
    const normalizedClock = value.trim().replace(",", ".");
    const parts = normalizedClock.split(":").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
      return null;
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  };

  sceneHeadings.forEach((heading, index) => {
    const nextStart = sceneHeadings[index + 1]?.index ?? normalized.length;
    const body = normalized
      .slice(heading.end, nextStart)
      .replace(/^prompt\s*:\s*/i, "")
      .replace(/^```(?:[a-z0-9_-]+)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let tail = heading.tail
      .replace(/\*\*\s*$/g, "")
      .trim();
    let inlinePrompt = "";
    let mediaType: "image" | "video" | undefined;
    let durationSeconds: number | undefined;

    const bracketMatch = tail.match(/^\[\s*([^\]]+)\s*\]\s*(.*)$/);
    if (bracketMatch) {
      const bracket = bracketMatch[1].trim();
      const afterBracket = bracketMatch[2]
        .replace(/^[\s:.\-–—]+/, "")
        .trim();
      const timestampMatch = bracket.match(
        /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})$/,
      );
      if (timestampMatch) {
        const startSeconds = parseClockSeconds(timestampMatch[1]);
        const endSeconds = parseClockSeconds(timestampMatch[2]);
        if (
          startSeconds !== null &&
          endSeconds !== null &&
          endSeconds > startSeconds
        ) {
          durationSeconds = Math.max(0.1, endSeconds - startSeconds);
        }
        inlinePrompt = afterBracket;
      } else {
        const upperBracket = bracket.toLocaleUpperCase("pt-BR");
        if (/\b(?:VIDEO|VÍDEO)\b/.test(upperBracket)) mediaType = "video";
        if (/\bIMAGEM\b/.test(upperBracket)) mediaType = "image";
        const durationValues = Array.from(bracket.matchAll(/(\d{1,2})\s*s/gi))
          .map((match) => Number(match[1]))
          .filter((value) => Number.isFinite(value));
        if (durationValues.length > 0) {
          durationSeconds = Math.max(
            0.1,
            durationValues[durationValues.length - 1],
          );
        }
        inlinePrompt = afterBracket;
      }
    } else {
      tail = tail.replace(/^[\s:.\-–—]+/, "").trim();
      // Com corpo abaixo, o restante do cabeçalho normalmente é apenas um
      // título editorial. Sem corpo, ele próprio é o prompt da cena.
      inlinePrompt = body ? "" : tail;
    }

    const prompt = [inlinePrompt, body]
      .filter(Boolean)
      .join("\n")
      .replace(/^prompt\s*:\s*/i, "")
      .replace(/^```(?:[a-z0-9_-]+)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    if (!prompt) return;
    sceneHeadingBlocks.push({
      number: heading.number,
      prompt,
      mediaType,
      durationSeconds,
    });
  });
  if (sceneHeadingBlocks.length >= 1) return sceneHeadingBlocks;

  const fencedBlocks: StructuredPromptBlock[] = [];
  const fencePattern = /```(?:[a-z0-9_-]+)?[ \t]*\n?([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fencePattern.exec(normalized)) !== null) {
    const prompt = fenceMatch[1].replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
    if (!prompt) continue;
    const prefix = normalized.slice(Math.max(0, fenceMatch.index - 180), fenceMatch.index);
    const numberMatch = prefix.match(
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:cena|scene)?\s*(\d{1,4})\s*[.)]?\s*(?:\*\*)?\s*$/i,
    );
    fencedBlocks.push({
      number: numberMatch ? Number(numberMatch[1]) : fencedBlocks.length + 1,
      prompt,
    });
  }
  if (fencedBlocks.length >= 2) return fencedBlocks;

  const labelledBlocks: StructuredPromptBlock[] = [];
  const labelledPattern =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:cena|scene)\s*(\d{1,4})\s*(?:\*\*)?\s*[:.\-–—]*\s*\n([\s\S]*?)(?=(?:\n\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:cena|scene)\s*\d{1,4}\b)|$)/gi;
  let labelledMatch: RegExpExecArray | null;
  while ((labelledMatch = labelledPattern.exec(normalized)) !== null) {
    const prompt = labelledMatch[2]
      .replace(/^prompt\s*:\s*/i, "")
      .replace(/```/g, "")
      .trim();
    if (prompt) {
      labelledBlocks.push({ number: Number(labelledMatch[1]), prompt });
    }
  }
  if (labelledBlocks.length >= 2) return labelledBlocks;

  // Também aceita listas editoriais em que cada prompt é precedido por um
  // título numerado, por exemplo:
  //
  // [prompt completo da cena 1]
  //
  // 2. Ataque de drones contra Kyiv
  //
  // [prompt completo da cena 2]
  //
  // Esse é um formato comum quando o primeiro prompt chega sem o título "1.".
  // O título curto identifica a separação, mas nunca é usado para subdividir
  // as linhas internas do prompt.
  const titleHeadings: Array<{
    number: number;
    title: string;
    index: number;
    end: number;
  }> = [];
  const titleHeadingPattern =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(\d{1,4})[.)]\s+(?:\*\*)?\s*([^\n]{3,180}?)\s*(?:\*\*)?\s*(?=\n|$)/g;
  let titleHeadingMatch: RegExpExecArray | null;
  while ((titleHeadingMatch = titleHeadingPattern.exec(normalized)) !== null) {
    titleHeadings.push({
      number: Number(titleHeadingMatch[1]),
      title: titleHeadingMatch[2].trim(),
      index: titleHeadingMatch.index,
      end: titleHeadingPattern.lastIndex,
    });
  }

  if (titleHeadings.length >= 2) {
    const titledBlocks: StructuredPromptBlock[] = [];
    const prefix = normalized.slice(0, titleHeadings[0].index).trim();

    // Se a numeração visível começa em 2, o texto anterior é o prompt 1.
    if (prefix.length >= 40 && titleHeadings[0].number > 1) {
      titledBlocks.push({ number: titleHeadings[0].number - 1, prompt: prefix });
    }

    titleHeadings.forEach((heading, index) => {
      const nextStart = titleHeadings[index + 1]?.index ?? normalized.length;
      const body = normalized
        .slice(heading.end, nextStart)
        .replace(/^```(?:[a-z0-9_-]+)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      if (!body) return;

      titledBlocks.push({
        number: heading.number,
        // Preserve the user's prompt verbatim. The short heading is included
        // only as scene context and does not replace any prompt instruction.
        prompt: `${heading.title}\n${body}`,
      });
    });

    if (titledBlocks.length >= 2) return titledBlocks;
  }

  const numberedBlocks: StructuredPromptBlock[] = [];
  const numberedPattern =
    /(?:^|\n)\s*(?:\*\*)\s*(\d{1,4})[.)]\s*(?:\*\*)\s*\n([\s\S]*?)(?=(?:\n\s*\*\*\s*\d{1,4}[.)]\s*\*\*)|$)/g;
  let numberedMatch: RegExpExecArray | null;
  while ((numberedMatch = numberedPattern.exec(normalized)) !== null) {
    const prompt = numberedMatch[2].replace(/```/g, "").trim();
    if (prompt) numberedBlocks.push({ number: Number(numberedMatch[1]), prompt });
  }
  return numberedBlocks.length >= 2 ? numberedBlocks : [];
}

/**
 * Modo "Nenhum corte": cada bloco escrito pelo usuário vira uma cena exata.
 * Prioriza os formatos estruturados e, na ausência deles, usa parágrafos
 * separados por linha em branco ou uma linha por prompt.
 */
export function parsePromptListBlocks(script: string): StructuredPromptBlock[] {
  const structured = parseStructuredPromptBlocks(script);
  if (structured.length > 0) return structured;

  const normalized = script.replace(/\r/g, "").trim();
  if (!normalized) return [];

  let prompts = normalized
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/^\s*(?:prompt|cena|scene)?\s*\d*\s*[:.)-]?\s*/i, "").trim())
    .filter(Boolean);

  if (prompts.length < 2) {
    const lines = normalized
      .split("\n")
      .map((line) => line.replace(/^\s*(?:prompt|cena|scene)?\s*\d*\s*[:.)-]?\s*/i, "").trim())
      .filter(Boolean);
    if (lines.length >= 2) prompts = lines;
  }

  return prompts.map((prompt, index) => ({ number: index + 1, prompt }));
}

export class CineGenService {
  private ai: GoogleGenAI | null = null;
  private hasApiKey: boolean = false;
  private referenceDescriptionPromise: Promise<string> | null = null;
  private styleReferenceDescriptionPromise: Promise<string> | null = null;

  constructor() {
    // Safely initialize Gemini — never throw if key is missing
    const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.trim() !== '' && apiKey !== 'undefined') {
      try {
        this.ai = new GoogleGenAI({ apiKey });
        this.hasApiKey = true;
        console.log("[CineGen] Gemini API inicializada com sucesso.");
      } catch (e) {
        console.warn("[CineGen] Falha ao inicializar Gemini API:", e);
        this.ai = null;
        this.hasApiKey = false;
      }
    } else {
      console.warn("[CineGen] Chave de API do Gemini não configurada. Usando motores locais/Sogni.");
      this.ai = null;
      this.hasApiKey = false;
    }
  }

  // Helper for retry logic
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    retries = 3,
    delay = 3000
  ): Promise<T> {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        const isQuotaError = error.status === 429 || error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED');
        
        if (isQuotaError) {
          console.warn(`[CineGen] Cota atingida no Gemini (429). Aguardando ${5 + i*3}s...`);
          await sleep(5000 + (delay * i * 2)); 
        } else {
          await sleep(delay * Math.pow(2, i));
        }
      }
    }
    throw lastError;
  }

  async transcribeAudio(audioFile: File, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("Transcrição cancelada.", "AbortError");
    if (!this.hasApiKey || !this.ai) {
      throw new Error("GEMINI_API_KEY não está configurada.");
    }

    const mimeType = audioFile.type || "audio/mpeg";
    const audioBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const abortReader = () => reader.abort();
      signal?.addEventListener("abort", abortReader, { once: true });
      reader.onload = () => {
        signal?.removeEventListener("abort", abortReader);
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
      };
      reader.onerror = () => {
        signal?.removeEventListener("abort", abortReader);
        reject(reader.error || new Error("Não foi possível ler o arquivo de áudio."));
      };
      reader.onabort = () => {
        signal?.removeEventListener("abort", abortReader);
        reject(new DOMException("Transcrição cancelada.", "AbortError"));
      };
      reader.readAsDataURL(audioFile);
    });

    try {
      const transcript = await this.executeWithRetry(async () => {
        if (signal?.aborted) throw new DOMException("Transcrição cancelada.", "AbortError");
        const response = await this.ai!.models.generateContent({
          model: TEXT_MODEL,
          contents: {
            parts: [
              { inlineData: { mimeType, data: audioBase64 } },
              {
                text: "Transcreva integralmente este áudio no idioma original, com pontuação correta. Preserve nomes, números e siglas. Retorne somente a transcrição, sem resumo, títulos, comentários ou Markdown.",
              },
            ],
          },
        });
        return response.text?.trim() || "";
      }, 1, 1000);

      if (!transcript) throw new Error("O Gemini não retornou texto para este áudio.");
      return transcript;
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      throw new Error(`Falha na transcrição direta do Gemini: ${error?.message || "erro desconhecido"}`);
    }
  }

  async generateSceneBreakdown(
    script: string, 
    targetCount?: number, 
    interval: number = 6
  ): Promise<Omit<Scene, 'id' | 'status'>[]> {
    
    const prompt = constructSceneBreakdownPrompt(targetCount, interval);

    // Try Gemini only if API key is available
    if (this.hasApiKey && this.ai) {
      try {
        const generated = await this.executeWithRetry(async () => {
          const response = await this.ai!.models.generateContent({
            model: TEXT_MODEL,
            contents: script,
            config: {
              systemInstruction: prompt,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    time: { type: Type.STRING },
                    subtitle: { type: Type.STRING },
                    action: { type: Type.STRING },
                  },
                  required: ["time", "subtitle", "action"]
                }
              }
            }
          });

          const text = response.text;
          if (!text) throw new Error("Resposta vazia do modelo");
          return JSON.parse(text);
        }, 2, 2000);
        if (!this.isUsableBreakdown(generated, targetCount)) {
          throw new Error("A decupagem retornou cenas ausentes ou excessivamente repetidas.");
        }
        return generated;
      } catch (err: any) {
        console.warn("[CineGen] Gemini API indisponível para decupagem, usando fallback local...", err);
      }
    }

    // Local smart fallback — always works, no API needed
    return this.localSceneBreakdown(script, targetCount, interval);
  }

  async generateSubtitleBreakdown(
    script: string,
    targetCount?: number,
    interval: number = 6
  ): Promise<Omit<Scene, 'id' | 'status'>[]> {
    if (this.hasApiKey && this.ai) {
      try {
        const generated = await this.executeWithRetry(async () => {
          const response = await this.ai!.models.generateContent({
            model: TEXT_MODEL,
            contents: script,
            config: {
              systemInstruction: constructSubtitleBreakdownPrompt(targetCount, interval),
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    time: { type: Type.STRING },
                    subtitle: { type: Type.STRING },
                    action: { type: Type.STRING },
                  },
                  required: ["time", "subtitle", "action"]
                }
              }
            }
          });

          const text = response.text;
          if (!text) throw new Error("Resposta vazia do modelo");
          return JSON.parse(text);
        }, 2, 2000);
        if (!this.isUsableBreakdown(generated, targetCount)) {
          throw new Error("A divisão SRT retornou frases ausentes ou excessivamente repetidas.");
        }
        return generated;
      } catch (err) {
        console.warn("[CineGen] Gemini indisponível para SRT, usando divisão local.", err);
      }
    }

    return this.localSubtitleBreakdown(script, targetCount, interval);
  }

  /**
   * Divide um roteiro escrito em blocos SRT determinísticos de 8 segundos.
   * Aproximadamente 20 palavras por bloco correspondem a uma narração de
   * 150 palavras por minuto, preservando frases completas sempre que possível.
   */
  generateTextSrtBreakdown(
    script: string,
    interval: number = 8,
  ): Omit<Scene, "id" | "status">[] {
    const maxWordsPerScene = 20;
    const sentences = script
      .replace(/\r/g, "")
      .split(/(?<=[.!?…;:])\s+|\n+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const blocks: string[] = [];
    let currentWords: string[] = [];

    const flushCurrent = () => {
      if (currentWords.length > 0) {
        blocks.push(currentWords.join(" "));
        currentWords = [];
      }
    };

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).filter(Boolean);
      if (words.length > maxWordsPerScene) {
        flushCurrent();
        for (let index = 0; index < words.length; index += maxWordsPerScene) {
          blocks.push(words.slice(index, index + maxWordsPerScene).join(" "));
        }
        continue;
      }
      if (currentWords.length + words.length > maxWordsPerScene) {
        flushCurrent();
      }
      currentWords.push(...words);
    }
    flushCurrent();

    if (blocks.length === 0 && script.trim()) {
      blocks.push(script.replace(/\s+/g, " ").trim());
    }

    return blocks.map((subtitle, index) => {
      const totalSeconds = index * interval;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return {
        time: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
        subtitle,
        action: subtitle,
        durationSeconds: interval,
      };
    });
  }

  generatePromptBlockBreakdown(
    script: string,
    interval: number = 8,
  ): Omit<Scene, "id" | "status">[] {
    const blocks = parseStructuredPromptBlocks(script);
    let elapsedSeconds = 0;
    return blocks.map((block) => {
      const totalSeconds = elapsedSeconds;
      const durationSeconds = block.durationSeconds || interval;
      elapsedSeconds += durationSeconds;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return {
        time: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
        subtitle: `Cena ${block.number}`,
        action: block.prompt,
        mediaType: block.mediaType,
        durationSeconds,
      };
    });
  }

  generateDirectPromptBreakdown(
    script: string,
    technicalDuration: number = 6,
  ): Omit<Scene, "id" | "status">[] {
    return parsePromptListBlocks(script).map((block, index) => {
      const totalSeconds = index * technicalDuration;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return {
        time: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
        subtitle: `Prompt ${block.number}`,
        action: block.prompt,
        durationSeconds: technicalDuration,
      };
    });
  }

  private isUsableBreakdown(
    items: Omit<Scene, "id" | "status">[],
    expectedCount?: number,
  ): boolean {
    if (!Array.isArray(items) || items.length === 0) return false;
    if (expectedCount && items.length !== expectedCount) return false;
    if (items.some((item) => !item?.time || !item?.action?.trim() || !item?.subtitle?.trim())) {
      return false;
    }

    const normalize = (value: string) =>
      value.toLocaleLowerCase("pt-BR").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const uniqueActions = new Set(items.map((item) => normalize(item.action))).size;
    const uniqueSubtitles = new Set(items.map((item) => normalize(item.subtitle || ""))).size;
    const minimumUnique = Math.max(1, Math.ceil(items.length * 0.75));

    return uniqueActions >= minimumUnique && uniqueSubtitles >= minimumUnique;
  }

  /** Analyze the uploaded visual reference once and reuse the description for
   * every scene, so the reference actually influences all generated frames. */
  private async describeReferenceImage(reference: string): Promise<string> {
    if (!this.hasApiKey || !this.ai || !reference) return "";
    if (this.referenceDescriptionPromise) return this.referenceDescriptionPromise;

    const [header, data] = reference.includes(",")
      ? reference.split(/,(.*)/s)
      : ["data:image/jpeg;base64", reference];
    const mimeType = header.match(/^data:([^;]+)/)?.[1] || "image/jpeg";

    this.referenceDescriptionPromise = this.executeWithRetry(async () => {
      const response = await this.ai!.models.generateContent({
        model: TEXT_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType, data } },
            {
              text: "Descreva esta referência visual para um gerador de imagens. Liste personagem, rosto, cabelo, roupa, cores, materiais, proporções e estilo. Seja objetivo e não invente texto ou elementos que não estejam visíveis.",
            },
          ],
        },
      });
      return response.text?.trim() || "";
    }, 1, 1000).catch((error) => {
      console.warn("[CineGen] Referência visual não pôde ser analisada:", error);
      return "";
    });

    return this.referenceDescriptionPromise;
  }

  private async describeStyleReferenceImage(reference: string): Promise<string> {
    if (!this.hasApiKey || !this.ai || !reference) return "";
    if (this.styleReferenceDescriptionPromise) {
      return this.styleReferenceDescriptionPromise;
    }

    const [header, data] = reference.includes(",")
      ? reference.split(/,(.*)/s)
      : ["data:image/jpeg;base64", reference];
    const mimeType = header.match(/^data:([^;]+)/)?.[1] || "image/jpeg";

    this.styleReferenceDescriptionPromise = this.executeWithRetry(async () => {
      const response = await this.ai!.models.generateContent({
        model: TEXT_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType, data } },
            {
              text: `Study this reference image and extract a reusable VISUAL STYLE DNA profile for an image generator.
Describe precisely: medium and rendering technique; linework and edge quality; shape language and proportions; surface texture and material treatment; dominant and accent palette; saturation and color grading; lighting direction, softness and contrast; shadow treatment; depth of field; detail density; era and production finish.
Return one compact art-direction paragraph only. Do not mention, describe or copy any person, face, clothing, pose, object, location, background, framing, layout, written text or composition visible in the reference. Do not turn the reference subject into a recurring character. The profile must be applicable to completely different scenes.`,
            },
          ],
        },
      });
      return response.text?.trim() || "";
    }, 1, 1000).catch((error) => {
      console.warn("[CineGen] Style reference could not be analyzed:", error);
      return "";
    });

    return this.styleReferenceDescriptionPromise;
  }

  private prepareKreaStylePrompt(stylePrompt: string): string {
    const normalized = stylePrompt.replace(/\s+/g, " ").trim();
    const userStyle = normalized || "cinematic professional illustration";

    // Krea 2 Turbo has a dedicated Style Prompt input. Preserve the complete
    // user-authored style instead of extracting keywords or silently cutting
    // clauses. The screenplay remains isolated in positivePrompt.
    return [
      "CUSTOM VISUAL STYLE — apply to appearance only:",
      userStyle.slice(0, 1_350),
      "Preserve this medium, linework, shapes, textures, palette, lighting and finish.",
      "Do not reuse subjects, poses, locations or compositions from style examples; scene content comes only from the screenplay prompt.",
    ].join(" ");
  }

  private localSubtitleBreakdown(
    script: string,
    targetCount?: number,
    interval: number = 6
  ): Omit<Scene, 'id' | 'status'>[] {
    const cleanScript = script.replace(/\r/g, "").trim();
    const sentences = cleanScript
      .split(/(?<=[.!?;:])\s+|\n+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const phrases = sentences.flatMap((sentence) => {
      const words = sentence.split(" ").filter(Boolean);
      if (words.length <= 18) return [sentence];
      const chunks: string[] = [];
      for (let index = 0; index < words.length; index += 18) {
        chunks.push(words.slice(index, index + 18).join(" "));
      }
      return chunks;
    });
    const blocks = targetCount
      ? this.splitScriptIntoChunks(phrases.join(" "), targetCount)
      : phrases;

    return blocks.map((subtitle, index) => {
      const totalSec = index * interval;
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;

      return {
        time: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
        subtitle: subtitle || "…",
        action: subtitle || "…",
      };
    });
  }

  private localSceneBreakdown(
    script: string,
    targetCount?: number,
    interval: number = 6
  ): Omit<Scene, 'id' | 'status'>[] {
    const chunks = this.splitScriptIntoChunks(script, targetCount);

    return chunks.map((chunk, index) => {
      const totalSec = index * interval;
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;

      return {
        time: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
        subtitle: chunk,
        action: chunk,
      };
    });
  }

  private splitScriptIntoChunks(script: string, requestedCount?: number): string[] {
    const sentences = script
      .replace(/\r/g, "")
      .split(/(?<=[.!?…])\s+|\n+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter((sentence) => sentence.length > 1);

    if (!sentences.length) {
      const fallback = script.replace(/\s+/g, " ").trim();
      return fallback ? [fallback] : ["Cena sem texto disponível."];
    }
    if (!requestedCount) return sentences;

    const words = sentences.join(" ").split(/\s+/).filter(Boolean);
    const count = Math.max(1, Math.min(requestedCount, words.length));
    return Array.from({ length: count }, (_, index) => {
      const start = Math.floor((index * words.length) / count);
      const end = Math.floor(((index + 1) * words.length) / count);
      return words.slice(start, Math.max(start + 1, end)).join(" ");
    });
  }

  /**
   * Returns a full image URL (https://... or data:...).
   * Do NOT prepend "data:image/jpeg;base64," — the URL is already usable as <img src>.
   */
  async generateFrame(
    scene: Scene, 
    refImageBase64: string | null, 
    style: string,
    characterDescription: string,
    sogniApiKey: string = DEFAULT_SOGNI_API_KEY,
    sogniModel: string = DEFAULT_SOGNI_MODEL,
    signal?: AbortSignal,
    batchId?: string,
    totalScenes: number = 1,
    referenceMode: "style" | "character" = "style",
    qualityMode: ImageQualityMode = "standard",
    imageProvider: "sogni" | "flow" = "sogni",
    approveFlowCredits: boolean = false,
    onProviderFallback?: (message: string) => void,
  ): Promise<{ url: string; prompt: string; stylePrompt: string }> {
    const referenceDescription = referenceMode === "style"
      ? await this.describeStyleReferenceImage(refImageBase64 || "")
      : await this.describeReferenceImage(refImageBase64 || "");
    const configuredStyle = this.prepareKreaStylePrompt(style);
    const styleOnly = referenceMode === "style" && referenceDescription
      ? `${configuredStyle} STYLE DNA EXTRACTED FROM THE UPLOADED REFERENCE: ${referenceDescription}. Apply this same visual language consistently, but never copy the reference content or composition.`
      : configuredStyle;
    const legacyReferenceInstruction = referenceDescription
       ? `\n\nREFERÊNCIA VISUAL (usar somente como estilo e identidade, sem copiar a composição): ${referenceDescription}`
      : refImageBase64
         ? "\n\nREFERÊNCIA VISUAL: preserve apenas identidade, cores, roupa, materiais e proporções da imagem carregada; crie uma composição nova para esta cena."
        : "";
    const referenceInstruction = !refImageBase64
      ? ""
      : referenceMode === "style"
        ? "\n\nSTYLE REFERENCE RULE — STRICT: clone only the reference's visual language (medium, technique, linework, shapes, texture, palette, lighting, contrast and finish). The current screenplay scene is the only source of content. Do not reproduce the reference subject, person, face, clothing, pose, objects, location, background, framing, layout or composition."
        : legacyReferenceInstruction;
    const prompt = `${constructImagePrompt(
      scene.action,
      characterDescription,
      `scene ${scene.id + 1} at ${scene.time}`,
      scene.id,
      Math.max(totalScenes, scene.id + 1),
      scene.subtitle,
      qualityMode,
    )}${referenceInstruction}`;

    const generateWithInternalEngine = async () => {
      console.log(`[CineGen] Gerando imagem via Sogni Unlimited...`);
      const imageUrl = await generateSogniImage({
        prompt,
        stylePrompt: styleOnly,
        referenceMode,
        referenceImage: refImageBase64,
        apiKey: sogniApiKey,
        model: sogniModel,
        width: qualityMode === "studio" ? 1920 : 1280,
        height: qualityMode === "studio" ? 1080 : 720,
        aspectRatio: "16:9",
        seed: Math.floor(Math.random() * 2_147_483_646) + 1,
        batchId,
        sceneKey: `${scene.id + 1}-${scene.time}`,
        signal,
        qualityMode,
      });
      if (imageUrl) {
        return { url: imageUrl, prompt, stylePrompt: styleOnly };
      }
      throw new Error("O motor interno não retornou a imagem.");
    };

    try {
      if (imageProvider === "flow") {
        try {
          console.log(`[CineGen] Gerando imagem pela conta Google Flow conectada...`);
          const imageUrl = await generateFlowImage({
            prompt: `${prompt}\n\nVISUAL STYLE:\n${styleOnly}`,
            referenceImage: refImageBase64,
            aspectRatio: "16:9",
            projectName: "CineGen IA",
            approveCredits: approveFlowCredits,
            signal,
          });
          return { url: imageUrl, prompt, stylePrompt: styleOnly };
        } catch (flowError: any) {
          if (flowError?.name === "AbortError" || signal?.aborted) throw flowError;
          const fallbackMessage =
            `Google Flow indisponível (${flowError?.message || "sem resposta"}). ` +
            "A cena continuará automaticamente no motor interno.";
          console.warn(`[CineGen] ${fallbackMessage}`);
          onProviderFallback?.(fallbackMessage);
          return await generateWithInternalEngine();
        }
      }
      return await generateWithInternalEngine();
    } catch (imageError: any) {
      console.warn("[CineGen] Erro no motor de imagem:", imageError?.message || imageError);
      if (imageError?.name === "AbortError" || signal?.aborted) throw imageError;
      throw new Error(`Falha no motor de imagem: ${imageError?.message || "Erro de conexão"}`);
    }
  }

  async generateVideoMotionPrompt(scene: Scene, style: string, intervalSeconds: number = 6): Promise<string> {
    const defaultPrompt = DEFAULT_LOCKED_ANIMATION_PROMPT;

    if (!this.hasApiKey || !this.ai) {
      return defaultPrompt;
    }

    const prompt = constructVideoMotionPrompt(style, scene.action, intervalSeconds);

    try {
      return await this.executeWithRetry(async () => {
        const response = await this.ai!.models.generateContent({
          model: TEXT_MODEL,
          contents: prompt,
        });

        return response.text?.trim() || defaultPrompt;
      }, 1, 1000);
    } catch (err) {
      return defaultPrompt;
    }
  }
}
