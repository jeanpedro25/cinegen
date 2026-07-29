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
  const { getSceneStatusDisplay } = await vite.ssrLoadModule(
    "/utils/sceneStatus.ts",
  );
  const baseScene = {
    id: 1,
    time: "00:00",
    action: "Cena de teste",
    mediaType: "video",
    status: "pending",
    videoStatus: "idle",
  };

  assert.equal(
    getSceneStatusDisplay({ ...baseScene, status: "queued" }).label,
    "Na fila · imagem",
  );
  assert.equal(
    getSceneStatusDisplay({ ...baseScene, status: "generating" }).label,
    "Gerando imagem",
  );
  assert.equal(
    getSceneStatusDisplay({
      ...baseScene,
      status: "completed",
      videoStatus: "queued",
    }).label,
    "Na fila · vídeo",
  );
  assert.equal(
    getSceneStatusDisplay({
      ...baseScene,
      status: "completed",
      videoStatus: "generating",
    }).label,
    "Gerando vídeo",
  );
  assert.equal(
    getSceneStatusDisplay({
      ...baseScene,
      status: "completed",
      videoStatus: "completed",
    }).label,
    "Vídeo pronto",
  );

  console.log(
    JSON.stringify({
      queuedImage: true,
      generatingImage: true,
      queuedVideo: true,
      generatingVideo: true,
      completedVideo: true,
    }),
  );
} finally {
  await vite.close();
}
