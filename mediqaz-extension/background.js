// ============================================================
// background.js — MediQaz Service Worker v1.0
// Groq API rate limiting + content.js injection
// ============================================================
'use strict';

// ─── Открытие боковой панели при клике на иконку ────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Keep-alive: будим Service Worker каждые 30 секунд ──────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {}); // keep service worker alive

// ════════════════════════════════════════════════════════════
// RATE LIMITING — очередь запросов к Groq API
// Макс 1 запрос одновременно, retry 2 раза с задержкой 1s
// ════════════════════════════════════════════════════════════

let groqQueue = [];          // очередь запросов
let groqBusy  = false;       // флаг: идёт ли запрос сейчас

/**
 * Добавляет Groq-запрос в очередь и возвращает Promise с результатом.
 */
function enqueueGroqRequest(payload) {
  return new Promise((resolve, reject) => {
    groqQueue.push({ payload, resolve, reject });
    processGroqQueue();
  });
}

/**
 * Обрабатывает очередь: берёт один запрос, выполняет, переходит к следующему.
 */
async function processGroqQueue() {
  if (groqBusy || groqQueue.length === 0) return;

  groqBusy = true;
  const { payload, resolve, reject } = groqQueue.shift();

  try {
    const result = await callGroqWithRetry(payload);
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    groqBusy = false;
    // Переходим к следующему в очереди
    if (groqQueue.length > 0) processGroqQueue();
  }
}

/**
 * Выполняет запрос к Groq API с retry (2 попытки, задержка 1s между ними).
 */
async function callGroqWithRetry(payload, attempt = 0) {
  try {
    return await callGroqAPI(payload);
  } catch (err) {
    // Retry только при сетевых ошибках или 429/500
    const isRetryable = err.message.includes('429') ||
                        err.message.includes('500') ||
                        err.message.includes('503') ||
                        err.message.includes('fetch');

    if (attempt < 2 && isRetryable) {
      console.log(`[Groq] Retry ${attempt + 1}/2 через 1s. Ошибка: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000));
      return callGroqWithRetry(payload, attempt + 1);
    }
    throw err;
  }
}

/**
 * Прямой fetch к Groq API.
 */
async function callGroqAPI(payload) {
  let { apiKey, messages, temperature = 0.3, responseFormat } = payload;

  // Если ключ не передан — берём из storage
  if (!apiKey) {
    const data = await chrome.storage.local.get(['groqKey']);
    apiKey = data.groqKey;
  }

  if (!apiKey) {
    throw new Error('Groq API ключ не настроен. Откройте настройки ⚙️');
  }

  const requestBody = {
    model:       'llama-3.3-70b-versatile',
    messages,
    temperature,
    max_tokens:  4096,
  };

  if (responseFormat === 'json') {
    requestBody.response_format = { type: 'json_object' };
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const msg = errorData.error?.message || 'Неизвестная ошибка';
    throw new Error(`Groq API ошибка ${response.status}: ${msg}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

// ════════════════════════════════════════════════════════════
// МАРШРУТИЗАТОР СООБЩЕНИЙ
// ════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Запрос к Groq API (через очередь)
  if (message.type === 'GROQ_REQUEST') {
    const isQueued = groqQueue.length > 0;
    if (isQueued) {
      // Уведомляем sidepanel что запрос встал в очередь
      chrome.runtime.sendMessage({ type: 'GROQ_QUEUED' }).catch(() => {});
    }

    enqueueGroqRequest(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true; // асинхронный ответ
  }

  // Заполнение формы МИС — инжектируем content.js
  if (message.type === 'FILL_FORM') {
    handleFillForm(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Состояние очереди Groq
  if (message.type === 'GROQ_QUEUE_STATUS') {
    sendResponse({ queueLength: groqQueue.length, busy: groqBusy });
    return true;
  }

  // Текущая сессия
  if (message.type === 'GET_STATE') {
    chrome.storage.local.get(['currentSession'], (result) => {
      sendResponse({ success: true, data: result.currentSession || null });
    });
    return true;
  }
});

// ─── День 9: Инъекция content.js и заполнение МИС ──────────────
async function handleFillForm(payload) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab) throw new Error('Нет активной вкладки. Откройте страницу МИС.');

  const tabUrl = activeTab.url || '';
  if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://') || tabUrl.startsWith('about:')) {
    throw new Error('Откройте страницу МИС (Damumed или e-MIS) в активной вкладке.');
  }

  // Инъектируем content.js
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files:  ['content.js'],
    });
  } catch (injErr) {
    console.error('[MediQaz] Ошибка инъекции:', injErr);
    throw new Error(`Нет доступа к странице: ${injErr.message}`);
  }

  // Ждём загрузки скрипта
  await new Promise(r => setTimeout(r, 400));

  // Отправляем медкарту для заполнения
  const medCard = payload.medCard || payload;

  try {
    const result = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'FILL_FORM_DATA',
      medCard,
    });
    return result;
  } catch (sendErr) {
    console.error('[MediQaz] Ошибка отправки сообщения:', sendErr);
    throw new Error(`Ошибка связи с content.js: ${sendErr.message}`);
  }
}

console.log('[MediQaz] Service Worker запущен ✅ (День 9: Автозаполнение МИС активно)');
