const ALLOWED_TYPES = new Set([
  "CINEGEN_FLOW_STATUS",
  "CINEGEN_FLOW_OPEN",
  "CINEGEN_FLOW_GENERATE",
  "CINEGEN_FLOW_JOB_STATUS",
  "CINEGEN_FLOW_WAKE",
  "CINEGEN_FLOW_CANCEL",
]);

window.addEventListener("message", async (event) => {
  if (
    event.source !== window ||
    event.origin !== window.location.origin ||
    event.data?.source !== "cinegen-ai-studio" ||
    !ALLOWED_TYPES.has(event.data?.type)
  ) return;

  try {
    const payload = await chrome.runtime.sendMessage({
      type: event.data.type,
      payload: event.data.payload,
    });
    window.postMessage({
      source: "cinegen-flow-connector",
      requestId: event.data.requestId,
      ok: payload?.ok !== false,
      payload: payload?.payload,
      error: payload?.error,
    }, window.location.origin);
  } catch (error) {
    window.postMessage({
      source: "cinegen-flow-connector",
      requestId: event.data.requestId,
      ok: false,
      error: error?.message || String(error),
    }, window.location.origin);
  }
});
