import { readFile } from "node:fs/promises";
import { SogniClient } from "@sogni-ai/sogni-client";

const envText = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator).trim();
      const value = line
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      return [key, value];
    }),
);

if (!env.SOGNI_API_KEY) {
  throw new Error("SOGNI_API_KEY não encontrada no .env.local.");
}

const client = await SogniClient.createInstance({
  appId: "7d2b9f16-a3f4-4e7c-88f2-5b9f66be45e3",
  appSource: "cinegen-ai-studio-audit",
  network: "fast",
  apiKey: env.SOGNI_API_KEY,
  socketEventSubscriptions: {
    modelAvailability: false,
  },
});

const supported = await client.projects.getSupportedModels();
const videoModels = supported
  .filter(
    (model) =>
      model.media === "video" &&
      (model.id.startsWith("ltx23-") || model.id.startsWith("seedance-2-0")),
  )
  .map((model) => ({
    id: model.id,
    name: model.name,
    tier: model.tier,
  }));

const detailed = [];
for (const model of videoModels) {
  try {
    detailed.push({
      ...model,
      options: await client.projects.getModelOptions(model.id),
    });
  } catch (error) {
    detailed.push({
      ...model,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify(detailed, null, 2));
process.exit(0);
