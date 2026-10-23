/**
 * popup.js - Controlador da Interface VerificaVídeo
 * 
 * Sincroniza em tempo real com o motor contínuo do content.js na aba do YouTube.
 * Permite dar "play" na checagem antes de dar play no vídeo, com suporte a 30s ou 1min.
 */


document.addEventListener("DOMContentLoaded", async () => {
  // Elementos do DOM
  const toggleStreamBtn = document.getElementById("toggleStreamBtn");
  const btnText = document.getElementById("btnText");
  const btnSpinner = document.getElementById("btnSpinner");
  const liveStatusContainer = document.getElementById("liveStatusContainer");
  const countdownDisplay = document.getElementById("countdownDisplay");
  const microphoneCapturePreview = document.getElementById("microphoneCapturePreview");
  const microphoneCaptureStatus = document.getElementById("microphoneCaptureStatus");
  const microphoneTranscriptPreview = document.getElementById("microphoneTranscriptPreview");

  const btnInterval30 = document.getElementById("btnInterval30");
  const btnInterval60 = document.getElementById("btnInterval60");
  const toggleHudCheckbox = document.getElementById("toggleHudCheckbox");
  const captureModeTranscript = document.getElementById("captureModeTranscript");
  const captureModeMicrophone = document.getElementById("captureModeMicrophone");
  const captureModeDescription = document.getElementById("captureModeDescription");
  const hudToggleRow = document.querySelector(".hud-toggle-row");

  const toggleApiKeySection = document.getElementById("toggleApiKeySection");
  const apiKeyBody = document.getElementById("apiKeyBody");
  const chevronIcon = document.getElementById("chevronIcon");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const saveApiKeyBtn = document.getElementById("saveApiKeyBtn");
  const togglePasswordVisibility = document.getElementById("togglePasswordVisibility");
  const modeBadge = document.getElementById("modeBadge");

  const statusAlert = document.getElementById("statusAlert");
  const statusMessage = document.getElementById("statusMessage");

  const timelineFeed = document.getElementById("timelineFeed");
  const emptyFeedState = document.getElementById("emptyFeedState");
  const checkCounter = document.getElementById("checkCounter");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");

  // Estado local
  let isMonitoring = false;
  let captureMode = "transcript";
  let selectedInterval = 30; // 30 ou 60 segundos
  let timelineItems = [];

  // 1. Carrega dados do storage (API Key, histórico e preferências)
  const stored = await chrome.storage.local.get([
    "geminiApiKey",
    "timeline_checks",
    "saved_interval",
    "show_hud_pref",
    "saved_capture_mode"
  ]);

  if (stored.geminiApiKey) {
    apiKeyInput.value = stored.geminiApiKey;
    updateBadge(true);
  } else {
    updateBadge(false);
    apiKeyBody.classList.add("expanded");
    chevronIcon.classList.add("rotated");
  }

  if (stored.saved_interval === 60) {
    setIntervalSelection(60);
  } else {
    setIntervalSelection(30);
  }

  if (stored.show_hud_pref === false) {
    toggleHudCheckbox.checked = false;
  }

  setCaptureMode(stored.saved_capture_mode === "microphone" ? "microphone" : "transcript");

  if (Array.isArray(stored.timeline_checks) && stored.timeline_checks.length > 0) {
    timelineItems = stored.timeline_checks;
    renderAllTimelineItems();
  }

  // 2. Consulta o status de monitoramento atual da aba do YouTube
  await syncWithActiveTabStatus();

  // 3. Seletor de Intervalo (30s vs 60s)
  btnInterval30.addEventListener("click", () => {
    setIntervalSelection(30);
    notifyIntervalChange(30);
  });

  btnInterval60.addEventListener("click", () => {
    setIntervalSelection(60);
    notifyIntervalChange(60);
  });

  captureModeTranscript.addEventListener("change", () => {
    if (captureModeTranscript.checked) setCaptureMode("transcript");
  });

  captureModeMicrophone.addEventListener("change", () => {
    if (captureModeMicrophone.checked) setCaptureMode("microphone");
  });

  function setCaptureMode(mode) {
    captureMode = mode;
    captureModeTranscript.checked = mode === "transcript";
    captureModeMicrophone.checked = mode === "microphone";
    captureModeTranscript.disabled = isMonitoring;
    captureModeMicrophone.disabled = isMonitoring;
    hudToggleRow.classList.remove("hidden");
    captureModeDescription.textContent = mode === "microphone"
      ? "Clique em iniciar análise para transcrever pelo microfone. A captura continua mesmo com esta janela fechada."
      : "Usa as legendas (CC) do YouTube; ao sair da página, muda para o microfone até você parar.";
    microphoneCapturePreview.classList.toggle("hidden", mode !== "microphone");
    chrome.storage.local.set({ saved_capture_mode: mode });
    updateButtonUI(isMonitoring);
  }

  function setIntervalSelection(seconds) {
    selectedInterval = seconds;
    chrome.storage.local.set({ saved_interval: seconds });

    if (seconds === 60) {
      btnInterval60.classList.add("active");
      btnInterval30.classList.remove("active");
    } else {
      btnInterval30.classList.add("active");
      btnInterval60.classList.remove("active");
    }
    updateButtonUI(isMonitoring);
  }

  async function notifyIntervalChange(seconds) {
    if (isMonitoring && captureMode === "microphone") {
      chrome.runtime.sendMessage({ action: "UPDATE_MICROPHONE_INTERVAL", interval: seconds })
        .catch((error) => console.warn("[VerificaVídeo] Não foi possível atualizar o intervalo.", error));
    } else if (isMonitoring && captureMode === "transcript") {
      const tab = await getActiveYouTubeTab();
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          action: "START_MONITORING",
          interval: seconds,
          showHUD: toggleHudCheckbox.checked
        }).catch(() => {});
      }
    }
  }

  // 4. Alternador de HUD Flutuante
  toggleHudCheckbox.addEventListener("change", async () => {
    const show = toggleHudCheckbox.checked;
    await chrome.storage.local.set({ show_hud_pref: show });
    const tab = await getActiveYouTubeTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_HUD", show }).catch(() => {});
    }
  });

  // 5. Expandir/recolher chave de API
  toggleApiKeySection.addEventListener("click", () => {
    const isExpanded = apiKeyBody.classList.toggle("expanded");
    chevronIcon.classList.toggle("rotated", isExpanded);
  });

  togglePasswordVisibility.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  // 6. Salvar Chave
  saveApiKeyBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    await chrome.storage.local.set({ geminiApiKey: key });
    await chrome.storage.local.remove(["gemini_models_cache", "gemini_models_timestamp"]);

    const orig = saveApiKeyBtn.textContent;
    saveApiKeyBtn.textContent = "Salvo!";
    saveApiKeyBtn.style.background = "#10b981";
    setTimeout(() => {
      saveApiKeyBtn.textContent = orig;
      saveApiKeyBtn.style.background = "";
    }, 1500);

    updateBadge(Boolean(key));
    showAlert("Chave da API Gemini salva com sucesso.", "success");
  });

  // 7. Botão Principal (Iniciar / Parar Monitoramento)
  toggleStreamBtn.addEventListener("click", async () => {
    if (isMonitoring) {
      if (captureMode === "microphone") {
        await stopMicrophoneAnalysis();
        return;
      }
      const tab = await getActiveYouTubeTab();
      isMonitoring = false;
      updateButtonUI(false);
      await chrome.storage.local.set({
        transcription_monitoring_session: { active: false }
      });
      if (tab) chrome.tabs.sendMessage(tab.id, { action: "STOP_MONITORING" }).catch(() => {});
    } else if (captureMode === "microphone") {
      await startMicrophoneAnalysis();
    } else {
      const tab = await getActiveYouTubeTab();
      if (!tab) {
        showAlert("Abra um vídeo no YouTube e ative as legendas (CC) para usar a transcrição.", "error");
        return;
      }

      // Iniciar uma nova análise: limpa as checagens da sessão anterior e inicia nova rodada
      timelineItems = [];
      await chrome.storage.local.remove(["timeline_checks"]);
      renderAllTimelineItems();

      await chrome.storage.local.set({
        transcription_monitoring_session: {
          active: true,
          interval: selectedInterval,
          showHUD: toggleHudCheckbox.checked,
          targetTabId: tab.id,
          fallbackToMicrophone: true
        }
      });
      isMonitoring = true;
      updateButtonUI(true);
      countdownDisplay.textContent = "Monitoramento ativo! Dê play no vídeo...";

      chrome.tabs.sendMessage(tab.id, {
        action: "START_MONITORING",
        interval: selectedInterval,
        showHUD: toggleHudCheckbox.checked,
        fallbackToMicrophone: true
      }).catch(async (err) => {
        showAlert("Erro ao iniciar na página do YouTube. Recarregue o vídeo.", "error");
        await chrome.storage.local.set({ transcription_monitoring_session: { active: false } });
        console.warn("[VerificaVídeo] Não foi possível iniciar a transcrição.", err);
        isMonitoring = false;
        updateButtonUI(false);
      });
    }
  });

  // 8. Limpar Histórico
  clearHistoryBtn.addEventListener("click", async () => {
    timelineItems = [];
    await chrome.storage.local.remove(["timeline_checks"]);
    renderAllTimelineItems();
    showAlert("Histórico limpo.", "info");
  });

  // 10. Ouvinte de mensagens em tempo real vindas do content.js e background.js
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "MICROPHONE_CAPTURE_STATUS") {
      const state = request.state || {};
      isMonitoring = Boolean(state.running);
      if (state.running) {
        captureMode = "microphone";
        captureModeMicrophone.checked = true;
        captureModeTranscript.checked = false;
        microphoneCapturePreview.classList.remove("hidden");
        microphoneCaptureStatus.textContent = request.status || state.status || "Microfone ativo.";
        microphoneTranscriptPreview.textContent = state.summary || "Aguardando fala...";
        countdownDisplay.textContent = Number.isFinite(state.remaining)
          ? `Próxima análise em ${state.remaining}s (${state.interval}s)...`
          : "Captura do microfone ativa.";
      } else if (state.error) {
        captureMode = "microphone";
        captureModeMicrophone.checked = true;
        captureModeTranscript.checked = false;
        microphoneCapturePreview.classList.remove("hidden");
        microphoneCaptureStatus.textContent = state.error;
        showAlert(state.error, "error");
      } else if (captureMode === "microphone") {
        microphoneCaptureStatus.textContent = request.status || state.status || "Microfone desligado.";
        countdownDisplay.textContent = "Captura parada.";
      }
      updateButtonUI(isMonitoring);
    }

    if (request.action === "MONITORING_TICK") {
      isMonitoring = true;
      updateButtonUI(true);

      if (request.status === "paused") {
        countdownDisplay.textContent = "⏸️ Vídeo pausado. Dê play para checar...";
      } else {
        countdownDisplay.textContent = `Próxima checagem em ${request.remaining}s (${request.interval}s)...`;
      }
    }

    if (request.action === "NEW_CHECK_RESULT") {
      addCheckItemToFeed(request.data);
    }
  });

  async function startMicrophoneAnalysis() {
    microphoneCaptureStatus.textContent = "Iniciando captura persistente do microfone...";
    hideAlert();
    try {
      const tab = await getActiveYouTubeTab();
      const response = await chrome.runtime.sendMessage({
        action: "START_MICROPHONE_CAPTURE",
        interval: selectedInterval,
        targetTabId: tab?.id || null
      });
      if (!response?.success) throw new Error(response?.error || "Não foi possível iniciar o microfone.");

      timelineItems = [];
      await chrome.storage.local.remove(["timeline_checks"]);
      renderAllTimelineItems();
      isMonitoring = true;
      captureMode = "microphone";
      updateButtonUI(true);
      microphoneCaptureStatus.textContent = "Microfone ativo. Você pode fechar esta janela.";
      countdownDisplay.textContent = `Próxima análise em ${selectedInterval}s...`;
    } catch (error) {
      isMonitoring = false;
      updateButtonUI(false);
      microphoneCaptureStatus.textContent = error.message || "Não foi possível iniciar o microfone.";
      showAlert(microphoneCaptureStatus.textContent, "error");
    }
  }

  async function stopMicrophoneAnalysis() {
    try {
      const response = await chrome.runtime.sendMessage({ action: "STOP_MICROPHONE_CAPTURE" });
      if (!response?.success) {
        showAlert(response?.error || "Não foi possível parar a captura do microfone.", "error");
        return;
      }
      isMonitoring = false;
      updateButtonUI(false);
      microphoneCaptureStatus.textContent = "Microfone desligado.";
      countdownDisplay.textContent = "Captura parada.";
    } catch (error) {
      showAlert(`Não foi possível parar o microfone: ${error.message || "erro desconhecido"}`, "error");
    }
  }

  /**
   * Sincroniza o estado inicial do popup com o content.js
   */
  async function syncWithActiveTabStatus() {
    const microphoneState = await chrome.runtime.sendMessage({ action: "GET_MICROPHONE_CAPTURE_STATUS" })
      .catch(() => ({ running: false }));
    if (microphoneState?.running) {
      captureMode = "microphone";
      captureModeMicrophone.checked = true;
      captureModeTranscript.checked = false;
      microphoneCapturePreview.classList.remove("hidden");
      isMonitoring = true;
      microphoneCaptureStatus.textContent = microphoneState.status || "Microfone ativo.";
      microphoneTranscriptPreview.textContent = microphoneState.summary || "Aguardando fala...";
      countdownDisplay.textContent = Number.isFinite(microphoneState.remaining)
        ? `Próxima análise em ${microphoneState.remaining}s (${microphoneState.interval}s)...`
        : "Captura do microfone ativa.";
      updateButtonUI(true);
      return;
    }
    if (captureMode === "microphone" && microphoneState?.status) {
      microphoneCaptureStatus.textContent = microphoneState.status;
      if (microphoneState.error) showAlert(microphoneState.error, "error");
    }

    const storedSession = await chrome.storage.local.get(["transcription_monitoring_session"]);
    if (storedSession.transcription_monitoring_session?.active) {
      captureMode = "transcript";
      captureModeTranscript.checked = true;
      captureModeMicrophone.checked = false;
      isMonitoring = true;
      selectedInterval = storedSession.transcription_monitoring_session.interval || selectedInterval;
      updateButtonUI(true);
      countdownDisplay.textContent = "Transcrição ativa. A análise retoma quando houver vídeo do YouTube.";
    }

    const tab = await getActiveYouTubeTab();
    if (!tab) return;

    try {
      const status = await chrome.tabs.sendMessage(tab.id, { action: "GET_MONITORING_STATUS" });
      if (status && status.isMonitoring) {
        isMonitoring = true;
        updateButtonUI(true);
        if (status.isPaused) {
          countdownDisplay.textContent = "⏸️ Vídeo pausado. Dê play para checar...";
        } else {
          countdownDisplay.textContent = `Próxima checagem em ${status.remaining}s (${status.interval}s)...`;
        }
      }
    } catch (e) {
      // Content script ainda não carregado ou aba sem foco
    }
  }

  function updateButtonUI(running) {
    if (running) {
      toggleStreamBtn.className = "btn-cta btn-stop";
      btnText.textContent = captureMode === "microphone"
        ? "⏹️ Parar análise pelo microfone"
        : "⏹️ Parar Monitoramento";
      captureModeTranscript.disabled = true;
      captureModeMicrophone.disabled = true;
      const playIcon = toggleStreamBtn.querySelector(".play-icon");
      if (playIcon) playIcon.classList.add("hidden");
      liveStatusContainer.classList.remove("hidden");
    } else {
      toggleStreamBtn.className = "btn-cta btn-start";
      captureModeTranscript.disabled = false;
      captureModeMicrophone.disabled = false;
      if (captureMode === "microphone") {
        btnText.textContent = "Iniciar análise pelo microfone";
      } else {
        btnText.textContent = selectedInterval === 60 ? "Iniciar transcrição a cada 1min" : "Iniciar transcrição a cada 30s";
      }
      const playIcon = toggleStreamBtn.querySelector(".play-icon");
      if (playIcon) playIcon.classList.remove("hidden");
      liveStatusContainer.classList.add("hidden");
    }
  }

  async function getActiveYouTubeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return null;
    const tab = tabs[0];
    if (!tab.url || !tab.url.includes("youtube.com")) return null;
    return tab;
  }

  /**
   * Adiciona card ao feed
   */
  function addCheckItemToFeed(data) {
    // Evita duplicatas se o ID já estiver presente
    if (timelineItems.some((it) => it.id === data.id)) return;

    timelineItems.unshift(data);
    if (timelineItems.length > 30) timelineItems.pop();
    renderAllTimelineItems();
  }

  function renderAllTimelineItems() {
    timelineFeed.innerHTML = "";
    checkCounter.textContent = timelineItems.length.toString();

    if (timelineItems.length === 0) {
      timelineFeed.appendChild(emptyFeedState);
      emptyFeedState.classList.remove("hidden");
      return;
    }

    emptyFeedState.classList.add("hidden");
    timelineItems.forEach((item) => {
      const card = createCardElement(item);
      timelineFeed.appendChild(card);
    });
  }

  function normalizeVerdict(rawVerdict) {
    if (!rawVerdict) return "DUVIDOSO";
    const v = String(rawVerdict).toUpperCase().trim();
    if (v.includes("FAKE") || v.includes("FALS") || v.includes("MENTIR") || v.includes("ENGAN") || v.includes("DESINFORM")) {
      return "FAKE";
    }
    if (v.includes("FATO") || v.includes("VERDAD") || v.includes("CORRET") || v.includes("CONFIRM")) {
      return "FATO";
    }
    return "DUVIDOSO";
  }

  function createCardElement(item) {
    const card = document.createElement("div");
    card.className = "fact-card";

    const veredito = normalizeVerdict(item.veredito);
    let badgeClass = "badge-duvidoso";
    let badgeText = "[DUVIDOSO]";

    if (veredito === "FATO") {
      badgeClass = "badge-fato";
      badgeText = "[FATO]";
    } else if (veredito === "FAKE") {
      badgeClass = "badge-fake";
      badgeText = "[FAKE]";
    }

    const topBar = document.createElement("div");
    topBar.className = "card-topbar";

    const timeTag = document.createElement("div");
    timeTag.className = "card-time-tag";
    timeTag.innerHTML = `⏱️ ${item.timeRange || "Trecho"}`;

    const verdictBadge = document.createElement("div");
    verdictBadge.className = `card-verdict-badge ${badgeClass}`;
    verdictBadge.textContent = badgeText;

    topBar.appendChild(timeTag);
    topBar.appendChild(verdictBadge);
    card.appendChild(topBar);

    const confidence = document.createElement("p");
    confidence.className = "confidence-text";
    confidence.textContent = Number.isFinite(item.confianca)
      ? `Confiança estimada da análise: ${item.confianca}%`
      : "Confiança não estimada (modo de demonstração/contingência).";
    card.appendChild(confidence);

    const claim = document.createElement("blockquote");
    claim.className = "claim-quote";
    claim.textContent = `"${item.afirmacao_destaque || "Fala sob análise"}"`;
    card.appendChild(claim);

    const rationale = document.createElement("p");
    rationale.className = "rationale-text";
    rationale.textContent = item.justificativa;
    card.appendChild(rationale);

    // Links diretos para fontes
    const sourcesSec = document.createElement("div");
    sourcesSec.className = "sources-section";
    const sourcesLabel = document.createElement("div");
    sourcesLabel.className = "sources-label";
    sourcesLabel.textContent = "Pesquisar a fala em fontes confiáveis:";
    sourcesSec.appendChild(sourcesLabel);

    const sourcesList = document.createElement("div");
    sourcesList.className = "sources-container";

    if (Array.isArray(item.fontes_recomendadas) && item.fontes_recomendadas.length > 0) {
      item.fontes_recomendadas.forEach((source) => {
        const link = document.createElement("a");
        link.className = "source-link";
        link.href = source.url || "#";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `🔗 ${source.nome || "Verificar Fonte"}`;

        link.addEventListener("click", (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: source.url });
        });

        sourcesList.appendChild(link);
      });
    }

    sourcesSec.appendChild(sourcesList);
    card.appendChild(sourcesSec);

    // Detalhes da transcrição bruta
    const details = document.createElement("details");
    details.className = "card-details";
    const summary = document.createElement("summary");
    summary.textContent = "Ver fala completa do trecho";
    const preview = document.createElement("p");
    preview.className = "transcript-preview";
    preview.textContent = item.texto_analisado || "Transcrição capturada.";

    details.appendChild(summary);
    details.appendChild(preview);
    card.appendChild(details);

    return card;
  }

  function updateBadge(hasKey) {
    if (hasKey) {
      modeBadge.textContent = "IA Gemini Ativa";
      modeBadge.className = "badge badge-ai";
    } else {
      modeBadge.textContent = "Modo Demo";
      modeBadge.className = "badge badge-demo";
    }
  }

  function showAlert(msg, type = "info") {
    statusAlert.className = `alert-box alert-${type}`;
    statusMessage.textContent = msg;
    statusAlert.classList.remove("hidden");
  }

  function hideAlert() {
    statusAlert.classList.add("hidden");
  }
});
