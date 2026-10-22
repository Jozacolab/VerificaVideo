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

  const btnInterval30 = document.getElementById("btnInterval30");
  const btnInterval60 = document.getElementById("btnInterval60");
  const toggleHudCheckbox = document.getElementById("toggleHudCheckbox");

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
  let selectedInterval = 30; // 30 ou 60 segundos
  let timelineItems = [];

  // 1. Carrega dados do storage (API Key, histórico e preferências)
  const stored = await chrome.storage.local.get([
    "geminiApiKey",
    "timeline_checks",
    "saved_interval",
    "show_hud_pref"
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

  function setIntervalSelection(seconds) {
    selectedInterval = seconds;
    chrome.storage.local.set({ saved_interval: seconds });

    if (seconds === 60) {
      btnInterval60.classList.add("active");
      btnInterval30.classList.remove("active");
      if (!isMonitoring) btnText.textContent = "Iniciar Monitoramento a cada 1min";
    } else {
      btnInterval30.classList.add("active");
      btnInterval60.classList.remove("active");
      if (!isMonitoring) btnText.textContent = "Iniciar Monitoramento a cada 30s";
    }
  }

  async function notifyIntervalChange(seconds) {
    if (isMonitoring) {
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
    const tab = await getActiveYouTubeTab();
    if (!tab) {
      showAlert("Por favor, abra um vídeo no YouTube primeiro.", "error");
      return;
    }

    if (isMonitoring) {
      // Parar
      isMonitoring = false;
      updateButtonUI(false);
      chrome.tabs.sendMessage(tab.id, { action: "STOP_MONITORING" }).catch(() => {});
    } else {
      // Iniciar uma nova análise: limpa as checagens da sessão anterior e inicia nova rodada
      timelineItems = [];
      await chrome.storage.local.remove(["timeline_checks"]);
      renderAllTimelineItems();

      isMonitoring = true;
      updateButtonUI(true);
      countdownDisplay.textContent = "Monitoramento ativo! Dê play no vídeo...";

      chrome.tabs.sendMessage(tab.id, {
        action: "START_MONITORING",
        interval: selectedInterval,
        showHUD: toggleHudCheckbox.checked
      }).catch((err) => {
        showAlert("Erro ao iniciar na página do YouTube. Recarregue o vídeo.", "error");
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

  // 9. Ouvinte de mensagens em tempo real vindas do content.js e background.js
  chrome.runtime.onMessage.addListener((request) => {
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

  /**
   * Sincroniza o estado inicial do popup com o content.js
   */
  async function syncWithActiveTabStatus() {
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
      btnText.textContent = "⏹️ Parar Monitoramento";
      const playIcon = toggleStreamBtn.querySelector(".play-icon");
      if (playIcon) playIcon.classList.add("hidden");
      liveStatusContainer.classList.remove("hidden");
    } else {
      toggleStreamBtn.className = "btn-cta btn-start";
      btnText.textContent = selectedInterval === 60 ? "Iniciar Monitoramento a cada 1min" : "Iniciar Monitoramento a cada 30s";
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
    sourcesLabel.textContent = "Fontes & Links Diretos para Consulta:";
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
        link.innerHTML = `🔗 ${source.nome || "Verificar Fonte"}`;

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
