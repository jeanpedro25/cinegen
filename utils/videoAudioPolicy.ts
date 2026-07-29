export const VIDEO_SFX_NEGATIVE_PROMPT =
  "music, soundtrack, score, melody, instruments, singing, vocals, human voice, speech, spoken words, dialogue, narration, narrator, voice-over, announcer, whisper, shout, scream, chant, grunt, gasp, breathing, mouth sounds, lip sync, talking mouth";

export const VIDEO_NO_TEXT_NEGATIVE_PROMPT =
  "subtitles, captions, text, letters, words, numbers, gibberish typography, pseudo-text, title cards, credits, labels, headlines, document writing, handwriting, typewritten marks, rows of horizontal strokes, sentence-like squiggles, map labels, map legends, coordinates, glyph-like texture, UI text, signage, logo, watermark";

export const VIDEO_RARE_TEXT_NEGATIVE_PROMPT =
  "paragraphs, sentences, multiple labels, extra words, misspelled text, gibberish typography, pseudo-text, captions, subtitles, credits, logo, watermark";

export const SFX_ONLY_AUDIO_DIRECTIVE = `
Every person remains silent with a closed mouth, and the audio contains only synchronized diegetic effects caused by the explicitly requested visible action plus subtle natural ambience; a shot with no requested sound-producing action remains silent.`.trim();

/**
 * LTX 2.3 treats quoted narration and phrases such as "narration beat" as
 * dialogue instructions. Strip that material while preserving visual motion,
 * camera, environment and continuity directions.
 */
export function buildSfxOnlyVideoPrompt(input: string): string {
  let visualPrompt = input.trim();

  // Keep retries and server-side validation idempotent.
  visualPrompt = visualPrompt
    .split(/\n\s*(?:AUDIO REQUIREMENT|AUDIO POLICY|SILENT CHARACTER PERFORMANCE)\b/i)[0]
    .trim();

  visualPrompt = visualPrompt
    .replace(
      /create\s+a\s+short\s+animated\s+shot\s+for\s+this\s+exact\s+narration\s+beat\s*:\s*(?:“[^”]*”|"[^"]*"|'[^']*')\.?/gi,
      "Create a short silent cinematic animation of the existing keyframe.",
    )
    .replace(
      /story\s+context\s+from\s+the\s+neighboring\s+subtitles\s*:[\s\S]*?(?=(?:visualize|composition|camera|use\s+subtle|the\s+shot\s+must|visual\s+style|keep\s+every|no\s+morphing)\b)/gi,
      "Maintain visual continuity with the neighboring shots. ",
    )
    .replace(
      /(?:^|\n)\s*(?:narração|narracao|narration|fala|spoken\s+line|dialogue|diálogo|dialogo|subtitle|legenda)\s*:\s*[^\n]*/gi,
      "\n",
    )
    .replace(
      /\b(?:speaks?|says?|talks?|whispers?|shouts?|screams?|sings?|chants?|narrates?|lip[- ]?syncs?|voice[- ]?over|fala|diz|conversa|sussurra|grita|canta|narra)\b(?:\s*[:,-]?\s*(?:“[^”\n]{1,1000}”|"[^"\n]{1,1000}"|'[^'\n]{1,1000}'))?/gi,
      "remains silent with mouth closed",
    )
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!visualPrompt) {
    visualPrompt =
      "Hold the existing keyframe with a locked camera and no subject motion. Do not invent movement.";
  }

  return `${visualPrompt.replace(/\s+/g, " ")} ${SFX_ONLY_AUDIO_DIRECTIVE}`
    .replace(/\s+/g, " ")
    .trim();
}
