import {
  RARE_SHORT_TEXT_MARKER,
  requestsRareShortText,
} from "./textOverlayPolicy.ts";

export const DEFAULT_LOCKED_ANIMATION_PROMPT =
  "The camera remains locked. Every subject and object remains still unless the user's animation prompt explicitly requests movement.";

function extractAnimationDirection(direction: string): string {
  const legacyDirection = direction.match(
    /ANIMATION DIRECTIONS:\s*([\s\S]*?)(?:\n\s*Keep motion physically coherent|$)/i,
  )?.[1];
  const currentContractDirection = direction.match(
    /The only requested motion is:\s*([\s\S]*?)\.\s*Treat that direction as exhaustive:/i,
  )?.[1];
  const balancedContractDirection = direction.match(
    /perform only the following requested motion:\s*([\s\S]*?)[.!?]\s*Treat this instruction as exhaustive\./i,
  )?.[1];

  return (
    balancedContractDirection ||
    currentContractDirection ||
    legacyDirection ||
    direction ||
    DEFAULT_LOCKED_ANIMATION_PROMPT
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function buildLtxAnimationPrompt(direction: string): string {
  const cleanDirection = extractAnimationDirection(direction);
  const visibleTextDirection = requestsRareShortText(cleanDirection)
    ? `${RARE_SHORT_TEXT_MARKER}: ACTIVE. Render only the exact short name explicitly requested by the user, once, without adding other text.`
    : `${RARE_SHORT_TEXT_MARKER}: INACTIVE. Introduce no new visible or pseudo-readable text, captions, labels, logos or watermarks.`;
  const directionSentence = /[.!?]$/.test(cleanDirection)
    ? cleanDirection
    : `${cleanDirection}.`;

  return `The supplied image is the exact first frame and visual reference for one continuous shot. In that shot, perform only the following requested motion: ${directionSentence} Treat this instruction as exhaustive. Every unmentioned person, body part, object, camera axis and environmental element remains unchanged and still. Preserve subject identity, face, anatomy, clothing, objects, setting, colors, lighting, framing and composition. ${visibleTextDirection} Every character remains silent with a closed mouth. Audio contains only synchronized diegetic effects directly caused by the requested visible motion and subtle natural ambience.`
    .replace(/\s+/g, " ")
    .trim();
}
