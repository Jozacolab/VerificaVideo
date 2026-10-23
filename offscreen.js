let recognition = null;
let captureRunning = false;
let transcriptBuffer = "";
let intervalTimer = null;
let restartTimer = null;
let countdownRemaining = 30;
let selectedInterval = 30;
let batchStartedAt = null;
let analysisInProgress = false;
let targetTabId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target !== "offscreen") return false;

  if (request.action === "START_MICROPHONE_CAPTURE") {
    startCapture(request)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message || "Não foi possível iniciar o microfone." }));
    return true;
  }

  if (request.action === "STOP_MICROPHONE_CAPTURE") {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "UPDATE_MICROPHONE_INTERVAL") {
    selectedInterval = request.interval === 60 ? 60 : 30;
    countdownRemaining = selectedInterval;
    publishStatus("Microfone ativo.");
    sendResponse({ success: true });
    return true;
  }

  return false;
});

async function startCapture(request) {
  if (captureRunning) {
    sendResponseStatus("Microfone ativo.");
    return;
  }

  const SpeechRecognition = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error("Este navegador não oferece reconhecimento de fala.");
  }

  selectedInterval = request.interval === 60 ? 60 : 30;
  countdownRemaining = selectedInterval;
  targetTabId = Number.isInteger(request.targetTabId) ? request.targetTabId : null;
  transcriptBuffer = "";
  batchStartedAt = new Date();
  analysisInProgress = false;

  const instance = new SpeechRecognition();
  instance.lang = "pt-BR";
  instance.continuous = true;
  instance.interimResults = false;
  recognition = instance;

  instance.onstart = () => {
    if (recognition !== instance || !captureRunning) return;
    captureRunning = true;
    if (!intervalTimer) {
      intervalTimer = setInterval(() => {
        countdownRemaining--;
        if (countdownRemaining <= 0) {
          countdownRemaining = selectedInterval;
          flushTranscript();
        }
        publishStatus("Microfone ativo.");
      }, 1000);
    }
    publishStatus("Microfone ativo.");
  };

  instance.onresult = (event) => {
    if (recognition !== instance || !captureRunning) return;
    for (let index = event.resultIndex; index < event.results.length; index++) {
      if (!event.results[index].isFinal) continue;
      const phrase = event.results[index][0].transcript.replace(/\s+/g, " ").trim();
      if (!phrase) continue;
      transcriptBuffer = `${transcriptBuffer} ${phrase}`.trim();
      publishStatus("Microfone ativo.");
    }
  };

  instance.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    const message = event.error === "not-allowed" || event.error === "service-not-allowed"
      ? "Acesso ao microfone negado. Permita o uso do microfone para a extensão."
      : event.error === "audio-capture"
        ? "Nenhum microfone disponível. Verifique o dispositivo e as permissões."
        : `Falha no reconhecimento de fala: ${event.error}.`;
    stopCapture(message, message);
  };

  instance.onend = () => {
    if (!captureRunning || recognition !== instance) return;
    restartTimer = setTimeout(() => {
      if (!captureRunning || recognition !== instance) return;
      try {
        instance.start();
      } catch (error) {
        console.warn("[VerificaVídeo] Não foi possível retomar o reconhecimento.", error);
        const message = "O reconhecimento foi interrompido. Inicie a análise novamente.";
        stopCapture(message, message);
      }
    }, 300);
  };

  try {
    captureRunning = true;
    instance.start();
    publishStatus("Solicitando acesso ao microfone...");
  } catch (error) {
    captureRunning = false;
    recognition = null;
    throw error;
  }
}

function stopCapture(status = "Captura pelo microfone parada.", error = null) {
  captureRunning = false;
  clearInterval(intervalTimer);
  clearTimeout(restartTimer);
  intervalTimer = null;
  restartTimer = null;

  const activeRecognition = recognition;
  recognition = null;
  if (activeRecognition) {
    activeRecognition.onend = null;
    try {
      activeRecognition.stop();
    } catch (error) {
      console.warn("[VerificaVídeo] Não foi possível encerrar o reconhecimento.", error);
    }
  }

  flushTranscript();
  publishStatus(status, false, error);
}

async function flushTranscript() {
  const text = transcriptBuffer.trim();
  if (text.length < 10 || analysisInProgress) return;

  transcriptBuffer = "";
  const batchStart = batchStartedAt || new Date();
  batchStartedAt = new Date();
  analysisInProgress = true;
  let shouldFlushAgain = false;

  try {
    const response = await chrome.runtime.sendMessage({
      action: "EXECUTE_FACT_CHECK_DIRECT",
      text,
      source: "microfone",
      timeRange: `Microfone · ${batchStart.toLocaleTimeString("pt-BR")} - ${batchStartedAt.toLocaleTimeString("pt-BR")}`,
      metadata: {
        title: "Áudio capturado pelo microfone",
        channel: "Microfone",
        currentTime: batchStartedAt.toLocaleTimeString("pt-BR"),
        url: "",
        isPaused: false
      }
    });
    if (!response?.success) {
      transcriptBuffer = `${text} ${transcriptBuffer}`.trim();
      publishStatus(response?.error || "Não foi possível analisar o trecho.");
    } else {
      shouldFlushAgain = true;
    }
  } catch (error) {
    transcriptBuffer = `${text} ${transcriptBuffer}`.trim();
    console.warn("[VerificaVídeo] Falha ao analisar fala capturada.", error);
    publishStatus(`Falha ao analisar trecho: ${error.message || "erro desconhecido"}`);
  } finally {
    analysisInProgress = false;
    publishStatus(captureRunning ? "Microfone ativo." : "Captura pelo microfone parada.");
    if (shouldFlushAgain && !captureRunning && transcriptBuffer.trim().length >= 10) {
      flushTranscript();
    }
  }
}

function publishStatus(status, running = captureRunning, error = null) {
  const state = {
    running,
    status,
    summary: transcriptBuffer.slice(-180),
    remaining: running ? countdownRemaining : null,
    interval: selectedInterval,
    targetTabId
  };
  if (error) state.error = error;
  sendResponseStatus(status, state);
}

function sendResponseStatus(status, state = {
  running: captureRunning,
  status,
  summary: transcriptBuffer.slice(-180),
  remaining: captureRunning ? countdownRemaining : null,
  interval: selectedInterval,
  targetTabId
}) {
  chrome.runtime.sendMessage({
    action: "MICROPHONE_CAPTURE_STATUS",
    status,
    state
  }).catch((error) => {
    console.warn("[VerificaVídeo] Não foi possível transmitir o estado do microfone.", error);
  });
}
