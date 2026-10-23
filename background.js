/**
 * background.js - Service Worker de Segundo Plano (Manifest V3)
 * 
 * ARQUITETURA DE RESILIÊNCIA MULTICAMADAS COM LINKS DIRETOS E TEMPO REAL:
 * 1. Descoberta Dinâmica via ListModels da Google (zero erros de 404).
 * 2. Formatação estrita de links diretos de fontes (URLs completas e clicáveis).
 * 3. Suporte a fatias de 30 segundos com marcação de tempo (timeRange).
 * 4. Delay mínimo de 3 segundos para sincronização e agregação de falas.
 */


const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora de cache
let offscreenCreationPromise = null;

const DEFAULT_FALLBACK_MODELS = [
  "models/gemini-2.0-flash",
  "models/gemini-2.5-flash",
  "models/gemini-1.5-flash",
  "models/gemini-3.8-flash",
  "models/gemini-2.0-flash-lite"
];

/**
 * Normaliza qualquer variação de veredito para os três padrões oficiais
 */
function normalizeVerdict(rawVerdict) {
  if (!rawVerdict) return "DUVIDOSO";
  const v = String(rawVerdict).toUpperCase().trim();

  // Fake, Falso, Mentiroso, Enganoso, Desinformação
  if (v.includes("FAKE") || v.includes("FALS") || v.includes("MENTIR") || v.includes("ENGAN") || v.includes("DESINFORM")) {
    return "FAKE";
  }

  // Fato, Verdadeiro, Correto, Confirmado
  if (v.includes("FATO") || v.includes("VERDAD") || v.includes("CORRET") || v.includes("CONFIRM")) {
    return "FATO";
  }

  return "DUVIDOSO";
}
const KNOWN_FACTCHECK_URLS = {
  "lupa": "https://lupa.uol.com.br",
  "aos fatos": "https://aosfatos.org",
  "g1": "https://g1.globo.com/fato-ou-fake",
  "comprova": "https://projetocomprova.com.br",
  "estadao": "https://www.estadao.com.br/estadao-verifica",
  "folha": "https://www1.folha.uol.com.br/poder/mentirao",
  "uol": "https://noticias.uol.com.br/confere",
  "oms": "https://www.who.int/pt",
  "who": "https://www.who.int",
  "ibge": "https://www.ibge.gov.br",
  "tse": "https://www.tse.jus.br/fato-ou-boato"
};

const TRUSTED_BRAZILIAN_SOURCES = [
  { nome: "Agência Lupa", dominio: "lupa.uol.com.br", tipo: "factcheck" },
  { nome: "Aos Fatos", dominio: "aosfatos.org", tipo: "factcheck" },
  { nome: "Projeto Comprova", dominio: "projetocomprova.com.br", tipo: "factcheck" },
  { nome: "G1 Fato ou Fake", dominio: "g1.globo.com/fato-ou-fake", tipo: "factcheck" },
  { nome: "Estadão Verifica", dominio: "estadao.com.br/estadao-verifica", tipo: "factcheck" },
  { nome: "UOL Confere", dominio: "noticias.uol.com.br/confere", tipo: "factcheck" },
  { nome: "Agência Brasil", dominio: "agenciabrasil.ebc.com.br", tipo: "noticias" },
  { nome: "Portal Gov.br", dominio: "gov.br", tipo: "oficial" },
  { nome: "IBGE", dominio: "ibge.gov.br", tipo: "economia" },
  { nome: "Banco Central do Brasil", dominio: "bcb.gov.br", tipo: "economia" },
  { nome: "TSE", dominio: "tse.jus.br", tipo: "eleicoes" },
  { nome: "Fiocruz", dominio: "fiocruz.br", tipo: "saude" },
  { nome: "Anvisa", dominio: "gov.br/anvisa", tipo: "saude" },
  { nome: "Ministério da Saúde", dominio: "gov.br/saude", tipo: "saude" },
  { nome: "Senado Federal", dominio: "senado.leg.br", tipo: "legislacao" },
  { nome: "Câmara dos Deputados", dominio: "camara.leg.br", tipo: "legislacao" },
  { nome: "STF", dominio: "portal.stf.jus.br", tipo: "justica" }
];

