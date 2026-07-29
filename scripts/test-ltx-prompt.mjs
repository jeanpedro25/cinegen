import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { hmr: false, middlewareMode: true },
});

try {
  const {
    buildLtxAnimationPrompt,
    DEFAULT_LOCKED_ANIMATION_PROMPT,
  } = await vite.ssrLoadModule("/utils/ltxPrompt.ts");

  const manualDirection =
    "The red flag moves gently from left to right while the camera remains locked";
  const firstPass = buildLtxAnimationPrompt(manualDirection);
  const secondPass = buildLtxAnimationPrompt(firstPass);
  const locked = buildLtxAnimationPrompt(DEFAULT_LOCKED_ANIMATION_PROMPT);

  assert.equal(
    secondPass,
    firstPass,
    "Regenerar não pode duplicar o contrato de animação.",
  );
  assert.match(firstPass, /red flag moves gently from left to right/i);
  assert.doesNotMatch(firstPass, /\bpan(?:s|ning)?\b|\bzoom\b/i);
  assert.match(locked, /camera remains locked/i);
  assert.match(locked, /every subject and object remains still/i);

  console.log(
    JSON.stringify({
      idempotent: true,
      manualDirectionPreserved: true,
      inventedCameraMotion: false,
      lockedFallback: true,
      promptLength: firstPass.length,
    }),
  );
} finally {
  await vite.close();
}
