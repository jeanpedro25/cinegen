
import { buildVisibleTextPolicy } from "./utils/textOverlayPolicy";

// Models
export const TEXT_MODEL = 'gemini-3.6-flash';
export const IMAGE_MODEL = 'gemini-3.1-flash-lite-image';

// Prompts
export const constructSceneBreakdownPrompt = (targetCount?: number, interval: number = 6) => `
  Você é um diretor de cinema e artista de storyboard. Analise o roteiro e
  decomponha-o em cenas concretas, únicas e consecutivas.

  ${targetCount ? `Gere EXATAMENTE ${targetCount} cenas para cobrir o roteiro inteiro.` : `Divida o texto em blocos visuais de ${interval} segundos.`}

  FIDELIDADE AO ROTEIRO — REGRA MAIS IMPORTANTE:
  - Percorra o roteiro do início ao fim, em ordem, sem pular, voltar ou repetir trechos.
  - Distribua o conteúdo entre as cenas; cada cena recebe um trecho diferente.
  - "subtitle" deve conter o trecho real do roteiro coberto por aquela cena.
  - "action" deve ilustrar literalmente fatos, lugares, veículos, objetos,
    pessoas, números e acontecimentos citados naquele subtitle.
  - Não invente mapas, gráficos, telas de radar, salas de comando, exércitos
    frente a frente ou infográficos se o trecho não mencionar isso.
  - Não use instruções de estilo visual dentro de "action".
  - Não transforme a narração em legenda, rodapé, título ou texto sobreposto.
  - Não descreva letras, palavras, números ou pseudo-texto em documentos, jornais,
    mapas, telas, uniformes, placas ou painéis. Represente-os sem escrita legível.
  - Exceção raríssima: somente quando o roteiro pedir explicitamente um único
    nome curto em destaque; use exatamente esse nome, uma vez, sem texto adicional.

  DIVERSIDADE VISUAL:
  1. Cada cena representa um clipe visual de ${interval} segundos.
  2. Os tempos começam em 00:00 e avançam exatamente ${interval}s.
  3. Descreva O QUE acontece, ONDE acontece e qual é o sujeito principal.
  4. Varie ambiente, escala do sujeito e tipo de plano entre cenas vizinhas.
  5. Nunca reutilize a mesma descrição, composição ou trecho narrado.

  Retorne somente um array JSON válido, sem Markdown:
  [
    { "time": "00:00", "subtitle": "Trecho real do roteiro.", "action": "Descrição concreta e cinematográfica deste trecho." },
    { "time": "00:${String(interval).padStart(2, '0')}", "subtitle": "Trecho seguinte.", "action": "Próxima ação, sem repetir a anterior." }
  ]
`;

export const constructSubtitleBreakdownPrompt = (targetCount?: number, interval: number = 6) => `
  Você é um editor profissional de legendas para vídeos curtos.
  Divida o texto transcrito/roteiro em blocos de legenda naturais, legíveis e
  sincronizados em intervalos de ${interval} segundos.

  ${targetCount
    ? `Gere exatamente ${targetCount} blocos para cobrir toda a duração do áudio.`
    : `Crie a quantidade de blocos necessária para cobrir todo o texto.`}

  Regras:
  1. Preserve a ordem e o texto real; não invente nem reutilize falas.
  2. Cada "subtitle" contém somente o trecho falado naquele bloco.
  3. "action" ilustra literalmente o próprio subtitle, com sujeito, local e
     acontecimento concretos.
  4. Os tempos começam em 00:00 e avançam exatamente ${interval}s por bloco.
  5. Nunca omita o final do roteiro.
  6. Cada action deve diferir da anterior em conteúdo e composição.
  7. Não invente mapas, gráficos, radares, infográficos, salas de comando ou
     dois exércitos frente a frente quando o subtitle não os mencionar.
  8. Não escreva estilo visual dentro de action.
  9. Não crie legendas, rodapés, títulos ou texto sobreposto na imagem.
  10. Documentos, telas, placas, jornais, mapas e painéis devem permanecer sem
      letras, palavras, números ou pseudo-texto.
  11. Exceção raríssima: somente um nome curto explicitamente pedido para
      destaque, escrito uma única vez e sem qualquer texto adicional.

  Retorne APENAS um array JSON válido:
  [
    { "time": "00:00", "subtitle": "Texto falado neste trecho.", "action": "Resumo visual deste trecho." }
  ]
`;

const CAMERA_ANGLES = [
  "extreme wide establishing shot from a low angle",
  "medium side-profile shot with the main subject in motion",
  "tight close-up with shallow depth of field",
  "over-the-shoulder shot with a strong foreground element",
  "bird's-eye aerial view emphasizing geography",
  "documentary long shot from ground level",
  "first-person point-of-view shot",
  "worm's-eye view with a large sky area",
  "three-quarter view with layered depth",
  "telephoto shot compressing foreground and background",
  "macro detail shot of the decisive object",
  "asymmetrical wide shot with action crossing the frame",
];

