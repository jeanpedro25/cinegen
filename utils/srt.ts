export interface SrtCue {
  index: number;
  startSeconds: number;
  endSeconds: number;
  startTimestamp: string;
  endTimestamp: string;
  text: string;
}

const TIMESTAMP_PATTERN =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

export function parseSrtTimestamp(value: string): number | null {
  const match = value.trim().match(TIMESTAMP_PATTERN);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds.padEnd(3, "0")) / 1000
  );
}

export function formatTimelineTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * Lê SRT sem descartar os timestamps. Cada cue continua independente para
 * legenda, enquanto as cenas visuais podem agrupar vários cues em sequência.
 */
export function parseSrtCues(content: string): SrtCue[] {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim();
  if (!normalized) return [];

  const cues: SrtCue[] = [];
  const blocks = normalized.split(/\n{2,}/);

  blocks.forEach((block, blockIndex) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return;

    const [rawStart, rawEnd] = lines[timingIndex].split("-->").map((part) => part.trim());
    const startSeconds = parseSrtTimestamp(rawStart);
    const endSeconds = parseSrtTimestamp(rawEnd);
    if (
      startSeconds === null ||
      endSeconds === null ||
      endSeconds <= startSeconds
    ) {
      return;
    }

    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;

    const declaredIndex =
      timingIndex > 0 && /^\d+$/.test(lines[timingIndex - 1])
        ? Number(lines[timingIndex - 1])
        : blockIndex + 1;

    cues.push({
      index: declaredIndex,
      startSeconds,
      endSeconds,
      startTimestamp: rawStart,
      endTimestamp: rawEnd,
      text,
    });
  });

  return cues.sort((left, right) => left.startSeconds - right.startSeconds);
}

