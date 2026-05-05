// ============================================================
// sidepanel.js — MediQaz AI Ассистент Врача — Боковая панель v1.0
// Запись → Deepgram → Groq → Медкарта → PDF/МИС
// ============================================================
'use strict';

// ─── Константы ───────────────────────────────────────────────
const DEEPGRAM_PARAMS = {
  model: 'nova-2',
  language: 'ru',
  smart_format: 'true',
  diarize: 'true',
  punctuate: 'true',
  interim_results: 'true',
  utterance_end_ms: '1000',
  encoding: 'opus',
  sample_rate: '16000',
  channels: '1',
};

// Варианты произношения названия (для голосовых макросов)
const WAKE_WORDS = ['медиказ', 'меди каз', 'mediqaz', 'medi qaz', 'медиказь', 'медикас'];

// IndexedDB хранилище (через idb-keyval)
// idb-keyval предоставляет: get, set, del, keys, createStore
const idbStore = idbKeyval.createStore('MediQazDB', 'appointments');

// Максимум приёмов в IndexedDB (FIFO)
const MAX_APPOINTMENTS = 3;

// ─── Состояние приложения ────────────────────────────────────
const state = {
  isRecording: false,
  deepgramWS: null,
  mediaStream: null,
  recorderA: null,        // → Deepgram
  recorderB: null,        // → локальное аудио
  audioChunks: [],
  wordTimestamps: [],          // [{word, start, end, speaker}]
  fullTranscript: '',
  interimText: '',
  timerInterval: null,
  timerSeconds: 0,
  reconnectCount: 0,
  maxReconnect: 3,
  medCard: null,
  currentAudioUrl: null,        // objectURL для Linked Evidence
  currentSessionId: null,       // ID текущего приёма в IndexedDB
  voiceCommands: [],         // Список команд, отловленных через "Медиказ..."
  apiKeys: { deepgram: '', groq: '' },
  settings: {
    specialty: 'therapist',
    language: 'ru',
    doctorName: '',
    customInstructions: '',
  },
};

// ─── DOM элементы ────────────────────────────────────────────
const btnSettings = document.getElementById('btnSettings');
const specialtySelect = document.getElementById('specialtySelect');
const doctorName = document.getElementById('doctorName');
const patientName = document.getElementById('patientName');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const recordingTimer = document.getElementById('recordingTimer');
const transcriptionArea = document.getElementById('transcriptionArea');
const btnCopyTranscript = document.getElementById('btnCopyTranscript');
const btnAskQuestion = document.getElementById('btnAskQuestion');
const btnGenerate = document.getElementById('btnGenerate');
const generateSpinner = document.getElementById('generateSpinner');
const medCardBlock = document.getElementById('medCardBlock');
const medCardSections = document.getElementById('medCardSections');
const blockQA = document.getElementById('blockQA');
const qaInput = document.getElementById('qaInput');
const btnQaSend = document.getElementById('btnQaSend');
const qaAnswer = document.getElementById('qaAnswer');
const qaSpinner = document.getElementById('qaSpinner');
const btnQaEvidence = document.getElementById('btnQaEvidence');
const btnFillMIS = document.getElementById('btnFillMIS');
const btnExportPDF = document.getElementById('btnExportPDF');
const btnNewSession = document.getElementById('btnNewSession');
const sessionStatus = document.getElementById('sessionStatus');
const toastContainer = document.getElementById('toastContainer');

// ─── Обновление статус-строки ────────────────────────────────────────────
function updateStatus(text, isRecording = false) {
  sessionStatus.innerHTML = isRecording
    ? `<span class="recording-dot"></span>${text}`
    : text;
  sessionStatus.className = `session-status${isRecording ? ' recording' : ''}`;
}

// ════════════════════════════════════════════════════════════
// УТИЛИТЫ
// ════════════════════════════════════════════════════════════

