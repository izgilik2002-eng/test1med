// session.js — класс сессии записи приёма через WebSocket
/** @typedef {import('./types').FormType} FormType */
/** @typedef {import('./types').ClientMessage} ClientMessage */
/** @typedef {import('./types').StartPayload} StartPayload */
/** @typedef {import('./types').ServerMessage} ServerMessage */

const WebSocket = require('ws');
const Groq = require('groq-sdk');
const db = require('./database');
const { SYSTEM_PROMPTS } = require('./prompts');
const { DeepgramClient } = require('@deepgram/sdk');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });
const MAX_BINARY_MSG_BYTES = 2 * 1024 * 1024;

class Session {
    constructor(ws, userId) {
        this.ws = ws;
        this.userId = userId;
        this.sessionData = {};
        
        // Транскрипция
        this.fullText = '';
        this.lastProcessedTextLength = 0;
        
        // Тайминг LLM
        this.isProcessingGroq = false;
        this.llmDebounceTimer = null;
        
        // Deepgram Live
        this.dgConnection = null;
        this.isDgReady = false;
    }

    /**
     * Главный роутер сообщений — вызывается из ws.on('message')
     * @param {Buffer|string} message — бинарное аудио или JSON-строка
     * @param {boolean} isBinary
     */
    handleMessage(message, isBinary) {
        if (isBinary) {
            if (message.length > MAX_BINARY_MSG_BYTES) return;
            // Стриминг: мгновенно пересылаем аудио-чанк в Deepgram
            if (this.isDgReady && this.dgConnection) {
                this.dgConnection.socket.send(message);
            }
            return;
        }

        let data;
        try { data = JSON.parse(message.toString()); } catch { return; }

        if (data.type === 'start') this.handleStart(data.payload);
        else if (data.type === 'stop') this.handleStop(data.manualOverrides);
    }

    /**
     * Обработка начала приёма
     * @param {StartPayload} payload
     */
    async handleStart(payload) {
        this.sessionData = payload || {};
        this.sessionData.formType = this.sessionData.formType || '052';
        this.fullText = '';
        this.lastProcessedTextLength = 0;
        console.log(`Начат приём. Форма: ${this.sessionData.formType}`);

        this.initDeepgramLive();
    }

    /**
     * Инициализация WebSocket стрима к Deepgram
     */
    async initDeepgramLive() {
        if (this.dgConnection) {
            try { this.dgConnection.socket.close(); } catch (e) {}
        }
        
        this.isDgReady = false;

        try {
            console.log('Подключение к Deepgram Live API...');
            this.dgConnection = await deepgram.listen.v1.connect({
                model: 'nova-2',
                language: 'ru', // detect_language is not supported with streaming on some models, explicit 'ru' is safer
                punctuate: true,
                smart_format: true,
                interim_results: true,
                diarize: true,
                utterance_end_ms: 3000 // Deepgram will send UtteranceEnd if pause is > 3s
            });

            this.dgConnection.on('open', () => {
                console.log('✅ Соединение с Deepgram Live установлено');
                this.isDgReady = true;
            });

            this.dgConnection.on('message', (data) => {
                if (data.type === 'Results') {
                    const isFinal = data.is_final;
                    const words = data.channel?.alternatives?.[0]?.words || [];
                    const transcript = data.channel?.alternatives?.[0]?.transcript || '';

                    if (transcript.trim() && isFinal) {
                        // Форматируем диаризацию
                        let formatted = '';
                        let currentSpeaker = -1;
                        for (const word of words) {
                            if (word.speaker !== currentSpeaker && word.speaker !== undefined) {
                                currentSpeaker = word.speaker;
                                if (formatted || this.fullText) formatted += '\n';
                                const role = currentSpeaker === 0 ? 'Врач' : (currentSpeaker === 1 ? 'Пациент' : `Спикер ${currentSpeaker}`);
                                formatted += `${role}: `;
                            }
                            formatted += (word.punctuated_word || word.word) + ' ';
                        }

                        this.fullText += (formatted ? formatted : transcript) + ' ';
                        
                        // Мгновенно отправляем транскрипт на фронтенд
                        this.send({ type: 'transcription_update', text: this.fullText.trim() });
                        
                        // Сбрасываем дебаунс таймер
                        if (this.llmDebounceTimer) clearTimeout(this.llmDebounceTimer);
                        this.llmDebounceTimer = setTimeout(() => this.triggerLLM(), 4000); // Страховочный таймер, если UtteranceEnd не придёт
                    }
                } else if (data.type === 'UtteranceEnd') {
                    console.log('Deepgram detect: UtteranceEnd (пауза в речи)');
                    if (this.llmDebounceTimer) clearTimeout(this.llmDebounceTimer);
                    this.triggerLLM();
                } else if (data.type === 'Metadata') {
                    // console.log('Deepgram Metadata');
                } else {
                    // console.log('Deepgram Event:', data.type);
                }
            });

            this.dgConnection.on('close', () => {
                console.log('Deepgram Live соединение закрыто');
                this.isDgReady = false;
            });

            this.dgConnection.on('error', (err) => {
                console.error('Ошибка Deepgram Live:', err);
            });
            
            // Запускаем подключение
            this.dgConnection.connect();

        } catch (err) {
            console.error('Ошибка инициализации Deepgram:', err);
        }
    }