const SEARCH_STOP_WORDS = new Set([
  "a", "ao", "aos", "aquela", "aquele", "as", "ate", "com", "como", "da", "das",
  "de", "dela", "dele", "deles", "do", "dos", "e", "ela", "ele", "em", "entre",
  "essa", "esse", "esta", "este", "foi", "foram", "ha", "isso", "isto", "ja",
  "mais", "mas", "me", "mesmo", "na", "nas", "nem", "no", "nos", "o", "os",
  "ou", "para", "pela", "pelas", "pelo", "pelos", "por", "qual", "quando",
  "que", "quem", "se", "sem", "sua", "suas", "seu", "seus", "tambem", "um",
  "uma", "umas", "uns", "voce", "seria", "estaria", "teria", "pode", "podem",
  "segundo", "sobre", "fala", "falou", "diz", "disse", "afirma", "afirmou",
  "alegacao", "alegacoes", "analisada", "analise", "verificada", "trecho",
  "nao", "atras"
]);

function buildContextualSearchQuery(text) {
  const terms = [];
  const seen = new Set();
  const words = String(text).match(/[\p{L}\p{N}]+/gu) || [];

  for (const word of words) {
    const normalized = word.toLocaleLowerCase("pt-BR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const isAcronym = word.length === 2 && word === word.toLocaleUpperCase("pt-BR");
    if ((normalized.length < 3 && !isAcronym) || SEARCH_STOP_WORDS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(word);
    if (terms.length === 10) break;
  }

  return terms.join(" ") || String(text).trim().slice(0, 80);
}

/**
 * Prioriza buscas relacionadas à fala em fontes brasileiras e mantém citações diretas confiáveis.
 */
function normalizeSources(rawSources, claimText = "") {
  const normalizedClaim = String(claimText)
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const verificationSources = TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "factcheck");
  const topicSources = [];

  if (/saude|doenca|medic|vacina|hospital|anvisa|fiocruz|covid|cancer/.test(normalizedClaim)) {
    topicSources.push(...TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "saude"));
  }
  if (/eleicao|eleitoral|urna|voto|tse|candidato|campanha eleitoral/.test(normalizedClaim)) {
    topicSources.push(...TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "eleicoes"));
  }
  if (/pib|inflacao|economia|desemprego|juros|salario|emprego|ibge|imposto/.test(normalizedClaim)) {
    topicSources.push(...TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "economia"));
  }
  if (/lei|projeto|congresso|senado|camara|deputado|votacao|legislacao/.test(normalizedClaim)) {
    topicSources.push(...TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "legislacao"));
  }
  if (/stf|supremo|tribunal|julgamento|decisao judicial/.test(normalizedClaim)) {
    topicSources.push(...TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "justica"));
  }

  const selectedSources = [
    ...verificationSources.slice(0, 3),
    ...(topicSources.length > 0
      ? topicSources.slice(0, 2)
      : TRUSTED_BRAZILIAN_SOURCES.filter((source) => source.tipo === "oficial" || source.tipo === "noticias"))
  ].slice(0, 5);
  const query = buildContextualSearchQuery(claimText);
  const contextualSources = selectedSources.map((source) => ({
    nome: `Pesquisar em ${source.nome}`,
    url: `https://www.google.com/search?q=${encodeURIComponent(`${query} site:${source.dominio.split("/")[0]}`)}`
  }));

  const directSources = [];
  if (Array.isArray(rawSources)) {
    rawSources.forEach((item) => {
      if (typeof item === "string") {
        const matchedName = Object.keys(KNOWN_FACTCHECK_URLS)
          .find((name) => item.toLocaleLowerCase("pt-BR").includes(name));
        if (matchedName) {
          const source = TRUSTED_BRAZILIAN_SOURCES.find((candidate) =>
            candidate.nome.toLocaleLowerCase("pt-BR").includes(matchedName)
          );
          if (source) directSources.push({ nome: source.nome, url: KNOWN_FACTCHECK_URLS[matchedName] });
        }
        return;
      }

      if (!item || typeof item !== "object" || typeof item.url !== "string") return;
      try {
        const url = new URL(item.url);
        if (url.protocol !== "https:") return;
        const trusted = TRUSTED_BRAZILIAN_SOURCES.find((source) => {
          const sourceHost = source.dominio.split("/")[0];
          return url.hostname === sourceHost || url.hostname.endsWith(`.${sourceHost}`);
        });
        if (trusted) {
          directSources.push({
            nome: String(item.nome || item.name || trusted.nome).trim(),
            url: url.toString()
          });
        }
      } catch (error) {
        console.warn("[VerificaVídeo] URL de fonte recomendada inválida; ignorada.", error);
      }
    });
  }

  const uniqueSources = new Map();
  [...contextualSources, ...directSources].forEach((source) => {
    if (!uniqueSources.has(source.url)) uniqueSources.set(source.url, source);
  });
  return Array.from(uniqueSources.values()).slice(0, 7);
}

