import type { IncomingMessage, ServerResponse } from "node:http";
// A extensão explícita faz a Vercel incluir e transpilar este módulo junto
// com a função, em vez de deixá-lo como import externo do runtime ESM.
import { createCinegenApiHandler } from "../../server/sogniBackend.ts";

export const config = {
  maxDuration: 60,
};

const handler = createCinegenApiHandler(
  process.env.SOGNI_API_KEY || "",
  process.env.GEMINI_API_KEY || "",
  process.env.CINEGEN_ENGINE_URL || "",
);

export default async function cinegenApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await handler(request, response);
}
