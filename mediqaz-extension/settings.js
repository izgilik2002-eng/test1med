// ============================================================
// settings.js — Логика страницы настроек MediQaz
// День 6: Интеграция с idb-keyval для очистки, все опции
// Хранение:
//   API ключи        → chrome.storage.local  (никогда не sync!)
//   Профиль врача    → chrome.storage.sync
//   Кастом инструкции→ chrome.storage.sync
// ============================================================

// Store для IndexedDB через idb-keyval
const idbStore = idbKeyval.createStore('MediQazDB', 'appointments');

// ─── DOM элементы ────────────────────────────────────────────
const inputDeepgramKey        = document.getElementById('inputDeepgramKey');
const inputGroqKey            = document.getElementById('inputGroqKey');
const toggleDeepgramKey       = document.getElementById('toggleDeepgramKey');
const toggleGroqKey           = document.getElementById('toggleGroqKey');
const inputDoctorName         = document.getElementById('inputDoctorName');
const selectSpecialty         = document.getElementById('selectSpecialty');
const selectLanguage          = document.getElementById('selectLanguage');
const inputCustomInstructions = document.getElementById('inputCustomInstructions');
const btnSaveSettings         = document.getElementById('btnSaveSettings');
const btnClearHistory         = document.getElementById('btnClearHistory');
const btnClearDOMCache        = document.getElementById('btnClearDOMCache');
const btnClearAudio           = document.getElementById('btnClearAudio');
const toastContainer          = document.getElementById('toastContainer');

// ─── Toast уведомления ───────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── Toggle видимости пароля ─────────────────────────────────
function setupPasswordToggle(inputEl, toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    const isPassword = inputEl.type === 'password';
    inputEl.type = isPassword ? 'text' : 'password';
    toggleBtn.textContent = isPassword ? '🙈' : '👁';
  });
}
setupPasswordToggle(inputDeepgramKey, toggleDeepgramKey);
setupPasswordToggle(inputGroqKey, toggleGroqKey);

// ─── Загрузка сохранённых настроек ──────────────────────────
async function loadSettings() {
  // API ключи из LOCAL (безопасно, не синхронизируются)
  const localData = await new Promise(resolve =>
    chrome.storage.local.get(['deepgramKey', 'groqKey'], resolve)
  );
  if (localData.deepgramKey) inputDeepgramKey.value = localData.deepgramKey;
  if (localData.groqKey)     inputGroqKey.value     = localData.groqKey;

  // Профиль и инструкции из SYNC
  const syncData = await new Promise(resolve =>
    chrome.storage.sync.get(
      ['doctorName', 'specialty', 'language', 'customInstructions'],
      resolve
    )
  );
  if (syncData.doctorName)         inputDoctorName.value         = syncData.doctorName;
  if (syncData.specialty)          selectSpecialty.value         = syncData.specialty;
  if (syncData.language)           selectLanguage.value          = syncData.language;
  if (syncData.customInstructions) inputCustomInstructions.value = syncData.customInstructions;
}

// ─── Сохранение всех настроек ────────────────────────────────
btnSaveSettings.addEventListener('click', async () => {
  const deepgramKey        = inputDeepgramKey.value.trim();
  const groqKey            = inputGroqKey.value.trim();
  const doctorName         = inputDoctorName.value.trim();
  const specialty          = selectSpecialty.value;
  const language           = selectLanguage.value;
  const customInstructions = inputCustomInstructions.value.trim();

  // Валидация: проверяем что ключи не пустые
  if (!deepgramKey) {
    showToast('Введите Deepgram API Key', 'error');
    inputDeepgramKey.focus();
    return;
  }
  if (!groqKey) {
    showToast('Введите Groq API Key', 'error');
    inputGroqKey.focus();
    return;
  }

  try {
    // API ключи → chrome.storage.local (ТОЛЬКО local, никогда sync!)
    await new Promise((resolve, reject) =>
      chrome.storage.local.set({ deepgramKey, groqKey }, () =>
        chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      )
    );

    // Профиль → chrome.storage.sync
    await new Promise((resolve, reject) =>
      chrome.storage.sync.set(
        { doctorName, specialty, language, customInstructions },
        () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      )
    );

    showToast('Настройки сохранены!', 'success');
  } catch (err) {
    showToast(`Ошибка сохранения: ${err.message}`, 'error');
  }
});

// ─── Очистка истории приёмов (текст) ────────────────────────
btnClearHistory.addEventListener('click', () => {
  if (!confirm('Очистить историю приёмов? Тексты медкарт будут удалены.')) return;
  chrome.storage.local.remove(['appointmentHistory'], () => {
    showToast('История приёмов очищена', 'success');
  });
});

// ─── Сброс кэша DOM-маппинга МИС ────────────────────────────
// БАГ #6: кэш хранится как domMapping_${hostname}, а не domMappingCache
btnClearDOMCache.addEventListener('click', () => {
  if (!confirm('Сбросить кэш автозаполнения? При следующем заполнении ИИ заново просканирует форму МИС.')) return;
  chrome.storage.local.get(null, (allData) => {
    const keysToRemove = Object.keys(allData).filter(k => k.startsWith('domMapping_'));
    if (keysToRemove.length === 0) {
      showToast('Кэш уже пуст', 'info');
      return;
    }
    chrome.storage.local.remove(keysToRemove, () => {
      showToast(`Кэш автозаполнения сброшен (${keysToRemove.length} записей)`, 'success');
    });
  });
});

// ─── Очистка аудиозаписей из IndexedDB ──────────────────────
btnClearAudio.addEventListener('click', async () => {
  if (!confirm('Удалить все аудиозаписи приёмов? Linked Evidence перестанет работать для прошлых приёмов.')) return;

  try {
    await idbKeyval.clear(idbStore);
    showToast('Аудиозаписи удалены', 'success');
  } catch (err) {
    showToast(`Ошибка удаления: ${err.message}`, 'error');
  }
});

// ─── Инициализация ───────────────────────────────────────────
loadSettings().then(() => {
  console.log('[MediQaz Settings] Настройки загружены ✅ (День 6)');
});