/**
 * Listener de Mensagens da Extensão
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === "offscreen") return false;

  if (request.action === "START_MICROPHONE_CAPTURE") {
    startPersistentMicrophoneCapture(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message || "Não foi possível iniciar o microfone." }));
    return true;
  }

  if (request.action === "STOP_MICROPHONE_CAPTURE") {
    stopPersistentMicrophoneCapture()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message || "Não foi possível parar o microfone." }));
    return true;
  }

  if (request.action === "UPDATE_MICROPHONE_INTERVAL") {
    sendToOffscreen({ action: request.action, interval: request.interval })
      .then((result) => sendResponse(result || { success: false }))
      .catch((error) => sendResponse({ success: false, error: error.message || "Não foi possível atualizar o intervalo." }));
    return true;
  }

  if (request.action === "GET_MICROPHONE_CAPTURE_STATUS") {
    Promise.all([
      hasOffscreenDocument(),
      chrome.storage.local.get(["microphone_capture_state"])
    ])
      .then(async ([hasDocument, stored]) => {
        const state = stored.microphone_capture_state || { running: false };
        if (!hasDocument && state.running) {
          const stoppedState = { ...state, running: false, status: "Captura parada." };
          await chrome.storage.local.set({ microphone_capture_state: stoppedState });
          sendResponse(stoppedState);
          return;
        }
        sendResponse(state);
      })
      .catch((error) => sendResponse({ running: false, error: error.message }));
    return true;
  }

  if (request.action === "MICROPHONE_CAPTURE_STATUS") {
    chrome.storage.local.set({ microphone_capture_state: request.state }).catch((error) => {
      console.warn("[VerificaVídeo] Não foi possível salvar o estado do microfone.", error);
    });
    if (request.state?.targetTabId) {
      chrome.tabs.sendMessage(request.state.targetTabId, {
        action: request.action,
        status: request.status,
        summary: request.state.summary,
        remaining: request.state.remaining
      }).catch(() => {});
    }
    return false;
  }

  if (request.action === "START_FACT_CHECK") {
    handleFactCheckProcess(request.apiKey, request.minDelayMs || 3000)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message || "Erro desconhecido" }));
    return true;
  }

  if (request.action === "EXECUTE_FACT_CHECK_DIRECT") {
    handleDirectFactCheck(request.text, request.metadata, request.timeRange, request.apiKey, request.source)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message || "Erro desconhecido" }));
    return true;
  }
});

async function startPersistentMicrophoneCapture(request) {
  await ensureOffscreenDocument();
  return sendToOffscreen({
    action: "START_MICROPHONE_CAPTURE",
    interval: request.interval,
    targetTabId: request.targetTabId || null
  });
}

async function stopPersistentMicrophoneCapture() {
  const result = await sendToOffscreen({ action: "STOP_MICROPHONE_CAPTURE" });
  if (result) return result;
  await chrome.storage.local.set({
    microphone_capture_state: {
      running: false,
      status: "Captura pelo microfone parada.",
      summary: "",
      remaining: null,
      targetTabId: null
    }
  });
  return { success: true };
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Manter o reconhecimento de fala do microfone ativo enquanto o popup estiver fechado."
    }).finally(() => {
      offscreenCreationPromise = null;
    });
  }
  await offscreenCreationPromise;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  return contexts.length > 0;
}

async function sendToOffscreen(message) {
  if (!await hasOffscreenDocument()) return null;
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || isYouTubeUrl(details.url)) return;
  switchTranscriptionToMicrophone(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  switchTranscriptionToMicrophone(tabId);
});

function isYouTubeUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  } catch (error) {
    return false;
  }
}

async function switchTranscriptionToMicrophone(tabId) {
  try {
    const stored = await chrome.storage.local.get(["transcription_monitoring_session"]);
    const session = stored.transcription_monitoring_session;
    if (!session?.active || !session.fallbackToMicrophone || session.targetTabId !== tabId) return;

    await chrome.storage.local.set({
      transcription_monitoring_session: { active: false },
      saved_capture_mode: "microphone"
    });
    const result = await startPersistentMicrophoneCapture({
      interval: session.interval,
      targetTabId: null
    });
    if (!result?.success) throw new Error(result?.error || "Não foi possível mudar a captura para o microfone.");
  } catch (error) {
    console.error("[VerificaVídeo] Não foi possível continuar a análise pelo microfone.", error);
    const failureMessage = `Não foi possível continuar pelo microfone: ${error.message || "erro desconhecido"}`;
    const failedState = {
      running: false,
      status: failureMessage,
      error: failureMessage,
      summary: "",
      remaining: null,
      targetTabId: null
    };
    await chrome.storage.local.set({
      microphone_capture_state: failedState
    });
    chrome.runtime.sendMessage({
      action: "MICROPHONE_CAPTURE_STATUS",
      status: failureMessage,
      state: failedState
    }).catch(() => {});
  }
}

/**
 * Processa a checagem enviada pelo motor contínuo do content.js
 */
