const FLOW_HOME = "https://labs.google/fx/pt/tools/flow";
const CINEGEN_APIS = [
  "http://127.0.0.1:3003/api/cinegen/flow",
  "http://127.0.0.1:3002/api/cinegen/flow",
];
const FLOW_TAB_PATTERNS = [
  "https://labs.google/fx/*",
  "https://labs.google/flow/*",
  "https://flow.google/*",
];
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
let syncPromise = null;

async function api(path, options = {}) {
  let lastError = null;
  for (const baseUrl of CINEGEN_APIS) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        cache: "no-store",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("O CineGen local não está acessível.");
}

async function flowTabs() {
  return await chrome.tabs.query({ url: FLOW_TAB_PATTERNS });
}

async function ensureFlowAgent(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "CINEGEN_FLOW_PAGE_STATUS" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["flow-agent.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return await chrome.tabs.sendMessage(tabId, { type: "CINEGEN_FLOW_PAGE_STATUS" });
  }
}

async function notifyFlowAgent(tabId) {
  try {
    await ensureFlowAgent(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "CINEGEN_FLOW_PROCESS_QUEUE" });
  } catch {
    // A página ainda está navegando. O content script e o próximo ciclo retomam.
  }
}

async function inspectFlowTab() {
  const tabs = await flowTabs();
  const tab = tabs.find((item) => item.url?.includes("/project/")) || tabs[0];
  let pageStatus = {};
  if (tab?.id) {
    try {
      pageStatus = await ensureFlowAgent(tab.id);
    } catch {
      pageStatus = {};
    }
  }
  return {
    tab,
    status: {
      connected: Boolean(tab && pageStatus?.signedIn),
      plan: pageStatus?.plan,
      tabUrl: tab?.url,
      extensionVersion: chrome.runtime.getManifest().version,
    },
  };
}