// ─── Toast уведомления ───────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ─── Таймер записи ───────────────────────────────────────────
function startTimer() {
  state.timerSeconds = 0;
  recordingTimer.textContent = '00:00:00';
  state.timerInterval = setInterval(() => {
    state.timerSeconds++;
    const h = Math.floor(state.timerSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((state.timerSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = (state.timerSeconds % 60).toString().padStart(2, '0');
    recordingTimer.textContent = `${h}:${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
}

// ─── Форматирование секунд → mm:ss ──────────────────────────
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Нормализация текста (для поиска таймкодов) ──────────────
function normalizeText(str) {
  return str
    .toLowerCase()
    .replace(/[.,!?;:«»""''()\-—]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Поддерживаемый MIME-тип ─────────────────────────────────
function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm';
}

// ─── Загрузка настроек из chrome.storage ────────────────────
async function loadSettings() {
  const local = await chrome.storage.local.get(['deepgramKey', 'groqKey']);
  state.apiKeys.deepgram = local.deepgramKey || '';
  state.apiKeys.groq = local.groqKey || '';

  const sync = await chrome.storage.sync.get([
    'doctorName', 'specialty', 'language', 'customInstructions',
  ]);

  if (sync.doctorName) doctorName.value = sync.doctorName;
  if (sync.specialty) {
    specialtySelect.value = sync.specialty;
    state.settings.specialty = sync.specialty;
  }
  if (sync.language) state.settings.language = sync.language;
  if (sync.customInstructions) state.settings.customInstructions = sync.customInstructions;
}

// ─── Сохранение имени врача при изменении ───────────────────
doctorName.addEventListener('change', () => {
  chrome.storage.sync.set({ doctorName: doctorName.value });
});

specialtySelect.addEventListener('change', () => {
  state.settings.specialty = specialtySelect.value;
  chrome.storage.sync.set({ specialty: specialtySelect.value });
});

// ════════════════════════════════════════════════════════════
// INDEXED DB — idb-keyval
// ════════════════════════════════════════════════════════════

/**
 * Сохраняет приём в IndexedDB.
 * Структура: { id, timestamp, audioBlob, transcription, wordTimestamps, medCard }
 * FIFO: максимум MAX_APPOINTMENTS записей, старые удаляются.
 */
async function saveAppointment(audioBlob) {
  try {
    const id = state.currentSessionId || Date.now().toString();
    state.currentSessionId = id;

    // Получаем все ключи и удаляем лишние (FIFO)
    const allKeys = await idbKeyval.keys(idbStore);
    if (allKeys.length >= MAX_APPOINTMENTS) {
      // Числовая сортировка по timestamp (не лексикографическая!)
      const sorted = [...allKeys].sort((a, b) => Number(a) - Number(b));
      const toDelete = sorted.slice(0, sorted.length - MAX_APPOINTMENTS + 1);
      await Promise.all(toDelete.map(k => idbKeyval.del(k, idbStore)));
    }

    // Сохраняем запись
    await idbKeyval.set(id, {
      id,
      timestamp: Date.now(),
      audioBlob,
      transcription: state.fullTranscript,
      wordTimestamps: state.wordTimestamps,
      medCard: state.medCard,
      doctorName: doctorName.value,
      patientName: patientName.value,
    }, idbStore);

    return id;

  } catch (err) {
    console.error('[IndexedDB] Ошибка сохранения:', err);
    showToast('Ошибка сохранения аудио в IndexedDB', 'error');
    return null;
  }
}

/**
 * Загружает аудио из IndexedDB по ID сессии.
 * Используется для Linked Evidence.
 */
async function loadAudio(sessionId) {
  try {
    const record = await idbKeyval.get(sessionId, idbStore);
    return record?.audioBlob || null;
  } catch (err) {
    console.error('[IndexedDB] Ошибка загрузки:', err);
    return null;
  }
}

/**
 * Возвращает список всех сохранённых приёмов (без аудио, только метаданные).
 */
async function getAllAppointments() {
  try {
    const keys = await idbKeyval.keys(idbStore);
    const records = await Promise.all(
      keys.map(k => idbKeyval.get(k, idbStore))
    );
    return records
      .filter(Boolean)
      .map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        transcription: r.transcription,
        doctorName: r.doctorName,
        patientName: r.patientName,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch (err) {
    console.error('[IndexedDB] Ошибка чтения:', err);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// ЗАПИСЬ АУДИО
// ════════════════════════════════════════════════════════════

async function startRecording() {
  if (!state.apiKeys.deepgram) {
    showToast('Введите Deepgram API Key в настройках ⚙️', 'error', 5000);
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showToast('Доступ к микрофону запрещён. Разрешите в настройках браузера.', 'error', 6000);
    } else {
      showToast(`Ошибка микрофона: ${err.message}`, 'error');
    }
    return;
  }

  // Сброс состояния новой сессии
  state.audioChunks = [];
  state.wordTimestamps = [];
  state.fullTranscript = '';
  state.interimText = '';
  state.reconnectCount = 0;
  state.currentSessionId = Date.now().toString();
  transcriptionArea.value = '';

  // ── Поток A: Deepgram ────────────────────────────────────
  connectDeepgram();

  // ── Поток B: локальное аудио (для Linked Evidence) ───────
  const mimeType = getSupportedMimeType();
  state.recorderB = new MediaRecorder(state.mediaStream, { mimeType });
  state.recorderB.ondataavailable = (e) => {
    if (e.data?.size > 0) state.audioChunks.push(e.data);
  };
  state.recorderB.start(500); // БАГ #4: 500мс вместо 1000мс — меньше риск потери данных при короткой записи

  // UI
  state.isRecording = true;
  btnStart.classList.add('hidden');
  btnStop.classList.remove('hidden');
  btnStop.classList.add('recording');
  recordingTimer.classList.add('recording');
  startTimer();
  updateStatus('Запись идёт... говорите свободно', true);
  showToast('Запись началась 🎤', 'success');
}

async function stopRecording() {
  state.isRecording = false;

  // Закрываем Deepgram WS
  if (state.deepgramWS) {
    if (state.deepgramWS.readyState === WebSocket.OPEN) {
      state.deepgramWS.send(JSON.stringify({ type: 'CloseStream' }));
    }
    state.deepgramWS.close();
    state.deepgramWS = null;
  }

  // Останавливаем Поток A
  if (state.recorderA?.state !== 'inactive') state.recorderA.stop();

  // Останавливаем Поток B → ЖДЁМ onstop → сохраняем в IndexedDB
  // БАГ #1: mediaStream нельзя убивать до того как recorderB отдаст последний чанк
  if (state.recorderB?.state !== 'inactive') {
    // Принудительно запрашиваем последний чанк перед остановкой
    if (state.recorderB.state === 'recording') {
      try { state.recorderB.requestData(); } catch (_) { }
    }

    // Ждём завершения через Promise — не через колбэк
    await new Promise(resolve => {
      state.recorderB.onstop = resolve;
      state.recorderB.stop();
    });

    // Сохраняем ПОСЛЕ того как recorderB полностью остановился
    if (state.audioChunks.length > 0) {
      const mimeType = getSupportedMimeType();
      const audioBlob = new Blob(state.audioChunks, { type: mimeType });

      if (state.currentAudioUrl) URL.revokeObjectURL(state.currentAudioUrl);
      state.currentAudioUrl = URL.createObjectURL(audioBlob);

      const savedId = await saveAppointment(audioBlob);
      if (savedId) showToast('Приём сохранён в IndexedDB 💾', 'success');
    } else {
      console.warn('[MediQaz] audioChunks пуст — аудио не записалось');
      showToast('⚠️ Аудио не записалось (слишком короткая запись?)', 'error', 5000);
    }
  }

  // Останавливаем поток микрофона ТОЛЬКО ПОСЛЕ завершения recorderB
  state.mediaStream?.getTracks().forEach(t => t.stop());
  state.mediaStream = null;

  // Сохраняем транскрипцию в chrome.storage (текстовая история)
  await saveTranscriptToHistory();

  // UI
  btnStop.classList.add('hidden');
  btnStop.classList.remove('recording');
  btnStart.classList.remove('hidden');
  recordingTimer.classList.remove('recording');
  stopTimer();

  const lines = state.fullTranscript.split('\n').length;
  updateStatus(`Приём записан — ${lines} фраз, ${state.wordTimestamps.length} слов`);
  showToast('Запись завершена ✅', 'success');
}

// ─── Сохранение транскрипции в историю (chrome.storage.local) ─
async function saveTranscriptToHistory() {
  if (!state.fullTranscript) return;

  const local = await chrome.storage.local.get(['appointmentHistory']);
  const history = local.appointmentHistory || [];

  history.unshift({
    id: state.currentSessionId,
    timestamp: Date.now(),
    transcription: state.fullTranscript,
    doctorName: doctorName.value,
    patientName: patientName.value,
    specialty: state.settings.specialty,
  });

  // Максимум 100 записей в истории
  if (history.length > 100) history.splice(100);

  await chrome.storage.local.set({ appointmentHistory: history });
}

// ════════════════════════════════════════════════════════════
// DEEPGRAM WEBSOCKET
// ════════════════════════════════════════════════════════════

function connectDeepgram() {
  const settingLang = state.settings.language;
  const lang = settingLang === 'kk' ? 'kk' : (settingLang === 'multi' ? 'multi' : 'ru');
  const params = new URLSearchParams({ ...DEEPGRAM_PARAMS, language: lang });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const ws = new WebSocket(url, ['token', state.apiKeys.deepgram]);
  state.deepgramWS = ws;

  ws.onopen = () => {
    state.reconnectCount = 0;

    // Запускаем Поток A
    const mimeType = getSupportedMimeType();
    state.recorderA = new MediaRecorder(state.mediaStream, { mimeType });
    state.recorderA.ondataavailable = (e) => {
      if (e.data?.size > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(e.data);
      }
    };
    state.recorderA.start(250);
  };

  ws.onmessage = (e) => handleDeepgramMessage(e.data);

  ws.onerror = (err) => {
    console.error('[Deepgram] Ошибка:', err);
  };

  ws.onclose = (e) => {
    if (state.isRecording && state.reconnectCount < state.maxReconnect) {
      const delay = Math.pow(2, state.reconnectCount) * 1000;
      state.reconnectCount++;
      showToast(
        `Переподключение к Deepgram... (${state.reconnectCount}/${state.maxReconnect})`,
        'info'
      );
      setTimeout(() => { if (state.isRecording) connectDeepgram(); }, delay);
    } else if (state.isRecording) {
      showToast('Потеряно соединение с Deepgram. Проверьте API ключ.', 'error', 6000);
      stopRecording();
    }
  };
}

function handleDeepgramMessage(rawData) {
  let data;
  try { data = JSON.parse(rawData); } catch { return; }

  if (data.type !== 'Results') return;

  const alternatives = data.channel?.alternatives;
  if (!alternatives?.length) return;

  const best = alternatives[0];
  const transcript = best.transcript || '';
  const isFinal = data.is_final;
  const words = best.words || [];
  const speaker = words[0]?.speaker ?? 0;
  const label = speaker === 0 ? '🔵 Врач' : '🟢 Пациент';

  if (isFinal && transcript.trim()) {
    // Сохраняем таймкоды слов (per-word, точно)
    words.forEach(w => {
      state.wordTimestamps.push({
        word: normalizeText(w.word),
        start: w.start,
        end: w.end,
        speaker: w.speaker ?? 0,
      });
    });

    // БАГ #3: Deepgram может склеить слова разных спикеров в один utterance.
    // Группируем слова по непрерывным сегментам одного спикера.
    const segments = [];
    let curSpeaker = -1;
    let curText = '';
    for (const w of words) {
      const sp = w.speaker ?? 0;
      if (sp !== curSpeaker) {
        if (curText.trim()) segments.push({ speaker: curSpeaker, text: curText.trim() });
        curSpeaker = sp;
        curText = '';
      }
      curText += (w.punctuated_word || w.word) + ' ';
    }
    if (curText.trim()) segments.push({ speaker: curSpeaker, text: curText.trim() });

    // Каждый сегмент — отдельная строка с правильным лейблом
    const lines = segments.map(s => {
      const lbl = s.speaker === 0 ? '🔵 Врач' : '🟢 Пациент';
      return `${lbl}: ${s.text}`;
    });

    state.fullTranscript += (state.fullTranscript ? '\n' : '') + lines.join('\n');
    state.interimText = '';
    updateTranscriptionUI();
    checkWakeWords(transcript);

  } else if (!isFinal && transcript.trim()) {
    state.interimText = `${label}: ${transcript}...`;
    updateTranscriptionUI(true);
  }
}

function updateTranscriptionUI(withInterim = false) {
  const display = withInterim
    ? state.fullTranscript + (state.fullTranscript ? '\n' : '') + state.interimText
    : state.fullTranscript;
  transcriptionArea.value = display;
  transcriptionArea.scrollTop = transcriptionArea.scrollHeight;
}

function checkWakeWords(text) {
  const norm = normalizeText(text);

  // Ищем совпадение с любым wake word
  for (const word of WAKE_WORDS) {
    const index = norm.indexOf(word);
    if (index !== -1) {
      // Извлекаем всё, что идёт ПОСЛЕ вейк-ворда
      const command = text.slice(index + word.length).trim();
      if (command.length > 3) {
        state.voiceCommands.push(command);
        showToast(`🎙 Команда: "${command}"`, 'info', 3000);

        // Визуально подсвечиваем в транскрипции (опционально)
        updateStatus(`Принята команда: ${command}`);
        setTimeout(() => updateStatus(`Запись...`, true), 3000);
      }
      break;
    }
  }
}

// ════════════════════════════════════════════════════════════
// ДЕНЬ 7: LINKED EVIDENCE — аудио-доказательства
// ════════════════════════════════════════════════════════════

// Ссылка на текущий Audio-объект воспроизведения (чтобы можно было остановить)
let activeAudio = null;
let activeAudioTimer = null;
let activeSection = null;    // ID секции которая сейчас играет

/**
 * findAudioTimestamp() — Sliding Window с fallback с 3 слов → 2 слова → 1 слово.
 * Чем длиннее секвенция — тем точнее попадание.
 * @param {string} quote     — цитата из медкарты
 * @param {number} ctxSec    — дополнительный контекст до/после (сек)
 * @returns {{ startSec, endSec, score } | null}
 */
function findAudioTimestamp(quote, ctxSec = 2.5) {
  const words = normalizeText(quote).split(' ').filter(Boolean);
  if (!words.length || !state.wordTimestamps.length) return null;

  const wt = state.wordTimestamps;

  // Попытки по убывающему окну: 3 → 2 → 1 слово
  for (let winSize = Math.min(3, words.length); winSize >= 1; winSize--) {
    const seq = words.slice(0, winSize);

    for (let i = 0; i <= wt.length - seq.length; i++) {
      const match = seq.every((w, j) => wt[i + j]?.word === w);
      if (match) {
        const endIdx = Math.min(i + words.length - 1, wt.length - 1);
        return {
          startSec: Math.max(0, wt[i].start - ctxSec),
          endSec: (wt[endIdx]?.end ?? wt[i].end) + ctxSec,
          score: winSize,   // качество матча (3 = лучшее)
        };
      }
    }
  }
  return null;
}

/**
 * stopActiveAudio() — Останавливает любое активное воспроизведение и снимает подсветку.
 */
function stopActiveAudio() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeAudioTimer) {
    clearTimeout(activeAudioTimer);
    activeAudioTimer = null;
  }
  // Снимаем подсветку с секции
  if (activeSection) {
    const el = document.getElementById(`section-${activeSection}`);
    el?.classList.remove('playing');
    activeSection = null;
  }
  hideMiniPlayer();
}

/**
 * playEvidence() — воспроизводит фрагмент аудио с мини-плеером.
 * @param {number} startSec  — начало (сек)
 * @param {number} endSec    — конец (сек)
 * @param {string} sectionKey — ключ секции (для подсветки)
 * @param {string} label     — подпись для мини-плеера
 */
async function playEvidence(startSec, endSec, sectionKey = null, label = '') {
  // Если уже играет — останавливаем
  if (activeAudio && !activeAudio.paused) {
    stopActiveAudio();
    return;
  }

  if (!state.currentSessionId) {
    showToast('Аудио недоступно — запись не сохранена', 'error');
    return;
  }

  // Загружаем аудио URL
  let audioUrl = state.currentAudioUrl;
  if (!audioUrl) {
    const blob = await loadAudio(state.currentSessionId);
    if (!blob) { showToast('Аудио не найдено в базе', 'error'); return; }
    audioUrl = URL.createObjectURL(blob);
    state.currentAudioUrl = audioUrl;
  }

  stopActiveAudio(); // Сначала останавливаем предыдущее

  const audio = new Audio(audioUrl);
  activeAudio = audio;

  // Подсвечиваем секцию
  if (sectionKey) {
    activeSection = sectionKey;
    const secEl = document.getElementById(`section-${sectionKey}`);
    secEl?.classList.add('playing');
  }

  const duration = endSec - startSec;
  showMiniPlayer(label || `Сегмент ${formatTime(startSec)} — ${formatTime(endSec)}`, duration, audio);

  audio.currentTime = startSec;
  await audio.play().catch(err => {
    showToast(`Ошибка воспроизведения: ${err.message}`, 'error');
    stopActiveAudio();
  });

  activeAudioTimer = setTimeout(() => stopActiveAudio(), duration * 1000 + 300);
}

// ─── Мини-плеер ─────────────────────────────────────────────────
let miniPlayerTimerId = null;

function showMiniPlayer(label, durationSec, audio) {
  let player = document.getElementById('miniPlayer');
  if (!player) {
    player = document.createElement('div');
    player.id = 'miniPlayer';
    player.className = 'mini-player';
    player.innerHTML = `
      <div class="mini-player-info">
        <span class="mini-player-icon">🔊</span>
        <span class="mini-player-label" id="miniPlayerLabel"></span>
      </div>
      <div class="mini-player-controls">
        <div class="mini-player-progress">
          <div class="mini-player-bar" id="miniPlayerBar"></div>
        </div>
        <span class="mini-player-time" id="miniPlayerTime">0:00</span>
        <button class="mini-player-stop" id="miniPlayerStop">⏹</button>
      </div>
    `;
    document.body.appendChild(player);
    document.getElementById('miniPlayerStop').addEventListener('click', () => stopActiveAudio());
  }

  document.getElementById('miniPlayerLabel').textContent = label;
  player.classList.add('visible');

  // Прогресс-бар
  const bar = document.getElementById('miniPlayerBar');
  const timeEl = document.getElementById('miniPlayerTime');
  const startAt = audio.currentTime;
  let elapsed = 0;

  clearInterval(miniPlayerTimerId);
  miniPlayerTimerId = setInterval(() => {
    elapsed = audio.currentTime - startAt;
    const pct = Math.min((elapsed / durationSec) * 100, 100);
    bar.style.width = `${pct}%`;
    timeEl.textContent = formatTime(audio.currentTime);
    if (audio.paused) clearInterval(miniPlayerTimerId);
  }, 100);
}

function hideMiniPlayer() {
  clearInterval(miniPlayerTimerId);
  const player = document.getElementById('miniPlayer');
  player?.classList.remove('visible');
}

// ════════════════════════════════════════════════════════════
// ОБРАБОТЧИКИ СОБЫТИЙ
// ════════════════════════════════════════════════════════════

btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

btnStart.addEventListener('click', () => startRecording());
btnStop.addEventListener('click', () => stopRecording());

btnCopyTranscript.addEventListener('click', () => {
  if (!state.fullTranscript) { showToast('Транскрипция пуста', 'error'); return; }
  navigator.clipboard.writeText(state.fullTranscript).then(() => {
    showToast('Транскрипция скопирована', 'success');
  });
});

btnAskQuestion.addEventListener('click', () => {
  blockQA.classList.toggle('hidden');
  if (!blockQA.classList.contains('hidden')) qaInput.focus();
});

btnGenerate.addEventListener('click', () => generateMedCard());

// ─── День 10: Q&A ПО ПРИЁМУ ─────────────────────────────────
btnQaSend.addEventListener('click', () => handleQASend());
qaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleQASend();
  }
});

/**
 * handleQASend() — отправляет вопрос по приёму в Groq.
 */
async function handleQASend() {
  const question = qaInput.value.trim();
  if (!question) {
    showToast('Введите вопрос', 'error');
    return;
  }

  if (!state.fullTranscript) {
    showToast('Сначала запишите приём', 'error');
    return;
  }

  if (!navigator.onLine) {
    showToast('Нет подключения к интернету 📡', 'error');
    return;
  }

  qaInput.disabled = true;
  btnQaSend.disabled = true;
  qaSpinner.classList.remove('hidden');
  qaAnswer.classList.add('hidden');
  btnQaEvidence.classList.add('hidden');

  try {
    const specialty = SPECIALTY_NAMES[state.settings.specialty] || 'Терапевт';

    const systemPrompt = `Ты — опытный врач-ассистент (${specialty}). 
Отвечай на вопросы врача, основываясь ТОЛЬКО на предоставленной транскрипции приёма.
Если ответа нет в тексте — так и скажи.
Если ответ найден, обязательно включи в конец ответа точную цитату в кавычках для подтверждения.
Пример: "Да, пациент жаловался на боли в колене. Цитата: «нога болит в районе коленной чашечки уже три дня»"`;

    const userPrompt = `ТРАНСКРИПЦИЯ ПРИЁМА:\n${state.fullTranscript}\n\nВОПРОС ВРАЧА: ${question}`;

    const rawResponse = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 'text');

    const answer = rawResponse.trim();

    // Рендерим ответ с анимацией
    qaAnswer.textContent = answer;
    qaAnswer.classList.remove('hidden');

    // Ищем цитату для Linked Evidence
    const quoteMatch = answer.match(/[«\"\'\“]([^»\"\'\”]{10,})[»\"\'\”]/);
    if (quoteMatch) {
      const quote = quoteMatch[1];
      const ts = findAudioTimestamp(quote);
      if (ts) {
        btnQaEvidence.classList.remove('hidden');
        btnQaEvidence.innerHTML = `<span>▶ Слушать цитату</span> <span style="opacity:0.6;font-size:10px">(${formatTime(ts.startSec)})</span>`;

        // Перезаписываем обработчик клика
        const newBtn = btnQaEvidence.cloneNode(true);
        btnQaEvidence.parentNode.replaceChild(newBtn, btnQaEvidence);

        newBtn.addEventListener('click', () => {
          playEvidence(ts.startSec, ts.endSec, 'qa', `Вопрос: ${question}`);
        });
      }
    }

  } catch (err) {
    console.error('[QA] Ошибка:', err);
    showToast(`Ошибка: ${err.message}`, 'error');
  } finally {
    qaInput.disabled = false;
    btnQaSend.disabled = false;
    qaSpinner.classList.add('hidden');
    qaInput.value = '';
  }
}

// ─── День 9: Автозаполнение МИС ─────────────────────────────
btnFillMIS.addEventListener('click', async () => {
  if (!state.medCard || Object.keys(state.medCard).length === 0) {
    showToast('Сначала сгенерируйте медкарту', 'error');
    return;
  }

  btnFillMIS.disabled = true;
  btnFillMIS.textContent = '⏳ Заполняю...';
  showToast('Инъектирую скрипт в МИС...', 'info', 3000);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FILL_FORM',
      payload: { medCard: state.medCard },
    });

    if (response?.success && response.data?.data) {
      const { filled, total } = response.data.data;
      showToast(`✅ Заполнено ${filled}/${total} полей МИС`, 'success', 5000);
    } else if (response?.success && response.data) {
      const { filled, total } = response.data;
      showToast(`✅ Заполнено ${filled}/${total} полей МИС`, 'success', 5000);
    } else {
      showToast(`Ошибка: ${response?.error || 'Неизвестная ошибка'}`, 'error', 5000);
    }
  } catch (err) {
    showToast(`Ошибка МИС: ${err.message}`, 'error', 5000);
  } finally {
    btnFillMIS.disabled = false;
    btnFillMIS.innerHTML = '🏥 Заполнить МИС';
  }
});

// ─── День 11: Экспорт PDF ────────────────────────────────────
btnExportPDF.addEventListener('click', () => exportMedCardPDF());

btnNewSession.addEventListener('click', () => {
  if (state.isRecording) { showToast('Сначала остановите запись', 'error'); return; }
  if (!confirm('Начать новый приём? Данные текущей сессии будут сброшены.')) return;
  resetSession();
});

// ─── Keyboard shortcuts ──────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+M — начать/остановить запись
  if (e.ctrlKey && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    state.isRecording ? btnStop.click() : btnStart.click();
  }
  // Ctrl+Shift+G — сгенерировать медкарту
  if (e.ctrlKey && e.shiftKey && e.key === 'G') {
    e.preventDefault();
    btnGenerate.click();
  }
  // Ctrl+Shift+P — скачать PDF
  if (e.ctrlKey && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    exportMedCardPDF();
  }
  // Ctrl+Shift+Q — открыть/закрыть Q&A
  if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
    e.preventDefault();
    btnAskQuestion.click();
  }
});

// ─── Авто-сохранение каждые 30 сек ──────────────────────────
setInterval(() => {
  // БАГ #5: без currentSessionId snapshot нельзя восстановить — не сохраняем
  if ((!state.fullTranscript && !state.medCard) || !state.currentSessionId) return;

  const snapshot = {
    sessionId: state.currentSessionId,
    transcription: state.fullTranscript,
    wordTimestamps: state.wordTimestamps,
    medCard: state.medCard,
    doctorName: doctorName.value,
    patientName: patientName.value,
    specialty: state.settings.specialty,
    timestamp: Date.now(),
  };

  chrome.storage.local.set({ currentSession: snapshot });
}, 30000);

// ─── Сброс сессии ────────────────────────────────────────────
function resetSession() {
  state.fullTranscript = '';
  state.interimText = '';
  state.wordTimestamps = [];
  state.medCard = null;
  state.currentSessionId = null;
  state.voiceCommands = [];

  if (state.currentAudioUrl) {
    URL.revokeObjectURL(state.currentAudioUrl);
    state.currentAudioUrl = null;
  }

  transcriptionArea.value = '';
  patientName.value = '';
  recordingTimer.textContent = '00:00:00';
  medCardBlock.classList.add('hidden');
  blockQA.classList.add('hidden');
  medCardSections.innerHTML = '';
  btnStop.classList.add('hidden');
  btnStop.classList.remove('recording');
  btnStart.classList.remove('hidden');
  recordingTimer.classList.remove('recording');
  stopTimer();
  chrome.storage.local.remove(['currentSession']);
  updateStatus('Готов к записи приёма');
  showToast('Готово к новому приёму 🩺', 'success');
}

// ════════════════════════════════════════════════════════════
// ДЕНЬ 4: GROQ API — ГЕНЕРАЦИЯ МЕДКАРТЫ
// ════════════════════════════════════════════════════════════

// Секции медкарты: ключ → { эмодзи, заголовок }
const MED_SECTIONS = {
  жалобы: { icon: '🔴', title: 'ЖАЛОБЫ' },
  анамнез: { icon: '📋', title: 'АНАМНЕЗ' },
  объективно: { icon: '🔬', title: 'ОБЪЕКТИВНО' },
  диагноз: { icon: '✅', title: 'ДИАГНОЗ (МКБ-10)' },
  назначения: { icon: '💊', title: 'НАЗНАЧЕНИЯ' },
  рекомендации: { icon: '📝', title: 'РЕКОМЕНДАЦИИ' },
  следующий_прием: { icon: '📅', title: 'СЛЕДУЮЩИЙ ПРИЁМ' },
};

// Названия специальностей для промпта
const SPECIALTY_NAMES = {
  therapist: 'Терапевт',
  pediatrician: 'Педиатр',
  cardiologist: 'Кардиолог',
  surgeon: 'Хирург',
  ent: 'ЛОР',
  neurologist: 'Невролог',
};

/**
 * Отправляет сообщение в background.js для вызова Groq API.
 * Ждёт ответ и возвращает строку.
 */
function callGroq(messages, responseFormat = 'json') {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'GROQ_REQUEST',
      payload: {
        apiKey: state.apiKeys.groq,
        messages,
        temperature: 0.3,
        responseFormat,
      },
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.success) resolve(response.data);
      else reject(new Error(response?.error || 'Groq API ошибка'));
    });
  });
}

/**
 * Основная функция генерации медкарты.
 * 1. Проверяет транскрипцию и API ключ
 * 2. Формирует системный и user промпты
 * 3. Вызывает Groq через background.js
 * 4. Парсит JSON с fallback
 * 5. Рендерит карточки
 */
async function generateMedCard() {
  // Edge-case: пустая транскрипция
  if (!state.fullTranscript || !state.fullTranscript.trim()) {
    showToast('Сначала запишите приём 🎤', 'error');
    return;
  }

  // Edge-case: слишком короткая транскрипция
  if (state.fullTranscript.trim().length < 30) {
    showToast('Транскрипция слишком короткая. Запишите больше данных.', 'error');
    return;
  }

  // Edge-case: нет API ключа
  if (!state.apiKeys.groq) {
    showToast('Введите Groq API Key в настройках ⚙️', 'error', 5000);
    chrome.runtime.openOptionsPage();
    return;
  }

  // Edge-case: нет интернета
  if (!navigator.onLine) {
    showToast('Нет подключения к интернету 📡', 'error', 5000);
    return;
  }

  // Предупреждение: генерация во время записи
  if (state.isRecording) {
    showToast('⚠️ Запись ещё идёт. Генерирую по текущей транскрипции...', 'info', 3000);
  }

  // Показываем спиннер
  btnGenerate.disabled = true;
  generateSpinner.classList.remove('hidden');
  showToast('Генерирую медкарту...', 'info', 8000);

  const specialty = SPECIALTY_NAMES[state.settings.specialty] || 'Терапевт';
  const customInstructions = state.settings.customInstructions || '';

  // ── Системный промпт ───────────────────────────────────────
  const systemPrompt = `Ты — опытный врач-ассистент (специальность: ${specialty}) в системе здравоохранения Казахстана.

${customInstructions ? `ПЕРСОНАЛЬНЫЕ ИНСТРУКЦИИ ВРАЧА (АБСОЛЮТНЫЙ ПРИОРИТЕТ):\n${customInstructions}\n` : ''}
${state.voiceCommands.length > 0 ? `ГОЛОСОВЫЕ КОМАНДЫ ВРАЧА (ПРИОРИТЕТ ВЫШЕ ИНСТРУКЦИЙ):\n${state.voiceCommands.map(c => `- ${c}`).join('\n')}\n` : ''}
ПРАВИЛА:
1. Извлекай информацию ТОЛЬКО из транскрипции. НИКОГДА не придумывай данные.
2. Если данных для секции нет — напиши точно: "Не указано в ходе приёма".
3. Для каждой секции укажи ТОЧНУЮ цитату из транскрипции (поле "цитата") — дословно.
4. Диагноз: обязательно укажи код МКБ-10.
5. Назначения: дозировка + схема приёма + длительность.
6. Язык: русский. Медицинские термины — по стандарту РК.
7. Верни ТОЛЬКО JSON, без пояснений и markdown.`;

  // ── User промпт ────────────────────────────────────────────
  const userPrompt = `ТРАНСКРИПЦИЯ ПРИЁМА:\n${state.fullTranscript}\n\nВерни строго JSON:\n{\n  "жалобы":          { "текст": "...", "цитата": "точные слова из транскрипции" },\n  "анамнез":         { "текст": "...", "цитата": "..." },\n  "объективно":      { "текст": "...", "цитата": "..." },\n  "диагноз":         { "текст": "...", "мкб10": "код", "цитата": "..." },\n  "назначения":      { "текст": "...", "цитата": "..." },\n  "рекомендации":    { "текст": "...", "цитата": "..." },\n  "следующий_прием": { "текст": "...", "цитата": "..." }\n}`;

  try {
    const raw = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 'json');

    // Парсим JSON с fallback
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Ищем JSON в тексте если модель добавила лишний текст
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch { throw new Error('Groq вернул невалидный JSON'); }
      } else {
        throw new Error('Groq вернул невалидный JSON');
      }
    }

    state.medCard = parsed;

    // Рендерим карточки
    renderMedCard(parsed);
    showToast('Медкарта готова! 🩺', 'success');

  } catch (err) {
    console.error('[Groq] Ошибка:', err);
    showToast(`Ошибка генерации: ${err.message}`, 'error', 6000);
  } finally {
    btnGenerate.disabled = false;
    generateSpinner.classList.add('hidden');
  }
}

/**
 * Рендерит карточки медкарты из JSON в DOM.
 */
function renderMedCard(medCard) {
  medCardSections.innerHTML = '';

  // ── Заголовок блока медкарты ─────────────────────────────────────
  const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const specialtyName = SPECIALTY_NAMES[state.settings.specialty] || 'Терапевт';
  const header = document.createElement('div');
  header.className = 'medcard-header';
  header.innerHTML = `
    <span class="medcard-title">🩺 Медицинская карта</span>
    <span class="medcard-meta">${specialtyName} • ${now}</span>
  `;
  medCardSections.appendChild(header);

  let hasAnySection = false;

  Object.entries(MED_SECTIONS).forEach(([key, { icon, title }]) => {
    const section = medCard[key];
    if (!section) return;
    hasAnySection = true;

    const text = section.текст || 'Не указано в ходе приёма';
    const цитата = section.цитата || '';
    const мкб10 = section.мкб10 || '';
    const displayText = мкб10 ? `${text}\nМКБ-10: ${мкб10}` : text;
    const isEmpty = text === 'Не указано в ходе приёма';

    const ts = цитата ? findAudioTimestamp(цитата) : null;
    const scoreLabel = ts?.score === 3 ? '' : (ts?.score === 2 ? ' ~' : ' ≈');
    const evidenceLabel = ts
      ? `▶ ${formatTime(ts.startSec)}${scoreLabel} — «${цитата.slice(0, 38)}${цитата.length > 38 ? '...' : ''}»`
      : '';
    const playLabel = ts
      ? `${formatTime(ts.startSec)} — ${formatTime(ts.endSec)}`
      : '';

    const card = document.createElement('div');
    card.className = 'med-section';
    card.id = `section-${key}`;
    card.innerHTML = `
      <div class="med-section-header">
        <span class="med-section-title">${icon} ${title}</span>
        <div class="med-section-actions">
          <button class="btn btn-ghost" id="copy-${key}" title="Копировать">📋</button>
          <button class="btn btn-ghost" id="edit-${key}" title="Magic Edit">✏️</button>
          ${ts ? `<button class="btn btn-ghost evidence-play-btn" id="play-${key}" title="Linked Evidence: ${playLabel}">▶ ${formatTime(ts.startSec)}</button>` : ''}
        </div>
      </div>
      <div class="med-section-text${isEmpty ? ' empty' : ''}" id="text-${key}">${displayText}</div>
      ${ts ? `<button class="btn-evidence" id="evidence-${key}">${evidenceLabel}</button>` : ''}
      <div class="magic-edit-form" id="editForm-${key}">
        <input class="magic-edit-input" id="editInput-${key}" type="text" placeholder="Как уточнить? Например: добавь температуру 38.5">
        <div class="btn-row">
          <button class="btn btn-primary" id="editSubmit-${key}">✅ Применить</button>
          <button class="btn btn-secondary" id="editCancel-${key}">Отмена</button>
        </div>
      </div>
    `;

    medCardSections.appendChild(card);

    // Навешиваем обработчики
    document.getElementById(`copy-${key}`).addEventListener('click', () => {
      navigator.clipboard.writeText(displayText).then(() => showToast('Скопировано', 'success', 1500));
    });

    const editForm = document.getElementById(`editForm-${key}`);
    const editInput = document.getElementById(`editInput-${key}`);
    document.getElementById(`edit-${key}`).addEventListener('click', () => {
      editForm.classList.toggle('visible');
      if (editForm.classList.contains('visible')) editInput.focus();
    });
    document.getElementById(`editCancel-${key}`).addEventListener('click', () => {
      editForm.classList.remove('visible');
      editInput.value = '';
    });
    document.getElementById(`editSubmit-${key}`).addEventListener('click', () =>
      applyMagicEdit(key, editInput.value, displayText)
    );
    editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        applyMagicEdit(key, editInput.value, displayText);
      }
      if (e.key === 'Escape') {
        editForm.classList.remove('visible');
        editInput.value = '';
      }
    });

    // Счётчик символов + показ подсказки
    const hintEl = document.createElement('div');
    hintEl.className = 'magic-edit-hint';
    hintEl.innerHTML = '<span id="charCount-' + key + '">0 симв.</span> • Enter = применить • Esc = отмена';
    document.getElementById(`editForm-${key}`).appendChild(hintEl);
    editInput.addEventListener('input', () => {
      const cc = document.getElementById(`charCount-${key}`);
      if (cc) cc.textContent = `${editInput.value.length} симв.`;
    });

    if (ts) {
      const evLabel = `${MED_SECTIONS[key].title}: ${цитата.slice(0, 50)}${цитата.length > 50 ? '...' : ''}`;
      [document.getElementById(`play-${key}`), document.getElementById(`evidence-${key}`)]
        .forEach(btn => btn?.addEventListener('click', () =>
          playEvidence(ts.startSec, ts.endSec, key, evLabel)
        ));
    }
  });

  // Пустая медкарта (JSON пустой)
  if (!hasAnySection) {
    const empty = document.createElement('div');
    empty.className = 'medcard-empty';
    empty.innerHTML = `<span class="medcard-empty-icon">🤷</span><div class="medcard-empty-text">Медкарта пуста. Попробуйте сгенерировать ещё раз.</div>`;
    medCardSections.appendChild(empty);
  }

  // Показываем блок медкарты
  medCardBlock.classList.remove('hidden');
  medCardBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateStatus(`Медкарта сгенерирована — ${Object.keys(MED_SECTIONS).length} секций`);
}

/**
 * ── ДЕНЬ 8: MAGIC EDIT ─────────────────────────────────────────────
 * Undo стек: { [sectionKey]: [prevText, prevText, ...] }
 */
const magicEditHistory = {};

/**
 * applyMagicEdit() — уточняет секцию медкарты через Groq.
 * @param {string} key          — ключ секции (напр. "жалобы")
 * @param {string} instruction  — инструкция врача
 * @param {string} currentText  — текущий текст секции
 */
async function applyMagicEdit(key, instruction, currentText) {
  if (!instruction.trim()) {
    showToast('Введите инструкцию для уточнения', 'error');
    return;
  }

  const editForm = document.getElementById(`editForm-${key}`);
  const editInput = document.getElementById(`editInput-${key}`);
  const textEl = document.getElementById(`text-${key}`);
  const submitBtn = document.getElementById(`editSubmit-${key}`);
  const cardEl = document.getElementById(`section-${key}`);

  // ─ Сохраняем в Undo стек ─────────────────────────────────
  if (!magicEditHistory[key]) magicEditHistory[key] = [];
  magicEditHistory[key].push(textEl.textContent);
  if (magicEditHistory[key].length > 10) magicEditHistory[key].shift();

  // ─ Loading state ───────────────────────────────────────
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Groq...';
  cardEl?.classList.add('magic-loading');

  try {
    const specialty = SPECIALTY_NAMES[state.settings.specialty] || 'Терапевт';

    const raw = await callGroq([
      {
        role: 'system',
        content: `Ты — помощник врача-${specialty}. Улучши указанный текст медицинской секции согласно инструкции. Верни ТОЛЬКО улучшенный текст, без пояснений и JSON.`,
      },
      {
        role: 'user',
        content: `Текущий текст секции:\n${currentText}\n\nИнструкция врача: ${instruction}\n\nОригинальная транскрипция (для контекста):\n${state.fullTranscript}`,
      },
    ], 'text');

    const newText = raw.trim();

    // ─ Typewriter анимация замены текста ─────────────────────
    await animateTextUpdate(textEl, newText);

    // ─ Обновляем state ───────────────────────────────────
    if (state.medCard?.[key]) state.medCard[key].текст = newText;

    // ─ Закрываем форму, добавляем кнопку Undo ──────────────
    editForm.classList.remove('visible');
    editInput.value = '';
    addUndoButton(key, cardEl);
    showToast('Секция обновлена ✨', 'success');

  } catch (err) {
    // Undo автоматически при ошибке
    magicEditHistory[key]?.pop();
    showToast(`Ошибка Magic Edit: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '✅ Применить';
    cardEl?.classList.remove('magic-loading');
  }
}

/**
 * animateTextUpdate() — плавная замена текста с эффектом тайпрайтера.
 */
function animateTextUpdate(el, newText) {
  return new Promise(resolve => {
    // Фаза 1: скрываем
    el.style.transition = 'opacity 0.15s';
    el.style.opacity = '0';

    setTimeout(() => {
      el.textContent = '';
      el.style.opacity = '1';
      el.classList.add('typewriter-active');

      // Фаза 2: печатаем посимвольно
      let i = 0;
      const speed = Math.max(8, Math.min(30, 2000 / newText.length)); // 8-30ms
      const timer = setInterval(() => {
        el.textContent += newText[i++];
        if (i >= newText.length) {
          clearInterval(timer);
          el.classList.remove('typewriter-active');
          resolve();
        }
      }, speed);
    }, 160);
  });
}

/**
 * addUndoButton() — добавляет кнопку «Отменить» после обновления.
 */
function addUndoButton(key, cardEl) {
  const existingUndo = document.getElementById(`undo-${key}`);
  if (existingUndo) existingUndo.remove();

  const undoBtn = document.createElement('button');
  undoBtn.id = `undo-${key}`;
  undoBtn.className = 'btn-undo';
  undoBtn.textContent = '↩ Отменить изменение';
  cardEl.appendChild(undoBtn);

  undoBtn.addEventListener('click', () => {
    const history = magicEditHistory[key];
    if (!history?.length) return;
    const prevText = history.pop();
    const textEl = document.getElementById(`text-${key}`);
    if (textEl) animateTextUpdate(textEl, prevText);
    if (state.medCard?.[key]) state.medCard[key].текст = prevText;
    if (!history.length) undoBtn.remove();
    showToast('Изменение отменено', 'info', 2000);
  });
}

// ────────────────────────────────────────────────────────────
// ДЕНЬ 11: ЭКСПОРТ PDF
// ────────────────────────────────────────────────────────────

/**
 * exportMedCardPDF() — генерирует PDF медкарты с поддержкой кириллицы.
 */
function exportMedCardPDF() {
  if (!state.medCard || Object.keys(state.medCard).length === 0) {
    showToast('Сначала сгенерируйте медкарту', 'error');
    return;
  }

  // jsPDF доступен через window.jspdf.jsPDF (UMD билд)
  const { jsPDF } = window.jspdf;
  if (!jsPDF) {
    showToast('Ошибка: jsPDF не загружен', 'error');
    return;
  }

  btnExportPDF.disabled = true;
  btnExportPDF.textContent = '⏳ PDF...';

  try {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = doc.internal.pageSize.getWidth();   // 210mm
    const pageH = doc.internal.pageSize.getHeight();  // 297mm
    const marginL = 15;
    const marginR = 15;
    const textW = pageW - marginL - marginR;           // 180mm
    let y = 20;

    // Вспомогательная функция: новая страница если не хватает места
    const checkNewPage = (height) => {
      if (y + height > pageH - 15) {
        doc.addPage();
        y = 15;
      }
    };

    // ─ ШАПКА ────────────────────────────────────────────────────
    doc.setFillColor(37, 99, 235);
    doc.rect(0, 0, pageW, 18, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('MediQaz — Медицинская Карта', pageW / 2, 11, { align: 'center' });
    y = 26;

    // ─ МЕТАДАННЫЕ ─────────────────────────────────────────────
    doc.setTextColor(80, 80, 80);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const doctorVal = doctorName.value || 'Не указан';
    const patientVal = patientName.value || 'Не указан';
    const specialty = SPECIALTY_NAMES[state.settings.specialty] || 'Терапевт';
    const dateStr = new Date().toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });

    doc.text(`Врач: ${doctorVal}  |  Специальность: ${specialty}`, marginL, y);
    y += 5;
    doc.text(`Пациент: ${patientVal}  |  Дата: ${dateStr}`, marginL, y);
    y += 7;

    // Разделитель
    doc.setDrawColor(200, 210, 230);
    doc.setLineWidth(0.3);
    doc.line(marginL, y, pageW - marginR, y);
    y += 6;

    // ─ СЕКЦИИ МЕДКАРТЫ ─────────────────────────────────────
    for (const [key, section] of Object.entries(state.medCard)) {
      const def = MED_SECTIONS[key];
      if (!def) continue;

      const text = section?.текст || section?.text || '';
      if (!text || text === 'Не указано в ходе приёма') continue;

      // Заголовок секции
      checkNewPage(14);
      doc.setFillColor(240, 245, 255);
      doc.roundedRect(marginL - 2, y - 4, textW + 4, 8, 1, 1, 'F');
      doc.setTextColor(37, 99, 235);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(`${def.icon} ${def.title}`, marginL, y + 1);

      // МКБ-10 если есть
      if (section?.мкб10) {
        doc.setTextColor(100, 100, 100);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.text(`[МКБ-10: ${section.мкб_10 || section.мкк10 || section.мкб10}]`,
          pageW - marginR, y + 1, { align: 'right' });
      }

      y += 9;

      // Текст секции (с переносом по словам)
      doc.setTextColor(30, 30, 30);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');

      const lines = doc.splitTextToSize(text, textW);
      for (const line of lines) {
        checkNewPage(5);
        doc.text(line, marginL, y);
        y += 4.5;
      }

      y += 4; // пробел между секциями
    }

    // ─ ФУТЕР ───────────────────────────────────────────────────
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setTextColor(160, 160, 160);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(
        `MediQaz — генерация AI  |  Стр. ${i} из ${pageCount}`,
        pageW / 2, pageH - 7,
        { align: 'center' }
      );
    }

    // ─ СКАЧИВАЕМ ──────────────────────────────────────────────
    const dateFile = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
    const patientSlug = (patientName.value || 'пациент').replace(/\s+/g, '_').slice(0, 20);
    const filename = `mediqaz_${patientSlug}_${dateFile}.pdf`;
    doc.save(filename);

    showToast(`PDF сохранён: ${filename}`, 'success', 4000);

  } catch (err) {
    console.error('[PDF] Ошибка:', err);
    showToast(`Ошибка PDF: ${err.message}`, 'error');
  } finally {
    btnExportPDF.disabled = false;
    btnExportPDF.textContent = '📥 PDF';
  }
}

// Слушаем уведомление от background.js об очереди
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'GROQ_QUEUED') {
    showToast('⏳ Подождите, обработка предыдущего запроса...', 'info', 3000);
  }
});

