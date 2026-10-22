/**
 * content.js - Injetado nas páginas do YouTube
 * 
 * NOVO MOTOR EM TEMPO REAL:
 * 1. Monitoramento Contínuo em Segundo Plano: Continua funcionando mesmo após fechar o popup.
 * 2. Detecção inteligente de Play/Pause: Pausa a contagem quando o vídeo está pausado
 *    e retoma assim que você dá play no vídeo.
 * 3. Painel Flutuante (HUD) no YouTube: Exibe o veredito e fontes diretamente sobre o vídeo.
 * 4. Fatiamento por Janela de Tempo (30s ou 60s) configurável.
 */


// Buffer com marcação temporal do vídeo
const MAX_BUFFER_ITEMS = 300;
let captionsWithTimestamps = [];
let lastExtractedText = "";
let lastCheckedSec = 0;

// Estado do monitoramento contínuo
let isMonitoring = false;
let monitoringIntervalSec = 30; // 30 ou 60 segundos
let countdownRemaining = 30;
let monitoringTimer = null;
let showFloatingHUD = true;

/**
 * Normaliza e limpa espaços
 */
function cleanText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Formata segundos numéricos em MM:SS
 */
function formatSeconds(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function getVideoElement() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

/**
 * Observador de Legendas do YouTube
 */
function startCaptionObserver() {
  const targetNode = document.body;
  if (!targetNode) return;

  const observer = new MutationObserver(() => {
    const captionSegments = document.querySelectorAll(".ytp-caption-segment, .caption-window span");
    const video = getVideoElement();
    const currentVideoTime = video ? video.currentTime : 0;

    captionSegments.forEach((segment) => {
      const text = cleanText(segment.textContent);
      if (text && text.length > 2 && text !== lastExtractedText) {
        lastExtractedText = text;

        captionsWithTimestamps.push({
          text: text,
          videoTime: currentVideoTime,
          formattedTime: formatSeconds(currentVideoTime)
        });

        if (captionsWithTimestamps.length > MAX_BUFFER_ITEMS) {
          captionsWithTimestamps.shift();
        }
      }
    });
  });

  observer.observe(targetNode, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

/**
 * Coleta falas no intervalo de tempo especificado (ex: últimos 30s ou 60s)
 */
function extractIntervalSpeech(secondsWindow = 30) {
  const video = getVideoElement();
  const currentSec = video ? video.currentTime : 0;
  const startSec = Math.max(0, currentSec - (secondsWindow + 2));

  // Itens dentro da janela de tempo
  const recent = captionsWithTimestamps.filter(
    (item) => item.videoTime >= startSec && item.videoTime <= currentSec + 1
  );

  const uniqueLines = [];
  recent.forEach((it) => {
    if (!uniqueLines.includes(it.text)) {
      uniqueLines.push(it.text);
    }
  });

  let text = uniqueLines.join(" ");

  // Se o buffer recente estiver vazio, tenta as legendas atualmente na tela
  if (text.length < 10) {
    const visible = document.querySelectorAll(".ytp-caption-segment, .caption-window span");
    const visArr = [];
    visible.forEach((s) => {
      const t = cleanText(s.textContent);
      if (t) visArr.push(t);
    });
    text = visArr.join(" ");
  }

  return {
    text: text,
    timeRange: `${formatSeconds(startSec)} - ${formatSeconds(currentSec)}`,
    hasSpeech: text.length >= 10
  };
}

/**
 * Metadados gerais do vídeo
 */
function getVideoMetadata() {
  const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string");
  const channelEl = document.querySelector("ytd-channel-name yt-formatted-string a, #channel-name a");
  const currentTimeEl = document.querySelector(".ytp-time-current");
  const video = getVideoElement();
  const currentSec = video ? video.currentTime : 0;

  return {
    title: titleEl ? cleanText(titleEl.textContent) : document.title || "Vídeo do YouTube",
    channel: channelEl ? cleanText(channelEl.textContent) : "Canal do YouTube",
    currentTime: currentTimeEl ? cleanText(currentTimeEl.textContent) : formatSeconds(currentSec),
    url: window.location.href,
    isPaused: video ? video.paused : true
  };
}

/* ==========================================================
   PAINEL FLUTUANTE (HUD) DIRETAMENTE NO VÍDEO DO YOUTUBE
   ========================================================== */

function getOrCreateFloatingHUD() {
  let hud = document.getElementById("verifica-video-hud");
  if (hud) return hud;

  hud = document.createElement("div");
  hud.id = "verifica-video-hud";
  hud.innerHTML = `
    <div class="vv-hud-header">
      <div class="vv-hud-title">
        <span class="vv-dot"></span>
        <span class="vv-hud-name">VerificaVídeo AO VIVO</span>
      </div>
      <div class="vv-hud-controls">
        <button id="vv-hud-toggle-btn" title="Minimizar">_</button>
        <button id="vv-hud-close-btn" title="Fechar painel">✕</button>
      </div>
    </div>
    <div id="vv-hud-body" class="vv-hud-body">
      <div class="vv-hud-ticker" id="vv-hud-ticker">Aguardando play no vídeo...</div>
      <div id="vv-hud-result-box" class="vv-hud-result hidden">
        <div class="vv-hud-topline">
          <span id="vv-hud-time" class="vv-hud-time">⏱️ 00:00</span>
          <span id="vv-hud-badge" class="vv-hud-badge">[FATO]</span>
        </div>
        <p id="vv-hud-claim" class="vv-hud-claim">"Alegação analisada..."</p>
        <div id="vv-hud-sources" class="vv-hud-sources"></div>
      </div>
    </div>
  `;

  injectHUDStyles();
  document.body.appendChild(hud);

  // Eventos de minimizar e fechar
  hud.querySelector("#vv-hud-close-btn").addEventListener("click", () => {
    hud.remove();
  });

  hud.querySelector("#vv-hud-toggle-btn").addEventListener("click", () => {
    const body = hud.querySelector("#vv-hud-body");
    body.classList.toggle("hidden");
  });

  return hud;
}

function injectHUDStyles() {
  if (document.getElementById("vv-hud-styles")) return;

  const style = document.createElement("style");
  style.id = "vv-hud-styles";
  style.textContent = `
    #verifica-video-hud {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 320px;
      background: rgba(11, 15, 25, 0.94);
      backdrop-filter: blur(10px);
      border: 1px solid #1e2b45;
      border-radius: 10px;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      z-index: 9999999;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.65);
      transition: all 0.2s ease;
      overflow: hidden;
    }
    .vv-hud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: #131b2e;
      border-bottom: 1px solid #1e2b45;
      user-select: none;
    }
    .vv-hud-title {
      display: flex;
      align-items: center;
      gap: 7px;
      font-weight: 700;
      font-size: 11px;
      color: #93c5fd;
      letter-spacing: 0.3px;
    }
    .vv-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 6px #ef4444;
      animation: vvPulse 1.4s infinite;
    }
    @keyframes vvPulse {
      0% { transform: scale(0.9); opacity: 0.8; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.8; }
    }
    .vv-hud-controls button {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 13px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .vv-hud-controls button:hover {
      background: #1e293b;
      color: #fff;
    }
    .vv-hud-body {
      padding: 10px 12px;
    }
    .vv-hud-ticker {
      font-size: 11px;
      color: #60a5fa;
      font-weight: 500;
      margin-bottom: 6px;
    }
    .vv-hud-result {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #0b0f19;
      border: 1px solid #1a253b;
      border-radius: 6px;
      padding: 8px;
    }
    .vv-hud-topline {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .vv-hud-time {
      font-size: 10px;
      color: #94a3b8;
    }
    .vv-hud-badge {
      font-size: 11px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .vv-badge-fato { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
    .vv-badge-fake { background: rgba(244,63,94,0.15); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); }
    .vv-badge-duvidoso { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
    .vv-hud-claim {
      font-size: 11px;
      color: #f1f5f9;
      font-style: italic;
      line-height: 1.35;
      border-left: 2px solid #3b82f6;
      padding-left: 6px;
      margin: 0;
    }
    .vv-hud-sources {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 2px;
    }
    .vv-source-link {
      font-size: 10px;
      background: #18233c;
      color: #93c5fd;
      border: 1px solid #283957;
      padding: 2px 6px;
      border-radius: 4px;
      text-decoration: none;
    }
    .vv-source-link:hover {
      background: #2563eb;
      color: #fff;
    }
    .vv-hud-hidden { display: none !important; }
  `;
  document.head.appendChild(style);
}

function updateHUDStatus(msg) {
  if (!showFloatingHUD) return;
  const hud = getOrCreateFloatingHUD();
  const ticker = hud.querySelector("#vv-hud-ticker");
  if (ticker) ticker.textContent = msg;
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

function updateHUDResult(data) {
  if (!showFloatingHUD) return;
  const hud = getOrCreateFloatingHUD();
  const resBox = hud.querySelector("#vv-hud-result-box");
  const timeEl = hud.querySelector("#vv-hud-time");
  const badgeEl = hud.querySelector("#vv-hud-badge");
  const claimEl = hud.querySelector("#vv-hud-claim");
  const sourcesEl = hud.querySelector("#vv-hud-sources");

  resBox.classList.remove("hidden");
  timeEl.textContent = `⏱️ ${data.timeRange || "Recente"}`;

  const veredito = normalizeVerdict(data.veredito);
  badgeEl.className = "vv-hud-badge";
  if (veredito === "FATO") {
    badgeEl.classList.add("vv-badge-fato");
    badgeEl.textContent = "[FATO]";
  } else if (veredito === "FAKE") {
    badgeEl.classList.add("vv-badge-fake");
    badgeEl.textContent = "[FAKE]";
  } else {
    badgeEl.classList.add("vv-badge-duvidoso");
    badgeEl.textContent = "[DUVIDOSO]";
  }

  claimEl.textContent = `"${data.afirmacao_destaque || "Fala sob verificação"}"`;

  sourcesEl.innerHTML = "";
  if (Array.isArray(data.fontes_recomendadas)) {
    data.fontes_recomendadas.slice(0, 2).forEach((src) => {
      const a = document.createElement("a");
      a.className = "vv-source-link";
      a.href = src.url;
      a.target = "_blank";
      a.textContent = `🔗 ${src.nome}`;
      sourcesEl.appendChild(a);
    });
  }
}

/* ==========================================================
   LOOP DO MOTOR DE MONITORAMENTO CONTÍNUO
   ========================================================== */

function startContinuousMonitoring(intervalSeconds = 30) {
  isMonitoring = true;
  monitoringIntervalSec = intervalSeconds;
  countdownRemaining = intervalSeconds;

  if (showFloatingHUD) {
    getOrCreateFloatingHUD();
    updateHUDStatus("Monitoramento ativado! Dê play no vídeo.");
  }

  clearInterval(monitoringTimer);

  monitoringTimer = setInterval(async () => {
    if (!isMonitoring) {
      clearInterval(monitoringTimer);
      return;
    }

    const video = getVideoElement();

    // Se o vídeo estiver pausado, aguarda o usuário dar play
    if (!video || video.paused) {
      updateHUDStatus("⏸️ Vídeo pausado. Dê play para continuar checando...");
      chrome.runtime.sendMessage({
        action: "MONITORING_TICK",
        status: "paused",
        message: "Vídeo pausado. Dê play no vídeo para checar..."
      }).catch(() => {});
      return;
    }

    countdownRemaining--;

    // Notifica o popup e atualiza HUD
    updateHUDStatus(`Próxima checagem em ${countdownRemaining}s (${monitoringIntervalSec}s)...`);
    chrome.runtime.sendMessage({
      action: "MONITORING_TICK",
      status: "running",
      remaining: countdownRemaining,
      interval: monitoringIntervalSec
    }).catch(() => {});

    // Quando o tempo atinge 0, executa a checagem da fatia de tempo
    if (countdownRemaining <= 0) {
      countdownRemaining = monitoringIntervalSec;
      await processIntervalCheck();
    }
  }, 1000);
}

async function processIntervalCheck() {
  updateHUDStatus("🔍 Analisando falas recentes com IA...");
  const metadata = getVideoMetadata();
  const speech = extractIntervalSpeech(monitoringIntervalSec);

  // Se não houve fala detectada no trecho (ex: vinheta, silêncio), não gasta chamada de IA
  if (!speech.hasSpeech) {
    updateHUDStatus(`Trecho sem falas detectadas. Continuando (${monitoringIntervalSec}s)...`);
    return;
  }

  try {
    const storage = await chrome.storage.local.get(["geminiApiKey"]);
    const apiKey = storage.geminiApiKey || "";

    const response = await chrome.runtime.sendMessage({
      action: "EXECUTE_FACT_CHECK_DIRECT",
      text: speech.text,
      metadata: metadata,
      timeRange: speech.timeRange,
      apiKey: apiKey
    });

    if (response && response.success && response.data) {
      updateHUDResult(response.data);
      updateHUDStatus(`Checagem concluída! Próxima em ${monitoringIntervalSec}s...`);
    } else {
      updateHUDStatus("Aviso: Falha ao obter checagem da IA.");
    }
  } catch (err) {
    console.warn("[VerificaVídeo]", err);
    updateHUDStatus("Erro de conexão ao checar trecho.");
  }
}

function stopContinuousMonitoring() {
  isMonitoring = false;
  clearInterval(monitoringTimer);
  updateHUDStatus("Monitoramento parado.");
}

/* ==========================================================
   LISTENER DE MENSAGENS DO POPUP / BACKGROUND
   ========================================================== */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_MONITORING") {
    // Limpa estado anterior para iniciar a nova sessão
    captionsWithTimestamps = [];
    const hud = document.getElementById("verifica-video-hud");
    if (hud) {
      const resBox = hud.querySelector("#vv-hud-result-box");
      if (resBox) resBox.classList.add("hidden");
    }

    showFloatingHUD = request.showHUD !== false;
    startContinuousMonitoring(request.interval || 30);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "STOP_MONITORING") {
    stopContinuousMonitoring();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "GET_MONITORING_STATUS") {
    const video = getVideoElement();
    sendResponse({
      isMonitoring: isMonitoring,
      interval: monitoringIntervalSec,
      remaining: countdownRemaining,
      isPaused: video ? video.paused : true
    });
    return true;
  }

  if (request.action === "TOGGLE_HUD") {
    showFloatingHUD = request.show;
    const hud = document.getElementById("verifica-video-hud");
    if (hud) {
      if (showFloatingHUD) hud.classList.remove("vv-hud-hidden");
      else hud.classList.add("vv-hud-hidden");
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "PING") {
    sendResponse({ status: "ready" });
    return true;
  }
});

// Inicialização
startCaptionObserver();
console.log("[VerificaVídeo] Motor contínuo e HUD do YouTube inicializados.");