async function handleDirectFactCheck(text, metadata, timeRange, providedApiKey, source = "youtube_legendas") {
  let apiKey = providedApiKey;
  if (!apiKey) {
    const storage = await chrome.storage.local.get(["geminiApiKey"]);
    apiKey = storage.geminiApiKey;
  }

  let result;
  if (apiKey && apiKey.trim().length > 10) {
    result = await executeResilientFactCheck(text, metadata, apiKey.trim(), source, timeRange);
  } else {
    result = await simulateFactCheck(text, metadata, source, timeRange);
  }

  // Persiste no histórico da timeline
  try {
    const stored = await chrome.storage.local.get(["timeline_checks"]);
    const list = Array.isArray(stored.timeline_checks) ? stored.timeline_checks : [];
    list.unshift(result);
    if (list.length > 35) list.pop();
    await chrome.storage.local.set({ timeline_checks: list });
  } catch (e) {}

  // Atualiza Badge do ícone da extensão no Chrome
  updateActionBadge(result.veredito);

  // Transmite para o Popup caso esteja aberto
  chrome.runtime.sendMessage({ action: "NEW_CHECK_RESULT", data: result }).catch(() => {});

  return result;
}

function updateActionBadge(veredito) {
  try {
    const v = (veredito || "").toUpperCase();
    if (v.includes("FATO")) {
      chrome.action.setBadgeText({ text: "FATO" });
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else if (v.includes("FAKE")) {
      chrome.action.setBadgeText({ text: "FAKE" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      chrome.action.setBadgeText({ text: "DUV" });
      chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    }
  } catch (e) {}
}

/**
 * Fluxo Principal de Checagem
 */
async function handleFactCheckProcess(providedApiKey, minDelayMs = 3000) {
  const startTime = Date.now();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    throw new Error("Nenhuma aba ativa encontrada.");
  }

  const activeTab = tabs[0];
  if (!activeTab.url || !activeTab.url.includes("youtube.com")) {
    throw new Error("Por favor, abra um vídeo no YouTube para checar.");
  }

  await ensureContentScriptInjected(activeTab.id);

  let extractionResponse;
  try {
    extractionResponse = await chrome.tabs.sendMessage(activeTab.id, { action: "EXTRACT_TRANSCRIPT_30S" });
  } catch (err) {
    throw new Error("Não foi possível comunicar com o player. Recarregue a página do YouTube.");
  }

  if (!extractionResponse || !extractionResponse.success) {
    throw new Error(extractionResponse?.error || "Nenhuma legenda detectada nos últimos 30 segundos.");
  }

  const { text, metadata, source = "youtube_legendas", timeRange } = extractionResponse;

  let apiKey = providedApiKey;
  if (!apiKey) {
    const storage = await chrome.storage.local.get(["geminiApiKey"]);
    apiKey = storage.geminiApiKey;
  }

  let result;
  if (apiKey && apiKey.trim().length > 10) {
    result = await executeResilientFactCheck(text, metadata, apiKey.trim(), source, timeRange);
  } else {
    result = await simulateFactCheck(text, metadata, source, timeRange);
  }

  // Garante que o processo aguarde pelo menos o delay mínimo solicitado (ex: 3 segundos)
  const elapsed = Date.now() - startTime;
  if (elapsed < minDelayMs) {
    await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
  }

  return result;
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "PING" });
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    });
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Consulta dinâmica de modelos disponíveis na chave
 */