// ════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ════════════════════════════════════════════════════════════

async function init() {
  await loadSettings();

  // Восстановление незавершённой сессии
  const saved = await chrome.storage.local.get(['currentSession']);
  if (saved.currentSession?.transcription) {
    const restore = confirm('Найдена незавершённая транскрипция. Восстановить?');
    if (restore) {
      state.fullTranscript = saved.currentSession.transcription;
      state.wordTimestamps = saved.currentSession.wordTimestamps || [];
      state.currentSessionId = saved.currentSession.sessionId || null;
      updateTranscriptionUI();

      // Восстанавливаем имена
      if (saved.currentSession.doctorName) doctorName.value = saved.currentSession.doctorName;
      if (saved.currentSession.patientName) patientName.value = saved.currentSession.patientName;

      // Восстанавливаем медкарту если есть
      if (saved.currentSession.medCard) {
        state.medCard = saved.currentSession.medCard;
        renderMedCard(state.medCard);
        showToast('Медкарта восстановлена из авто-сохранения 🩺', 'success', 4000);
      } else {
        showToast('Транскрипция восстановлена 📋', 'info');
      }
    } else {
      chrome.storage.local.remove(['currentSession']);
    }
  }

  console.log('[MediQaz] Панель готова ✅ (День 11: PDF + Шорткаты + Авто-сохранение)');
}

init();