async function getStoredJob(jobId) {
  const key = `job:${jobId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key];
}

async function clearActiveJob(jobId) {
  const stored = await chrome.storage.local.get("activeFlowJobId");
  if (!jobId || stored.activeFlowJobId === jobId) {
    await chrome.storage.local.set({ activeFlowJobId: null });
  }
}

async function cancelStoredJobs(jobId) {
  const stored = await chrome.storage.local.get(null);
  const updates = {};
  let cancelled = 0;
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith("job:") || !value?.id) continue;
    if (jobId && value.id !== jobId) continue;
    if (TERMINAL_STATUSES.has(value.status)) continue;
    updates[key] = {
      ...value,
      status: "cancelled",
      error: "Tarefa cancelada pelo usuário.",
      updatedAt: Date.now(),
    };
    cancelled += 1;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await clearActiveJob(jobId);
  return cancelled;
}

async function runSync() {
  const { tab, status } = await inspectFlowTab();
  await api("/heartbeat", {
    method: "POST",
    body: JSON.stringify(status),
  });

  const command = await api("/open");
  if (command?.openFlow) {
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
    else await chrome.tabs.create({ url: FLOW_HOME, active: true });
  }

  let { activeFlowJobId } = await chrome.storage.local.get("activeFlowJobId");
  if (activeFlowJobId) {
    const activeJob = await getStoredJob(activeFlowJobId);
    if (!activeJob || TERMINAL_STATUSES.has(activeJob.status)) {
      await clearActiveJob(activeFlowJobId);
      activeFlowJobId = null;
    }
  }

  if (!activeFlowJobId) {
    const next = await api("/jobs/next");
    if (next?.job?.id) {
      const job = next.job;
      await chrome.storage.local.set({
        [`job:${job.id}`]: job,
        activeFlowJobId: job.id,
      });
      activeFlowJobId = job.id;
    }
  }

  if (activeFlowJobId) {
    let target = tab;
    if (!target?.id) {
      target = await chrome.tabs.create({ url: FLOW_HOME, active: false });
    }
    if (target?.id) await notifyFlowAgent(target.id);
  }
}

async function syncWithCineGen() {
  if (syncPromise) return await syncPromise;
  syncPromise = runSync()
    .catch(() => undefined)
    .finally(() => {
      syncPromise = null;
    });
  return await syncPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("cinegen-flow-sync", { periodInMinutes: 0.5 });
  void syncWithCineGen();
});
chrome.runtime.onStartup.addListener(() => void syncWithCineGen());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cinegen-flow-sync") void syncWithCineGen();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    (/^https:\/\/labs\.google\/(?:fx|flow)\//i.test(tab.url) || /^https:\/\/flow\.google\//i.test(tab.url))
  ) {
    void syncWithCineGen();
  }
});
void syncWithCineGen();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "CINEGEN_FLOW_STATUS") {
      const { status } = await inspectFlowTab();
      sendResponse({ ok: true, payload: status });
      return;
    }

    if (message.type === "CINEGEN_FLOW_OPEN") {
      const tabs = await flowTabs();
      if (tabs[0]?.id) {
        await chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        await chrome.tabs.create({ url: FLOW_HOME, active: true });
      }
      sendResponse({ ok: true, payload: { opened: true } });
      return;
    }

    if (message.type === "CINEGEN_FLOW_WAKE") {
      await syncWithCineGen();
      const { tab } = await inspectFlowTab();
      if (tab?.id) await notifyFlowAgent(tab.id);
      sendResponse({ ok: true, payload: { awake: true } });
      return;
    }

    if (message.type === "CINEGEN_FLOW_CANCEL") {
      const cancelled = await cancelStoredJobs(message.payload?.jobId);
      sendResponse({ ok: true, payload: { cancelled } });
      return;
    }

    // Compatibilidade com clientes anteriores.
    if (message.type === "CINEGEN_FLOW_GENERATE") {
      const jobId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const job = {
        id: jobId,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...message.payload,
      };
      await chrome.storage.local.set({ [`job:${jobId}`]: job, activeFlowJobId: jobId });
      await syncWithCineGen();
      sendResponse({ ok: true, payload: { jobId } });
      return;
    }

    if (message.type === "CINEGEN_FLOW_JOB_STATUS") {
      const job = await getStoredJob(message.payload?.jobId);
      sendResponse({ ok: true, payload: job || { status: "missing" } });
      return;
    }

    if (message.type === "CINEGEN_FLOW_JOB_UPDATE") {
      const job = message.payload;
      if (!job?.id) {
        sendResponse({ ok: false, error: "Tarefa Flow inválida." });
        return;
      }
      const updated = { ...job, updatedAt: Date.now() };
      await chrome.storage.local.set({ [`job:${job.id}`]: updated });
      await api("/jobs/update", {
        method: "POST",
        body: JSON.stringify(updated),
      });
      if (TERMINAL_STATUSES.has(updated.status)) {
        await clearActiveJob(updated.id);
        void syncWithCineGen();
      }
      sendResponse({ ok: true, payload: { updated: true } });
      return;
    }

    if (message.type === "CINEGEN_FLOW_FETCH_AS_DATA_URL") {
      const mediaUrl = message.payload?.url;
      if (!mediaUrl || !/^(https?:|blob:|data:)/i.test(mediaUrl)) {
        sendResponse({ ok: false, error: "URL de mídia inválida." });
        return;
      }
      if (mediaUrl.startsWith("data:")) {
        sendResponse({ ok: true, payload: { dataUrl: mediaUrl } });
        return;
      }
      const mediaResponse = await fetch(mediaUrl);
      if (!mediaResponse.ok) {
        throw new Error(`Flow retornou HTTP ${mediaResponse.status} ao baixar a mídia.`);
      }
      const blob = await mediaResponse.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      sendResponse({
        ok: true,
        payload: {
          dataUrl: `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`,
        },
      });
      return;
    }

    sendResponse({ ok: false, error: "Comando desconhecido." });
  })().catch((error) => sendResponse({
    ok: false,
    error: error?.message || String(error),
  }));
  return true;
});