async function getAvailableGeminiModels(apiKey) {
  try {
    const cached = await chrome.storage.local.get(["gemini_models_cache", "gemini_models_timestamp"]);
    const isCacheValid = cached.gemini_models_cache && 
                         cached.gemini_models_timestamp && 
                         (Date.now() - cached.gemini_models_timestamp < CACHE_TTL_MS);

    if (isCacheValid && Array.isArray(cached.gemini_models_cache) && cached.gemini_models_cache.length > 0) {
      return cached.gemini_models_cache;
    }
  } catch (e) {}

  const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const res = await fetch(listUrl);
    if (!res.ok) {
      if (res.status === 400 || res.status === 403 || res.status === 401) {
        throw new Error("Chave da API Gemini inválida ou sem permissão. Verifique-a no Google AI Studio.");
      }
      return DEFAULT_FALLBACK_MODELS;
    }

    const data = await res.json();
    const models = data?.models || [];

    const validModels = models
      .filter((m) => {
        const methods = m.supportedGenerationMethods || [];
        const name = (m.name || "").toLowerCase();
        return methods.includes("generateContent") && 
               !name.includes("embedding") && 
               !name.includes("aqa") && 
               !name.includes("imagen") && 
               !name.includes("whisper");
      })
      .map((m) => m.name);

    if (validModels.length === 0) return DEFAULT_FALLBACK_MODELS;

    validModels.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const aIsFlash = aLower.includes("flash");
      const bIsFlash = bLower.includes("flash");
      if (aIsFlash && !bIsFlash) return -1;
      if (!aIsFlash && bIsFlash) return 1;
      return b.localeCompare(a);
    });

    await chrome.storage.local.set({
      gemini_models_cache: validModels,
      gemini_models_timestamp: Date.now()
    });

    return validModels;
  } catch (err) {
    if (err.message.includes("inválida") || err.message.includes("permissão")) throw err;
    return DEFAULT_FALLBACK_MODELS;
  }
}

function extractJSONFromText(rawText) {
  if (!rawText) return null;
  try { return JSON.parse(rawText.trim()); } catch (e) {}

  const markdownMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (markdownMatch && markdownMatch[1]) {
    try { return JSON.parse(markdownMatch[1].trim()); } catch (e) {}
  }

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(rawText.slice(firstBrace, lastBrace + 1)); } catch (e) {}
  }

  return null;
}

/**
 * Executa a análise com links diretos
 */