const LIGHT_VARIATIONS = [
  "cold blue dawn light with long shadows",
  "hard midday light with crisp shadows",
  "warm golden-hour backlight",
  "overcast diffused light",
  "night practical lighting with controlled highlights",
  "storm light with atmospheric haze",
  "contrasting interior pools of light",
];

const COMPOSITION_VARIATIONS = [
  "main subject on the left third with negative space on the right",
  "centered composition with strong depth",
  "main subject on the right third with leading lines",
  "foreground object framing a distant main subject",
  "high horizon and action concentrated low in frame",
  "low horizon and dominant environment above",
];

export type ImageQualityMode = "standard" | "studio";

interface VisualDirection {
  shot: string;
  composition: string;
  focus: string;
}

function selectSceneAwareDirection(action: string, sceneIndex: number): VisualDirection {
  const text = action.toLowerCase();
  const hasEmotion = /\b(face|rosto|olhos?|express[aã]o|medo|triste|chor|sorr|tens[aã]o|emotion|fear|smile)\b/i.test(text);
  const hasDetail = /\b(detalhe|objeto|documento|m[aã]o|bot[aã]o|arma|rel[oó]gio|mapa|tela|macro|close detail)\b/i.test(text);
  const hasLocation = /\b(cidade|campo|floresta|montanha|oceano|rua|pra[cç]a|base|porto|paisagem|city|forest|mountain|ocean|landscape)\b/i.test(text);
  const hasCrowd = /\b(multid[aã]o|grupo|tropa|soldados|pessoas|ve[ií]culos|frota|crowd|troops|soldiers|fleet)\b/i.test(text);
  const hasMovement = /\b(corre|caminha|voa|avan[cç]a|explode|cai|persegue|decola|moves?|running|flying|advances?|explodes?)\b/i.test(text);

  if (hasEmotion) {
    return {
      shot: "an expressive cinematic close-up or medium close-up chosen to make the emotion readable",
      composition: sceneIndex % 2 === 0
        ? "the face placed on a rule-of-thirds point with meaningful environment context"
        : "a layered over-the-shoulder composition with the emotional subject in sharp focus",
      focus: "precise eyes, facial anatomy, expression, skin or material texture, and natural catchlights",
    };
  }
  if (hasDetail) {
    return {
      shot: "a deliberate close detail or macro insert that clearly reveals the decisive object and its context",
      composition: "strong leading lines and controlled negative space around the important detail",
      focus: "physically plausible materials, tiny surface variation, readable shape hierarchy and clean edges",
    };
  }
  if (hasLocation || hasCrowd) {
    return {
      shot: "a cinematic wide establishing shot with a clear foreground, midground and background",
      composition: COMPOSITION_VARIATIONS[sceneIndex % COMPOSITION_VARIATIONS.length],
      focus: "environmental depth, scale, atmospheric perspective, individually coherent people and vehicles",
    };
  }
  if (hasMovement) {
    return {
      shot: "a dynamic medium-wide action shot captured at the most readable decisive moment",
      composition: "directional movement across the frame, one unmistakable focal subject and balanced motion space",
      focus: "convincing body mechanics, stable anatomy, motion energy without blur obscuring the subject",
    };
  }
  return {
    shot: CAMERA_ANGLES[sceneIndex % CAMERA_ANGLES.length],
    composition: COMPOSITION_VARIATIONS[sceneIndex % COMPOSITION_VARIATIONS.length],
    focus: "clear visual hierarchy, believable materials, coherent anatomy and intentional environmental detail",
  };
}