    /**
     * Обработка остановки приёма — финальное сохранение в БД
     * @param {Record<string, string>} [manualOverrides]
     */
    async handleStop(manualOverrides) {
        console.log('Остановка приёма. Закрываем стрим Deepgram...');
        if (this.llmDebounceTimer) clearTimeout(this.llmDebounceTimer);
        
        // Закрываем стрим
        if (this.dgConnection && this.isDgReady) {
            // В v5 можно отправить пустое бинарное сообщение или close
            try { this.dgConnection.socket.send(Buffer.alloc(0)); } catch (e) {}
            setTimeout(() => { try { this.dgConnection.socket.close(); } catch(e){} }, 500);
        }

        this.send({ type: 'processing', message: 'Сохраняем данные в БД...' });

        // Если есть неподтвержденный текст, делаем последний вызов LLM
        if (this.fullText.length > this.lastProcessedTextLength) {
            console.log('Финальный вызов LLM перед сохранением...');
            await this.triggerLLM(true);
        }

        // Ждем, пока LLM отработает (если она в процессе)
        let waits = 0;
        while (this.isProcessingGroq && waits < 10) {
            await new Promise(r => setTimeout(r, 1000));
            waits++;
        }

        // manualOverrides содержат финальные данные из полей,
        // которые мог отредактировать Врач перед кнопкой "Завершить"
        const finalFormJson = manualOverrides || {};

        try {
            const appointmentId = db.saveAppointment({
                user_id: this.userId,
                patient_name: this.sessionData.patientName,
                doctor_name: this.sessionData.doctorName,
                date: new Date().toISOString(),
                transcription: this.fullText,
                med_card: JSON.stringify(finalFormJson),
                form_type: this.sessionData.formType
            });

            this.send({ type: 'success', appointmentId });
        } catch (err) {
            console.error('Ошибка БД:', err);
            this.send({ type: 'error', message: 'Ошибка БД' });
        }
    }

    /**
     * Умный тайминг: вызываем Groq LLM только когда есть новый текст
     * @param {boolean} isFinalCall
     */
    async triggerLLM(isFinalCall = false) {
        if (this.isProcessingGroq) {
            if (!isFinalCall) return;
        }
        
        // Если текст не добавился, не дергаем LLM
        if (this.fullText.length <= this.lastProcessedTextLength + 10) {
            return;
        }

        this.isProcessingGroq = true;
        this.lastProcessedTextLength = this.fullText.length;
        
        console.log(`\n--- LLM Цикл (Символов: ${this.fullText.length}) ---`);
        console.log('➡️  Отправка в Groq (llama-3.3-70b)...');
        
        try {
            let systemPrompt = SYSTEM_PROMPTS[this.sessionData.formType] || SYSTEM_PROMPTS['052'];

            // Загружаем кастомный промпт текущего врача
            const userData = db.getUserById(this.userId);
            if (userData && userData.custom_prompt && userData.custom_prompt.trim()) {
                systemPrompt += `\n\n=== ПРАВИЛА И ПРИВЫЧКИ ВРАЧА (ВЫСШИЙ ПРИОРИТЕТ) ===\n${userData.custom_prompt}\n`;
            }

            // Прокидываем реальную дату/время (Алматы), чтобы LLM не выдумывала
            const nowStr = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
            const userPrompt = `Текущая дата и время: ${nowStr}\n\nТранскрипция:\n"${this.fullText}"\n\nЗаполни форму.`;

            let groqResult = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    groqResult = await groq.chat.completions.create({
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ],
                        model: 'llama-3.3-70b-versatile',
                        response_format: { type: 'json_object' }
                    });
                    break;
                } catch (groqErr) {
                    const statusCode = groqErr.status || 0;
                    console.log(`❌ Groq ошибка ${statusCode}: ${groqErr.message}`);
                    if ((statusCode === 429 || statusCode === 503) && attempt < 2) {
                        console.log(`⏳ Ждём 5 секунд и повторяем (попытка ${attempt + 2}/3)...`);
                        await new Promise(r => setTimeout(r, 5000));
                    } else {
                        throw groqErr;
                    }
                }
            }

            if (groqResult) {
                const jsonResponseText = groqResult.choices[0].message.content;
                console.log('📄 Ответ Groq (сырой):', jsonResponseText.substring(0, 200));
                try {
                    const parsedData = JSON.parse(jsonResponseText);
                    this.send({ type: 'form_update', formJson: parsedData });
                    console.log('✅ Форма успешно обновлена от Groq!');
                } catch (jsonErr) {
                    console.error('❌ Ошибка парсинга JSON от Groq:', jsonResponseText.substring(0, 300));
                }
            }
        } catch (error) {
            console.error('❌ Ошибка LLM:', error.message || error);
        } finally {
            this.isProcessingGroq = false;
        }
    }

    /**
     * Безопасная отправка сообщения через WebSocket
     * @param {ServerMessage} data
     */
    send(data) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    /**
     * Очистка ресурсов при разрыве соединения
     */
    cleanup() {
        console.log('Клиент отключился');
        if (this.llmDebounceTimer) clearTimeout(this.llmDebounceTimer);
        if (this.dgConnection) {
            try { this.dgConnection.socket.close(); } catch(e) {}
        }
    }
}

module.exports = Session;
