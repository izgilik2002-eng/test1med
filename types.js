// types.js — JSDoc-типы для WS-сообщений и общих структур MediQaz
// Позволяет VS Code показывать автокомплит и ловить несоответствия типов.
// Использование: в любом файле добавь /** @typedef {import('./types').FormType} FormType */

/**
 * Допустимые типы форм Дамумед.
 * @typedef {'052'|'035'|'130'} FormType
 */

// ============ Сообщения клиент → сервер ============

/**
 * Клиент начинает запись приёма.
 * @typedef {object} StartMessage
 * @property {'start'} type
 * @property {StartPayload} payload
 */

/**
 * Параметры начала приёма.
 * @typedef {object} StartPayload
 * @property {string} doctorName — ФИО врача
 * @property {string} patientName — ФИО пациента
 * @property {FormType} formType — тип формы Дамумед
 * @property {string} [format] — формат аудио (по умолчанию 'webm')
 */

/**
 * Клиент останавливает запись и отправляет финальные данные из UI-полей.
 * @typedef {object} StopMessage
 * @property {'stop'} type
 * @property {Record<string, string>} [manualOverrides] — финальные значения полей формы
 */

// ============ Сообщения сервер → клиент ============

/**
 * Обновление транскрипции в реальном времени.
 * @typedef {object} TranscriptionUpdate
 * @property {'transcription_update'} type
 * @property {string} text — текущий текст транскрипции
 */

/**
 * Обновление полей формы (JSON от LLM).
 * @typedef {object} FormUpdate
 * @property {'form_update'} type
 * @property {Record<string, string>} formJson — заполненные поля формы
 */

/**
 * Статус обработки (спиннер на фронте).
 * @typedef {object} ProcessingMessage
 * @property {'processing'} type
 * @property {string} message — текст для отображения пользователю
 */

/**
 * Успешное сохранение приёма.
 * @typedef {object} SuccessMessage
 * @property {'success'} type
 * @property {number} appointmentId — ID записи в БД
 */

/**
 * Ошибка.
 * @typedef {object} ErrorMessage
 * @property {'error'} type
 * @property {string} message — текст ошибки
 */

/**
 * Любое WS-сообщение от клиента.
 * @typedef {StartMessage | StopMessage} ClientMessage
 */

/**
 * Любое WS-сообщение от сервера.
 * @typedef {TranscriptionUpdate | FormUpdate | ProcessingMessage | SuccessMessage | ErrorMessage} ServerMessage
 */

module.exports = {};