function stripDirectionNoise(action: string): string {
  return action
    .replace(/Direção visual exclusiva:.*$/is, "")
    .replace(/Não repetir composição de outra cena\.?/gi, "")
    .replace(/Enquadramento exclusivo da cena \d+:.*$/is, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function detectNarrativeLanguage(text: string): string {
  const normalized = ` ${text.toLowerCase().replace(/[^\p{L}\s]/gu, " ")} `;
  const score = (words: string[]) =>
    words.reduce((total, word) => total + (normalized.includes(` ${word} `) ? 1 : 0), 0);

  const portuguese = score(["que", "não", "uma", "para", "com", "como", "dos", "das", "está", "foi", "pela", "pelo"]);
  const spanish = score(["que", "un", "una", "para", "con", "como", "el", "la", "los", "las", "está", "fue", "del"]);
  const english = score(["the", "that", "with", "from", "this", "was", "were", "for", "and", "into"]);

  if (portuguese >= spanish && portuguese >= english && portuguese > 0) return "Brazilian Portuguese";
  if (spanish >= english && spanish > 0) return "Spanish";
  if (english > 0) return "English";
  return "the same language used by the scene description";
}

export const constructImagePrompt = (
  action: string,
  charDesc: string,
  sceneIdentity: string,
  sceneIndex: number = 0,
  totalScenes: number = 1,
  subtitle?: string,
  qualityMode: ImageQualityMode = "standard",
) => {
  const cleanAction = stripDirectionNoise(action);
  const narrativeLanguage = detectNarrativeLanguage(`${subtitle || ""} ${cleanAction}`);
  const direction = selectSceneAwareDirection(cleanAction, sceneIndex);
  const qualityDirection = qualityMode === "studio"
    ? `
STUDIO QUALITY PASS:
- Resolve the image as a polished production keyframe, not a rough concept sketch.
- Preserve small, scene-specific evidence: period-correct props, functional construction, believable materials, surface wear, fabric behavior, reflections and environmental storytelling.
- Use physically coherent key light, fill, bounce light, contact shadows, ambient occlusion and atmospheric depth.
- Keep the focal subject crisp and readable while secondary detail supports rather than competes with it.
- Faces, hands, eyes, vehicles, architecture and repeated patterns must remain anatomically and structurally coherent.
- Deliver refined edges, controlled micro-contrast, smooth tonal transitions and professional cinematic color grading.
`
    : "Render a clean, coherent and professionally finished storyboard frame.";
  const visibleTextPolicy = buildVisibleTextPolicy(cleanAction);

  return `
SCENE CONTENT — HIGHEST PRIORITY:
Create one cinematic 16:9 image depicting exactly this scene: ${cleanAction}.
The scene description above is the sole authority for content. Every subject, action, object and location must come from this scene, not from a style reference.
Show the concrete subjects, objects, location and event naturally inside the image.
Character continuity context: ${charDesc}.

VISUAL DIRECTION:
Use ${direction.shot}.
Composition: ${direction.composition}.
Priority detail: ${direction.focus}.
Lighting foundation: ${LIGHT_VARIATIONS[sceneIndex % LIGHT_VARIATIONS.length]} adapted naturally to the location and time described by the scene.

This is scene ${sceneIndex + 1} of ${totalScenes}; create a new camera position, pose, foreground, background and silhouette instead of copying another frame.
If a style reference exists, clone its visual language only: medium, technique, linework, shapes, texture, palette, lighting, contrast and finish. Never copy its person, subject, pose, objects, location, framing, layout or background.
Make this scene visually distinct from every other scene while keeping the same art direction.
${qualityDirection}

OUTPUT HYGIENE:
The final image must fill the entire frame. Do not add captions, subtitles, lower thirds, footers, title cards, credits, labels beneath the image, prompt text, technical notes, borders, white strips or black strips.
${visibleTextPolicy}
If the rare exception is active, the allowed short name must be written in ${narrativeLanguage}. Otherwise every surface must remain free of letter-like glyphs.
No collage, split screen, contact sheet, comparison layout, duplicated subject, generic poster composition or reused pose.
`;
};

export const constructVideoMotionPrompt = (style: string, action: string, intervalSeconds: number = 6) => `
  Você é um Diretor de Animação e Especialista em Geradores de Vídeo por IA.
  Análise a imagem estática de referência desta cena e a sua descrição.
  
  ESTILO: ${style}
  AÇÃO DA CENA: ${action}
  DURAÇÃO DO CLIPE: ${intervalSeconds} segundos
  
  Crie um PROMPT DE MOVIMENTO DE VÍDEO (Image-to-Video Prompt) cinematográfico e direto que instrua a IA de vídeo como animar esta cena durante os ${intervalSeconds} segundos.
  
  Estrutura exigida no prompt retornado:
  1. Movimento de Câmera: (ex: "Slow cinematic zoom in, subtle pan right")
  2. Ação e Animação do Personagem: descreva movimentos coerentes com o estilo escolhido, sem impor massinha ou stop-motion.
  3. Iluminação & Atmosfera: (ex: "Flickering warm candle light, subtle dust particles floating in the air")
  4. ÁUDIO OBRIGATÓRIO: gere somente efeitos sonoros diegéticos sincronizados com ações visíveis e ambiência natural discreta. É PROIBIDO gerar música, trilha sonora, score, instrumentos, canto, voz humana, fala, diálogo, locução, narração, voice-over, sincronização labial ou sons vocais. Mesmo que o roteiro contenha falas, nunca transforme o texto em voz. Se a cena não exigir um efeito sonoro, gere silêncio.
  
  Responda APENAS com o texto final do prompt de movimento formatado de forma limpa, pronto para ser copiado ou enviado para a API de Vídeo.
`;
