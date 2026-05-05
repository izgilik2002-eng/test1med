// ============================================================
// content.js — MediQaz Автозаполнитель форм МИС v1.0
// Инжектируется динамически через background.js
// ============================================================

// ─── Защита от повторной инжекции ───────────────────────────
if (window.__mediqazContentLoaded) {
  // Уже загружен
} else {
  window.__mediqazContentLoaded = true;

// ─── Секции медкарты → русские названия полей ───────────────
const SECTION_LABELS = {
  'жалобы':          ['жалобы', 'complaints', 'complaint', 'жалоба'],
  'анамнез':         ['анамнез', 'anamnesis', 'history', 'анамнез заболевания', 'анамнез жизни', 'epid_anamnez'],
  'объективно':      ['объективно', 'objective', 'осмотр', 'status', 'физикальный', 'объективный статус', 'status praesens'],
  'диагноз':         ['диагноз', 'diagnosis', 'ds', 'заключение', 'основной диагноз', 'клинический диагноз'],
  'назначения':      ['назначения', 'treatment', 'лечение', 'терапия', 'prescription', 'рецепт'],
  'рекомендации':    ['рекомендации', 'recommendations', 'рекомендация', 'план', 'advice'],
  'следующий_прием': ['следующий приём', 'next visit', 'повторный', 'follow up', 'контроль'],
};

// ─── Слушаем сообщения от background.js ─────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_FORM_DATA') {
    fillMISForm(message.medCard)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // асинхронный ответ
  }
});

// ════════════════════════════════════════════════════════════
// СКАНИРОВАНИЕ DOM — сбор видимых полей
// ════════════════════════════════════════════════════════════

/**
 * scanFormFields() — собирает все заполняемые поля на странице.
 * @returns {{ id, tagName, type, name, label, placeholder, ariaLabel, nearbyText, isContentEditable }[]}
 */
function scanFormFields() {
  const fields = [];
  const selectors = [
    'input[type="text"]',
    'input:not([type])',
    'textarea',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    'input[type="search"]',
  ];

  const elements = document.querySelectorAll(selectors.join(', '));

  elements.forEach((el, idx) => {
    // Пропускаем скрытые, disabled, readonly
    if (el.offsetParent === null && !el.closest('[contenteditable]')) return;
    if (el.disabled || el.readOnly) return;
    if (el.type === 'hidden') return;

    // Размер меньше 20px — вероятно не поле формы
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 10) return;

    const fieldInfo = {
      idx,
      tagName: el.tagName.toLowerCase(),
      type:    el.type || '',
      id:      el.id || '',
      name:    el.name || '',
      label:   findLabel(el) || '',
      placeholder: el.placeholder || '',
      ariaLabel:   el.getAttribute('aria-label') || '',
      nearbyText:  getNearbyText(el),
      isContentEditable: el.isContentEditable,
    };

    // Генерируем уникальный CSS-селектор
    fieldInfo.selector = generateSelector(el);

    fields.push(fieldInfo);
  });

  console.log(`[MediQaz] Сканирование DOM: найдено ${fields.length} полей`);
  return fields;
}

/**
 * findLabel() — ищет label для поля по for, aria-labelledby, или parent label.
 */
function findLabel(el) {
  // 1. Ищем <label for="...">
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.textContent.trim().slice(0, 100);
  }

  // 2. aria-labelledby
  const ariaBy = el.getAttribute('aria-labelledby');
  if (ariaBy) {
    const labelEl = document.getElementById(ariaBy);
    if (labelEl) return labelEl.textContent.trim().slice(0, 100);
  }

  // 3. Родительский <label>
  const parentLabel = el.closest('label');
  if (parentLabel) return parentLabel.textContent.trim().slice(0, 100);

  return '';
}

/**
 * getNearbyText() — берёт текст ближайших элементов (label, span, div до 200px).
 */