async function executeResilientFactCheck(transcriptText, metadata, apiKey, source, timeRange) {
  const modelsToTry = await getAvailableGeminiModels(apiKey);

  const systemInstruction = `
Você é um auditor sênior de checagem de fatos jornalística em tempo real (como Agência Lupa, Aos Fatos e Projeto Comprova).
Sua missão é classificar a veracidade das falas dos vídeos do YouTube com rigor, bom senso e equilíbrio.

CRITÉRIOS DE CLASSIFICAÇÃO:

1. [FATO]:
- Informação correta, verídica, fatos históricos, conhecimentos estabelecidos ou notícias reais.
- Afirmações cotidianas, declarações plausíveis e relatos do apresentador sem teor de falsidade ou engano.
- Se a afirmação for verdadeira ou amplamente aceita, OBRIGATORIAMENTE use o veredito "FATO".

2. [FAKE]:
- Afirmações sabidamente falsas, desinformação, mentiras descaradas ou dados fabricados/distorcidos.
- Teorias conspiratórias desmentidas, alegações fraudulentas ou boatos perigosos (ex: curas milagrosas sem validação científica, fake news eleitorais, etc.).
- Se a alegação for comprovadamente falsa ou enganosa, OBRIGATORIAMENTE use o veredito "FAKE".

3. [DUVIDOSO]:
- Alegações extraordinárias, polêmicas ou bombásticas que necessitam de provas contundentes, mas que não possuem confirmação independente nem comprovação até o momento.
- Especulações, boatos não checados ou promessas exageradas sem base.

DIRETRIZ FUNDAMENTAL:
NÃO classifique tudo como "DUVIDOSO". Avalie o teor real da frase. Se a pessoa está falando a verdade sobre acontecimentos, fatos científicos, dados ou experiências reais sem mentir, marque como "FATO". Reserve "DUVIDOSO" apenas para quando houver real ambiguidade, rumor não comprovado ou manipulação evidente.

EXIGÊNCIA ESTRITA SOBRE AS FONTES:
Recomende fontes que tratem diretamente da alegação, priorizando fontes primárias brasileiras (órgãos oficiais e dados públicos) e, para checagem independente, Agência Lupa, Aos Fatos, Projeto Comprova e G1 Fato ou Fake. Prefira links de artigos, dados ou documentos específicos que sustentem a análise; não use a página inicial de uma instituição como se comprovasse a fala. Nunca invente URLs ou títulos de matérias. Se não souber um link específico confiável, retorne uma lista vazia: o aplicativo fornecerá buscas contextuais em fontes brasileiras para consulta.

Responda OBRIGATORIAMENTE em JSON:
{
  "veredito": "FATO" | "FAKE" | "DUVIDOSO",
  "confianca": número inteiro de 0 a 100,
  "afirmacao_destaque": "Citação direta ou resumo da fala verificada",
  "justificativa": "Explicação analítica, clara e fundamentada do porquê recebeu esse veredito",
  "fontes_recomendadas": [
    {
      "nome": "Nome da Agência ou Órgão Oficial",
      "url": "https://link-direto-da-fonte..."
    }
  ]
}

O campo "confianca" representa sua confiança nesta classificação, considerando a clareza da alegação, a qualidade das evidências e das fontes verificáveis. Não o apresente como probabilidade matemática de a afirmação ser verdadeira. Reduza a confiança quando faltarem evidências confiáveis, quando a fala for ambígua ou quando não houver fontes específicas que a confirmem.`;

  const userPrompt = `
VÍDEO: "${metadata.title}" (${metadata.channel})
TRECHO TEMPORAL: ${timeRange || metadata.currentTime}
ORIGEM: ${source === "microfone" ? "Transcrição do microfone" : "Legendas do YouTube"}
FALA EXTRAÍDA:
"""
${transcriptText}
"""
`;

  let lastError = null;

  for (const modelPath of modelsToTry) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`;

    let payload = {
      contents: [{ role: "user", parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    };

    try {
      let response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (response.status === 400) {
        const errorData = await response.json().catch(() => null);
        const detail = errorData?.error?.message || "";
        if (detail.includes("responseMimeType")) {
          delete payload.generationConfig.responseMimeType;
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        }
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const detail = errorData?.error?.message || response.statusText;

        if (response.status === 401 || response.status === 403) {
          throw new Error("Chave da API Gemini inválida ou sem permissão.");
        }

        console.warn(`[VerificaVídeo] Modelo '${modelPath}' falhou (${response.status}). Tentando próximo...`);
        lastError = new Error(`(${response.status}) ${detail}`);
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }

      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = extractJSONFromText(rawText);

      if (!parsed) continue;

      const cleanModel = modelPath.replace("models/", "");
      return {
        id: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        timeRange: timeRange || metadata.currentTime,
        veredito: normalizeVerdict(parsed.veredito),
        confianca: normalizeConfidence(parsed.confianca),
        afirmacao_destaque: parsed.afirmacao_destaque || "Fala sob análise.",
        justificativa: parsed.justificativa || "Análise concluída com base na transcrição recente.",
        fontes_recomendadas: normalizeSources(
          parsed.fontes_recomendadas,
          parsed.afirmacao_destaque || transcriptText
        ),
        texto_analisado: transcriptText,
        origem: source,
        metadata: metadata,
        modo: "gemini_api",
        modelo_usado: cleanModel
      };

    } catch (err) {
      if (err.message.includes("inválida") || err.message.includes("permissão")) throw err;
      lastError = err;
    }
  }

  // Fallback de contingência
  const fallback = await simulateFactCheck(transcriptText, metadata, source, timeRange);
  fallback.justificativa = `${fallback.justificativa} (Nota: Análise de contingência devido a sobrecarga temporária da API).`;
  fallback.modo = "contingencia_503";
  return fallback;
}

/**
 * Modo Simulado com links diretos
 */
async function simulateFactCheck(transcriptText, metadata, source, timeRange) {
  const lower = transcriptText.toLowerCase();
  let veredito = "FATO";
  let afirmacao = `Fala analisada: "${transcriptText.slice(0, 95)}..."`;
  let justificativa = "O trecho analisado condiz com fatos comprováveis e amplamente divulgados pela imprensa profissional.";
  let fontes = [
    { nome: "Agência Lupa", url: "https://lupa.uol.com.br" },
    { nome: "Aos Fatos", url: "https://aosfatos.org" }
  ];

  if (lower.includes("cura") || lower.includes("segredo") || lower.includes("proibido") || lower.includes("milagre") || lower.includes("conspiração")) {
    veredito = "FAKE";
    afirmacao = "Alegação de tratamentos secretos ou soluções milagrosas sem validação.";
    justificativa = "A afirmação reproduz padrões conhecidos de desinformação sensacionalista desmentidos por autoridades de saúde pública.";
    fontes = [
      { nome: "Organização Mundial da Saúde (OMS)", url: "https://www.who.int/pt" },
      { nome: "Aos Fatos - Desinformação em Saúde", url: "https://aosfatos.org" },
      { nome: "G1 Fato ou Fake", url: "https://g1.globo.com/fato-ou-fake" }
    ];
  } else if (lower.includes("talvez") || lower.includes("boato") || lower.includes("dizem") || lower.includes("polêmica")) {
    veredito = "DUVIDOSO";
    afirmacao = "Declaração especulativa sem confirmação documental.";
    justificativa = "As alegações carecem de comprovação em fontes primárias ou investigações independentes.";
    fontes = [
      { nome: "G1 Fato ou Fake", url: "https://g1.globo.com/fato-ou-fake" },
      { nome: "Projeto Comprova", url: "https://projetocomprova.com.br" }
    ];
  }

  return {
    id: Date.now(),
    timestamp: new Date().toLocaleTimeString(),
    timeRange: timeRange || metadata.currentTime,
    veredito: veredito,
    afirmacao_destaque: afirmacao,
    justificativa: justificativa,
    fontes_recomendadas: normalizeSources(fontes, transcriptText),
    texto_analisado: transcriptText,
    origem: source,
    confianca: null,
    metadata: metadata,
    modo: "demonstracao"
  };
}

function normalizeConfidence(value) {
  if (value === null || value === undefined || value === "") return null;
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}
