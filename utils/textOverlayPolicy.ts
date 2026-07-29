export const RARE_SHORT_TEXT_MARKER = "RARE_SHORT_TEXT_EXCEPTION";

/**
 * Text is opt-in. A scene only receives the exception when its prompt clearly
 * asks to show/emphasize a short name or label, or uses an explicit
 * [TEXTO: ...] / [TEXT: ...] marker.
 */
export function requestsRareShortText(input: string): boolean {
  const text = input.trim();
  if (!text) return false;

  const explicitMarker =
    /\[(?:texto|text|nome|name)\s*:\s*[^\]\r\n]{1,24}\]/i;
  const requestThenSubject =
    /\b(?:exiba|exibir|mostre|mostrar|destaque|destacar|enfatize|enfatizar|display|show|feature|emphasize)\b[\s\S]{0,100}\b(?:nome|name|texto curto|short text|t[ií]tulo curto|short title|r[oó]tulo curto|short label)\b/i;
  const subjectThenEmphasis =
    /\b(?:nome|name|texto curto|short text|t[ií]tulo curto|short title|r[oó]tulo curto|short label)\b[\s\S]{0,100}(?:^|[\s:,-])(?:em destaque|destacado|ênfase|enfase|prominent|emphasis|emphasized)\b/i;

  return (
    explicitMarker.test(text) ||
    requestThenSubject.test(text) ||
    subjectThenEmphasis.test(text)
  );
}

export function buildVisibleTextPolicy(input: string): string {
  if (requestsRareShortText(input)) {
    return `${RARE_SHORT_TEXT_MARKER}: ACTIVE
The scene explicitly requests one rare short-name emphasis. Render only the exact short name or label supplied by the user, once, with at most two words and no more than 24 characters. Keep it stable, correctly spelled and naturally integrated. Do not invent any additional letters, words, numbers, captions, labels, credits or typographic decoration.`;
  }

  return `${RARE_SHORT_TEXT_MARKER}: INACTIVE
STRICT NO-VISIBLE-TEXT POLICY: Generate no readable or pseudo-readable text anywhere. No letters, words, numbers, captions, subtitles, labels, title cards, credits, logos, watermarks, UI, signs, headlines, document writing or typographic overlays. Also forbid handwriting, typewritten marks, rows of horizontal strokes, squiggles that imitate sentences, map place names, legends, coordinates and letter-like symbols. Documents, newspapers, maps, evidence boards, screens, uniforms and posters must be completely blank and unmarked, or use only large non-text geometric shapes and photographs. Never fill paper with small lines or glyph-like texture.`;
}