function getNearbyText(el) {
  const texts = [];

  // Предыдущий sibling
  let prev = el.previousElementSibling;
  if (prev) texts.push(prev.textContent.trim().slice(0, 80));

  // Родитель
  const parent = el.parentElement;
  if (parent) {
    // Все text nodes внутри родителя
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.trim();
        if (t) texts.push(t.slice(0, 80));
      }
    }
  }

  return texts.filter(Boolean).join(' | ').slice(0, 200);
}

/**
 * generateSelector() — создаёт уникальный CSS-селектор для элемента.
 */
function generateSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;

  // Если нет id/name — строим путь
  const path = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      path.unshift(selector);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(' > ');
}

// ════════════════════════════════════════════════════════════
// AI МАППИНГ — Groq определяет какое поле = какая секция
// ════════════════════════════════════════════════════════════

/**
 * getFieldMapping() — запрашивает у Groq AI маппинг полей к секциям медкарты.
 * С кэшированием (30 дней по hostname).
 */
async function getFieldMapping(fields, medCardKeys) {
  const hostname = window.location.hostname;
  const cacheKey = `domMapping_${hostname}`;

  // Проверяем кэш
  try {
    const cached = await chrome.storage.local.get([cacheKey]);
    if (cached[cacheKey]) {
      const { mapping, timestamp } = cached[cacheKey];
      const daysSince = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
      if (daysSince < 30 && mapping) {
        console.log(`[MediQaz] Используем кэшированный маппинг для ${hostname} (${daysSince.toFixed(1)} дней)`);
        return mapping;
      }
    }
  } catch (e) {
    console.warn('[MediQaz] Ошибка чтения кэша:', e);
  }

  // Готовим описание полей для AI
  const fieldDescriptions = fields.map((f, i) =>
    `[${i}] ${f.tagName}${f.type ? `[${f.type}]` : ''} | id="${f.id}" | name="${f.name}" | label="${f.label}" | placeholder="${f.placeholder}" | nearby="${f.nearbyText}"`
  ).join('\n');

  const medSections = medCardKeys.join(', ');

  // Запрос к Groq через background.js
  const response = await chrome.runtime.sendMessage({
    type: 'GROQ_REQUEST',
    payload: {
      apiKey: null, // background.js возьмёт из storage
      messages: [
        {
          role: 'system',
          content: `Ты — AI, который маппит HTML-поля формы медицинской информационной системы (МИС) к секциям медкарты.
Тебе дан список полей и список секций. Определи, какое поле соответствует какой секции.
Верни ТОЛЬКО JSON объект вида: { "0": "жалобы", "3": "диагноз", ... }
Где ключ — индекс поля, значение — название секции.
Если поле не соответствует ни одной секции — пропусти его.
НЕ ПРИДУМЫВАЙ маппинги если не уверен. Лучше пропустить чем ошибиться.`,
        },
        {
          role: 'user',
          content: `Секции медкарты: ${medSections}\n\nПоля формы:\n${fieldDescriptions}`,
        },
      ],
      temperature: 0.1,
      responseFormat: 'json',
    },
  });

  if (!response.success) {
    // Если AI не помогла — пробуем эвристику
    console.warn('[MediQaz] AI маппинг не удался, используем эвристику:', response.error);
    return heuristicMapping(fields, medCardKeys);
  }

  let mapping;
  try {
    mapping = JSON.parse(response.data);
  } catch {
    const match = response.data.match(/\{[\s\S]*\}/);
    if (match) {
      try { mapping = JSON.parse(match[0]); }
      catch { return heuristicMapping(fields, medCardKeys); }
    } else {
      return heuristicMapping(fields, medCardKeys);
    }
  }

  // Сохраняем в кэш
  try {
    await chrome.storage.local.set({
      [cacheKey]: { mapping, timestamp: Date.now() },
    });
    console.log(`[MediQaz] Маппинг сохранён в кэш для ${hostname}`);
  } catch (e) {
    console.warn('[MediQaz] Ошибка сохранения кэша:', e);
  }

  return mapping;
}

/**
 * heuristicMapping() — fallback маппинг по ключевым словам (без AI).
 */
