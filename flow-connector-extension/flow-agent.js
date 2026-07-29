// CineGen Flow Agent — embrulhado em IIFE para isolar escopo e evitar conflitos
// de redeclaração quando duas extensões estão instaladas ou quando o script é
// re-injetado via chrome.scripting.executeScript.
(function cinegenFlowAgent() {
  // ── Guarda contra dupla execução ─────────────────────────────────────────
  if (window.__cinegenFlowAgent) {
    // Já carregado — apenas dispara a fila
    if (typeof window.__cinegenFlowProcessQueue === "function") {
      window.__cinegenFlowProcessQueue();
    }
    return;
  }
  window.__cinegenFlowAgent = true;
  window.__cinegenFlowAgentVersion = "2.0.0";

  // ── Utilitários ──────────────────────────────────────────────────────────
  let processing = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findButton(match) {
    return [...document.querySelectorAll("button, a, [role='button']")].find((button) => (
      visible(button) && match(textOf(button), button.getAttribute("aria-label") || button.getAttribute("title") || "")
    ));
  }

  function findRole(role, match) {
    return [...document.querySelectorAll(`[role="${role}"]`)].find((element) => (
      visible(element) && match(textOf(element), element.getAttribute("aria-label") || "")
    ));
  }

  async function waitFor(find, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = find();
      if (result) return result;
      await wait(300);
    }
    throw new Error("Controle do Google Flow não foi encontrado.");
  }

  // ── Estado da página ─────────────────────────────────────────────────────
  function pageStatus() {
    const profile = [...document.querySelectorAll("button, [role='button']")].find((element) => {
      if (!visible(element)) return false;
      const imageLabels = [...element.querySelectorAll("img")]
        .map((image) => `${image.alt || ""} ${image.title || ""}`)
        .join(" ");
      const identity = [
        textOf(element),
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        imageLabels,
      ].join(" ");
      return (
        /perfil|profile|conta do google|google account|account circle|imagem do perfil do usu[aá]rio/i.test(identity) ||
        /^(PRO|ULTRA)$/i.test(textOf(element))
      );
    });
    const signIn = findButton((text, label) => (
      /fazer login|sign in|entrar com google|continue with google/i.test(`${text} ${label}`)
    ));
    const insideProject = /\/tools\/flow\/project\//i.test(location.pathname);
    const hasAccountProjects = Boolean(
      document.querySelector('a[href*="/tools/flow/project/"]') ||
      findButton((text, label) => /novo projeto|new project/i.test(`${text} ${label}`)),
    );
    const pageText = textOf(document.body).slice(0, 12_000);
    const creditMatch = pageText.match(/(\d[\d.,]*)\s+(?:cr[eé]ditos?|credits?)(?:\s+do\s+google\s+flow)?/i);
    const plan = /\bULTRA\b/i.test(pageText)
      ? "Ultra"
      : /\bPRO\b/i.test(pageText)
        ? "Pro"
        : creditMatch
          ? `${creditMatch[1]} créditos`
          : profile || insideProject
            ? "Conectado"
            : undefined;
    return {
      signedIn: !signIn && Boolean(profile || insideProject || hasAccountProjects || plan),
      accountEvidence: Boolean(profile || insideProject || hasAccountProjects || plan),
      plan,
      agentVersion: window.__cinegenFlowAgentVersion,
    };
  }

  // ── Atualização de job ────────────────────────────────────────────────────
  async function updateJob(job, clearActive = false) {
    const updatedJob = { ...job, updatedAt: Date.now() };
    const values = { [`job:${job.id}`]: updatedJob };
    if (clearActive) values.activeFlowJobId = null;
    await chrome.storage.local.set(values);
    try {
      await chrome.runtime.sendMessage({
        type: "CINEGEN_FLOW_JOB_UPDATE",
        payload: updatedJob,
      });
    } catch {
      // O estado local será sincronizado novamente quando o CineGen estiver acessível.
    }
  }

  async function readJob(jobId) {
    const key = `job:${jobId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key];
  }

  async function keepJobAlive(jobId, lastHeartbeat) {
    if (Date.now() - lastHeartbeat < 10_000) return lastHeartbeat;
    const current = await readJob(jobId);
    if (!current || current.status === "cancelled") {
      throw new DOMException("Tarefa Flow cancelada.", "AbortError");
    }
    await updateJob({ ...current, status: "generating" });
    return Date.now();
  }

  // ── Configurações de vídeo ────────────────────────────────────────────────
  async function chooseVideoSettings(job) {
    const formatButton = await waitFor(() => findButton((text) => (
      /Nano Banana|Vídeo|Video/.test(text) && /1x/.test(text)
    )));
    formatButton.click();

    const videoTab = await waitFor(() => findRole("tab", (text) => /Vídeo|Video/i.test(text)));
    videoTab.click();
    await wait(300);

    const framesTab = findRole("tab", (text) => /Frames/i.test(text));
    framesTab?.click();

    const ratioTab = await waitFor(() => findRole("tab", (text) => text.includes(job.aspectRatio || "16:9")));
    ratioTab.click();

    const modelButton = await waitFor(() => findButton((text) => /Veo 3\.1/.test(text)));
    modelButton.click();
    const wantedModel = job.model || "Veo 3.1 - Fast";
    const modelOption = await waitFor(() => findButton((text) => text.includes(wantedModel)));
    modelOption.click();
  }

  // ── Imagem de referência ──────────────────────────────────────────────────
  async function attachReferenceImage(imageUrl) {
    if (!imageUrl) return;
    const addMedia = findButton((text, label) => /Adicionar mídia|Add media/i.test(`${text} ${label}`));
    if (!addMedia) return;
    addMedia.click();
    const input = await waitFor(() => document.querySelector('input[type="file"]'), 5000).catch(() => null);
    if (!input) return;

    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error("Não foi possível carregar o quadro-base no Flow.");
    const blob = await response.blob();
    const file = new File([blob], "cinegen-reference.png", { type: blob.type || "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(300);
  }

  // ── Editor de prompt ──────────────────────────────────────────────────────
  function promptEditorScore(element) {
    if (!visible(element) || element.closest("nav")) return -1;
    const identity = [
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-placeholder"),
    ].filter(Boolean).join(" ");
    if (/buscar|search|pesquisar/i.test(identity)) return -1;
    let score = 0;
    if (/o que voc[eê] quer criar|what do you want to create|descreva|describe|prompt/i.test(identity)) {
      score += 100;
    }
    const rect = element.getBoundingClientRect();
    score += Math.min(30, rect.width / 20);
    score += Math.min(20, rect.height / 5);
    score += Math.min(15, rect.top / 80);
    return score;
  }

  function findPromptEditor() {
    const raw = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')]
      .map((element) => ({ element, score: promptEditorScore(element) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)[0]?.element;

    if (raw && !("value" in raw) && raw.getAttribute("contenteditable") !== "true") {
      const childEditable = raw.querySelector('[contenteditable="true"]');
      if (childEditable) return childEditable;
    }
    return raw;
  }

  async function enterPrompt(prompt) {
    const editor = await waitFor(findPromptEditor);
    editor.focus();
    await wait(150);

    if ("value" in editor) {
      // Textarea / input — usa setter nativo do React para garantir disparo do onChange
      const prototype = editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(editor, prompt);
      else editor.value = prompt;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // contenteditable (React / Slate.js) — limpa e insere via execCommand nativo
      editor.focus();

      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.addRange(range);
      }

      document.execCommand("delete", false);
      await wait(60);
      document.execCommand("insertText", false, prompt);
      await wait(100);

      // Dispara eventos nativos de input para garantir atualização dos botões do Flow
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await wait(250);
    const currentValue = "value" in editor
      ? editor.value
      : (editor.innerText || editor.textContent || "");
    if (!currentValue || currentValue.trim().length < Math.min(20, prompt.trim().length)) {
      throw new Error("O Google Flow não aceitou o texto no campo de prompt.");
    }
    return editor;
  }

  async function submitPrompt(editor) {
    await wait(300);

    const containers = [];
    let current = editor;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      containers.push(current);
      current = current.parentElement;
    }

    const isSubmitButton = (button) => {
      if (!visible(button)) return false;
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      const identity = `${textOf(button)} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`;
      // Ignora botão de adicionar mídia (add_2)
      if (/add_2|adicionar/i.test(identity)) return false;
      return /arrow_forward|arrow_upward|send|enviar|criar|create|gerar|generate/i.test(identity);
    };

    // 1. Tenta encontrar botão de envio habilitado
    let submit = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      for (const container of containers) {
        const btn = [...container.querySelectorAll("button")].find((b) => isSubmitButton(b));
        if (btn) { submit = btn; break; }
      }
      if (!submit) {
        submit = [...document.querySelectorAll("button")].find((b) => isSubmitButton(b));
      }
      if (submit) break;
      await wait(300);
    }

    if (!submit) {
      throw new Error(
        "O botão Criar do Google Flow permaneceu desabilitado. O prompt não foi enviado e nenhum crédito foi consumido.",
      );
    }

    submit.click();
  }

  // ── Detecção de resultado ─────────────────────────────────────────────────
  function currentLargeImageUrls() {
    return new Set(
      [...document.querySelectorAll("img")]
        .filter((image) => (image.naturalWidth >= 200 || image.getBoundingClientRect().width >= 200))
        .map((image) => image.currentSrc || image.src)
        .filter(Boolean),
    );
  }

  async function waitForImage(jobId, previousUrls, approveCredits) {
    const started = Date.now();
    let lastHeartbeat = 0;
    while (Date.now() - started < 18 * 60 * 1000) {
      lastHeartbeat = await keepJobAlive(jobId, lastHeartbeat);
      if (approveCredits) {
        const approve = [...document.querySelectorAll("span, p, div, button, [role='button']")]
          .find((element) => (
            visible(element) &&
            element.children.length === 0 &&
            /^(aprovar|approve)$/i.test(textOf(element))
          ));
        if (approve && !approve.disabled) {
          approve.click();
          await wait(200);
        }
      }
      const candidates = [...document.querySelectorAll("img")]
        .filter((image) => (
          visible(image) &&
          (image.naturalWidth >= 256 || image.getBoundingClientRect().width >= 200) &&
          (image.naturalHeight >= 144 || image.getBoundingClientRect().height >= 120)
        ))
        .map((image) => ({
          url: image.currentSrc || image.src,
          area: (image.naturalWidth || image.getBoundingClientRect().width) * (image.naturalHeight || image.getBoundingClientRect().height),
        }))
        .filter((item) => (
          item.url &&
          !previousUrls.has(item.url) &&
          !item.url.includes("avatar") &&
          !item.url.includes("profile") &&
          /^(https?:|blob:|data:)/i.test(item.url)
        ))
        .sort((a, b) => b.area - a.area);
      if (candidates[0]?.url) return candidates[0].url;
      await wait(250);
    }
    throw new Error("O Flow não retornou a imagem dentro do tempo esperado.");
  }

  async function portableImageUrl(url) {
    try {
      const localResponse = await fetch(url);
      if (localResponse.ok) {
        const blob = await localResponse.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        if (typeof dataUrl === "string") return dataUrl;
      }
    } catch {
      // URLs protegidas pelo Google são baixadas pelo service worker abaixo.
    }
    const response = await chrome.runtime.sendMessage({
      type: "CINEGEN_FLOW_FETCH_AS_DATA_URL",
      payload: { url },
    });
    if (!response?.ok || !response?.payload?.dataUrl) {
      throw new Error(response?.error || "Não foi possível transferir a imagem do Flow para o CineGen.");
    }
    return response.payload.dataUrl;
  }

  async function waitForVideo(jobId, previousUrls) {
    const started = Date.now();
    let lastHeartbeat = 0;
    while (Date.now() - started < 18 * 60 * 1000) {
      lastHeartbeat = await keepJobAlive(jobId, lastHeartbeat);
      const videos = [...document.querySelectorAll("video")];
      for (const video of videos) {
        const url = video.currentSrc || video.src || video.querySelector("source")?.src;
        if (url && !previousUrls.has(url) && /^(https?:|blob:)/.test(url)) return url;
      }
      await wait(1000);
    }
    throw new Error("O Flow não retornou o vídeo dentro do tempo esperado.");
  }

  // ── Processamento da fila ─────────────────────────────────────────────────
  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      const { activeFlowJobId } = await chrome.storage.local.get("activeFlowJobId");
      if (!activeFlowJobId) return;
      const key = `job:${activeFlowJobId}`;
      const stored = await chrome.storage.local.get(key);
      const job = stored[key];
      if (!job || !["pending", "claimed", "opening_project", "generating"].includes(job.status)) return;

      if (document.body && /client-side exception|Application error|Cannot read properties of undefined/i.test(document.body.innerText || "")) {
        if (!sessionStorage.getItem("__cinegenFlowEscapedError")) {
          sessionStorage.setItem("__cinegenFlowEscapedError", "true");
          location.href = "https://labs.google/fx/pt/tools/flow";
        }
        return;
      } else {
        sessionStorage.removeItem("__cinegenFlowEscapedError");
      }

      const accountStatus = pageStatus();
      if (!accountStatus.signedIn && !accountStatus.accountEvidence) {
        await updateJob(
          { ...job, status: "failed", error: "Entre na sua conta Google Flow nesta aba." },
          true,
        );
        return;
      }

      if (!location.pathname.includes("/project/")) {
        const newProjectBtn = findButton((text, label) => /Novo projeto|New project/i.test(`${text} ${label}`));
        const existingProjectLink = document.querySelector('a[href*="/project/"]');
        const targetElement = existingProjectLink || newProjectBtn;

        if (!targetElement) throw new Error("Não foi possível localizar o botão de Novo Projeto ou link de projeto no Flow.");
        await updateJob({ ...job, status: "opening_project" });

        if (targetElement.tagName === "A" && targetElement.href) {
          location.href = targetElement.href;
        } else {
          targetElement.click();
        }
        return;
      }

      if (job.kind === "image") {
        let activeJob = job;
        let previousImages = new Set(job.previousImageUrls || []);
        if (!job.submittedAt) {
          await attachReferenceImage(job.imageUrl);
          previousImages = currentLargeImageUrls();
          const editor = await enterPrompt(job.prompt);
          await submitPrompt(editor);
          activeJob = {
            ...job,
            status: "generating",
            submittedAt: Date.now(),
            previousImageUrls: [...previousImages],
          };
          await updateJob(activeJob);
        }
        const generatedImageUrl = await waitForImage(
          activeJob.id,
          previousImages,
          Boolean(activeJob.approveCredits),
        );
        const resultImageUrl = await portableImageUrl(generatedImageUrl);
        await updateJob(
          {
            ...activeJob,
            status: "completed",
            resultImageUrl,
            completedAt: Date.now(),
          },
          true,
        );
        return;
      }

      let activeJob = job;
      let previousUrls = new Set(job.previousVideoUrls || []);
      if (!job.submittedAt) {
        previousUrls = new Set(
          [...document.querySelectorAll("video")]
            .map((video) => video.currentSrc || video.src)
            .filter(Boolean)
        );
        await attachReferenceImage(job.imageUrl);
        await chooseVideoSettings(job);
        const editor = await enterPrompt(job.prompt);
        await submitPrompt(editor);
        activeJob = {
          ...job,
          status: "generating",
          submittedAt: Date.now(),
          previousVideoUrls: [...previousUrls],
        };
        await updateJob(activeJob);
      }
      const videoUrl = await waitForVideo(activeJob.id, previousUrls);
      await updateJob(
        { ...activeJob, status: "completed", videoUrl, completedAt: Date.now() },
        true,
      );
    } catch (error) {
      const { activeFlowJobId } = await chrome.storage.local.get("activeFlowJobId");
      if (activeFlowJobId) {
        const key = `job:${activeFlowJobId}`;
        const stored = await chrome.storage.local.get(key);
        const wasCancelled = error?.name === "AbortError" || stored[key]?.status === "cancelled";
        await updateJob(
          {
            ...(stored[key] || { id: activeFlowJobId }),
            status: wasCancelled ? "cancelled" : "failed",
            error: error?.message || String(error),
          },
          true,
        );
      }
    } finally {
      processing = false;
    }
  }

  let scheduledTimer = null;
  function scheduleProcessQueue(delay = 250) {
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      void processQueue();
    }, delay);
  }

  // ── Expõe processQueue para re-injeções ───────────────────────────────────
  window.__cinegenFlowProcessQueue = () => scheduleProcessQueue(0);

  // ── Listeners de mensagem ─────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "CINEGEN_FLOW_PAGE_STATUS") {
      sendResponse(pageStatus());
      return;
    }
    if (message.type === "CINEGEN_FLOW_PROCESS_QUEUE") {
      scheduleProcessQueue(0);
      sendResponse({ accepted: true });
    }
  });

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) lastUrl = location.href;
    scheduleProcessQueue(350);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("load", () => scheduleProcessQueue(200));
  window.addEventListener("popstate", () => scheduleProcessQueue(100));
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleProcessQueue(100);
    } else {
      scheduleProcessQueue(0);
    }
  }, 2_000);
  scheduleProcessQueue(300);
})();