function heuristicMapping(fields, medCardKeys) {
  const mapping = {};

  fields.forEach((field, idx) => {
    const searchText = [
      field.label, field.name, field.id, field.placeholder, field.ariaLabel, field.nearbyText,
    ].join(' ').toLowerCase();

    for (const key of medCardKeys) {
      const keywords = SECTION_LABELS[key] || [key];
      const found = keywords.some(kw => searchText.includes(kw.toLowerCase()));
      if (found) {
        mapping[String(idx)] = key;
        break;
      }
    }
  });

  console.log('[MediQaz] Эвристический маппинг:', mapping);
  return mapping;
}

// ════════════════════════════════════════════════════════════
// ЗАПОЛНЕНИЕ ПОЛЕЙ
// ════════════════════════════════════════════════════════════

/**
 * hasReactInternalProps() — детектирует React-компоненты.
 */
function hasReactInternalProps(el) {
  return Object.keys(el).some(k =>
    k.startsWith('__reactInternalInstance') ||
    k.startsWith('__reactFiber') ||
    k.startsWith('__reactProps')
  );
}

/**
 * setFieldValue() — устанавливает значение поля с учётом React/contentEditable.
 * @returns {boolean} — удалось ли записать значение
 */
function setFieldValue(el, value) {
  try {
    if (el.isContentEditable) {
      // contentEditable — вставляем через innerHTML
      el.focus();
      el.innerHTML = '';
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return true;
    }

    if (hasReactInternalProps(el)) {
      // React-компоненты требуют особого подхода
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Также пробуем React-совместимый event
      const reactEvent = new Event('input', { bubbles: true });
      Object.defineProperty(reactEvent, 'target', { writable: false, value: el });
      el.dispatchEvent(reactEvent);

      return true;
    }

    // Обычные поля
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return true;

  } catch (err) {
    console.error(`[MediQaz] Ошибка заполнения поля:`, err, el);
    return false;
  }
}

/**
 * highlightField() — подсвечивает заполненное поле зелёным на 2 сек.
 */
function highlightField(el) {
  const originalBorder    = el.style.border;
  const originalBoxShadow = el.style.boxShadow;
  const originalTransition = el.style.transition;

  el.style.transition = 'border 0.3s, box-shadow 0.3s';
  el.style.border     = '2px solid #059669';
  el.style.boxShadow  = '0 0 0 3px rgba(5, 150, 105, 0.2)';

  setTimeout(() => {
    el.style.border     = originalBorder;
    el.style.boxShadow  = originalBoxShadow;
    el.style.transition = originalTransition;
  }, 2500);
}

// ════════════════════════════════════════════════════════════
// ОСНОВНАЯ ФУНКЦИЯ ЗАПОЛНЕНИЯ
// ════════════════════════════════════════════════════════════

async function fillMISForm(medCard) {
  showOverlay('⏳ Сканирую поля МИС...', 'info');

  // 1. Сканируем DOM
  const fields = scanFormFields();

  if (fields.length === 0) {
    showOverlay('⚠️ Не найдено полей для заполнения. Откройте форму МИС.', 'error');
    return { filled: 0, total: 0, message: 'Нет полей' };
  }

  // 2. Определяем какие секции есть в медкарте
  const medCardKeys = Object.keys(medCard).filter(k => medCard[k]?.текст);
  if (medCardKeys.length === 0) {
    showOverlay('⚠️ Медкарта пуста. Сначала сгенерируйте медкарту.', 'error');
    return { filled: 0, total: 0, message: 'Пустая медкарта' };
  }

  // 3. Получаем маппинг (AI или эвристика, с кэшем)
  showOverlay('🧠 AI определяет поля формы...', 'info');
  let mapping;
  try {
    mapping = await getFieldMapping(fields, medCardKeys);
  } catch (err) {
    console.error('[MediQaz] Ошибка маппинга:', err);
    showOverlay(`❌ Ошибка маппинга: ${err.message}`, 'error');
    return { filled: 0, total: 0, message: err.message };
  }

  if (!mapping || Object.keys(mapping).length === 0) {
    showOverlay('⚠️ Не удалось определить поля формы. Попробуйте на другой странице МИС.', 'error');
    return { filled: 0, total: 0, message: 'Маппинг пуст' };
  }

  // 4. Заполняем поля
  showOverlay('✍️ Заполняю поля...', 'info');
  let filled = 0;
  let failed = 0;
  const total = Object.keys(mapping).length;

  for (const [fieldIdx, sectionKey] of Object.entries(mapping)) {
    const field = fields[parseInt(fieldIdx)];
    if (!field) continue;

    const section = medCard[sectionKey];
    if (!section?.текст || section.текст === 'Не указано в ходе приёма') continue;

    // Формируем значение
    let value = section.текст;
    if (section.мкб10) value += `\nМКБ-10: ${section.мкб10}`;

    // Находим элемент по селектору
    const el = document.querySelector(field.selector);
    if (!el) {
      console.warn(`[MediQaz] Элемент не найден: ${field.selector}`);
      failed++;
      continue;
    }

    // Задержка между полями (чтобы React успевал обработать)
    await new Promise(r => setTimeout(r, 150));

    const success = setFieldValue(el, value);
    if (success) {
      filled++;
      highlightField(el);
    } else {
      failed++;
    }
  }

  // 5. Показываем результат
  if (filled > 0) {
    showOverlay(`✅ Заполнено ${filled}/${total} полей`, 'success', 6000);
  } else {
    showOverlay(`⚠️ Не удалось заполнить поля (${failed} ошибок)`, 'error', 6000);
  }

  return { filled, total, failed, message: `Заполнено ${filled}/${total}` };
}

// ════════════════════════════════════════════════════════════
// OVERLAY УВЕДОМЛЕНИЕ
// ════════════════════════════════════════════════════════════

function showOverlay(message, type = 'info', duration = 5000) {
  // Удаляем предыдущий overlay если есть
  const existing = document.getElementById('mediqaz-overlay');
  if (existing) existing.remove();

  const colors = {
    info:    '#2563EB',
    success: '#059669',
    error:   '#DC2626',
  };

  const icons = {
    info:    '🩺',
    success: '✅',
    error:   '⚠️',
  };

  // Стили анимации
  if (!document.getElementById('mediqaz-styles')) {
    const style = document.createElement('style');
    style.id = 'mediqaz-styles';
    style.textContent = `
      @keyframes mediqaz-slide-in {
        from { opacity: 0; transform: translateX(40px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes mediqaz-slide-out {
        from { opacity: 1; transform: translateX(0); }
        to   { opacity: 0; transform: translateX(40px); }
      }
      @keyframes mediqaz-progress {
        from { width: 100%; }
        to   { width: 0%; }
      }
    `;
    document.head.appendChild(style);
  }

  const overlay = document.createElement('div');
  overlay.id = 'mediqaz-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 999999;
    background: ${colors[type] || colors.info};
    color: white;
    padding: 14px 18px 18px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 360px;
    min-width: 200px;
    animation: mediqaz-slide-in 0.3s ease;
    cursor: pointer;
    overflow: hidden;
  `;

  overlay.innerHTML = `
    <span style="font-size:18px;flex-shrink:0">${icons[type] || icons.info}</span>
    <span style="flex:1">${message}</span>
    <button id="mediqaz-overlay-close" style="
      background: none; border: none; color: rgba(255,255,255,0.7);
      cursor: pointer; font-size: 14px; padding: 0; margin-left: 4px; flex-shrink:0;
    ">✕</button>
    <div style="
      position: absolute; bottom: 0; left: 0; height: 3px;
      background: rgba(255,255,255,0.4); border-radius: 0 0 12px 12px;
      animation: mediqaz-progress ${duration}ms linear forwards;
    "></div>
  `;

  document.body.appendChild(overlay);

  // Закрытие
  const close = () => {
    overlay.style.animation = 'mediqaz-slide-out 0.25s ease forwards';
    setTimeout(() => overlay.remove(), 250);
  };

  document.getElementById('mediqaz-overlay-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target.id !== 'mediqaz-overlay-close') close();
  });

  setTimeout(close, duration);
}


} // end if (!window.__mediqazContentLoaded)
