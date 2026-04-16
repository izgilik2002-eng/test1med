require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация API
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'mediqaz-fallback-secret';

// JWT Middleware — защита маршрутов
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Необходима авторизация' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Токен недействителен' });
    }
}

// Конфигурация для JSON ответа от Gemini
const geminiJsonConfig = {
    responseMimeType: "application/json",
};

// Промпты для каждой формы
const SYSTEM_PROMPTS = {
    '052': `Ты опытный врач-ассистент в Казахстане (МИС Дамумед). Язык: русско-казахский микс.
На основе транскрипции разговора врача и пациента заполни поля Формы № 052/у (Амбулаторный прием).
Не придумывай данные, которых нет в тексте. Пиши кратко, медицинским языком.
Транскрипция может содержать метки спикеров [Спикер 0], [Спикер 1] — используй их для точного понимания, кто врач, а кто пациент.

Верни ТОЛЬКО валидный JSON объект (без markdown, без комментариев) со следующими строковыми ключами:
{"date": "сегодняшняя дата и время", "visitType": "Первичное или Повторное", "complaints": "жалобы пациента", "anamnesis": "анамнез заболевания", "status": "объективные данные: температура, АД и тд", "diagnosis": "", "recommendations": "рекомендации врача", "patient_summary": "Краткая выписка на ПРОСТОМ языке для пациента: что с ним, что делать, какие лекарства принимать, когда прийти снова. Без медицинских терминов, понятно бабушке."}`,

    '035': `Ты медицинский ассистент (МИС Дамумед).
На основе транскрипции заполни Лист временной нетрудоспособности (Форма № 035/у).
Транскрипция может содержать метки спикеров [Спикер 0], [Спикер 1].
Верни строго валидный JSON со следующими ключами:
- workplace: Место работы пациента
- reason: Причина нетрудоспособности (Заболевание / Травма / Уход за ребенком)
- regime: Режим (Амбулаторный / Стационарный)
- startDate: Дата начала освобождения (сегодняшняя дата, если не сказано иное)
- endDate: Дата окончания (предполагаемая)
- doctorInfo: ФИО лечащего врача (если известно)
- patient_summary: Краткая выписка на ПРОСТОМ языке для пациента: на сколько дней больничный, что делать, когда выйти на работу`,

    '130': `Ты медицинский ассистент (МИС Дамумед).
На основе транскрипции разговора выдели данные для Рецептурного бланка (Форма № 130/у).
Транскрипция может содержать метки спикеров [Спикер 0], [Спикер 1].
Верни строго валидный JSON со следующими ключами:
- recipeType: Тип рецепта (Обычный / Бесплатный)
- medicineName: Наименование ЛС (МНН) - например Xylometazoline
- dosage: Дозировка
- usage: Способ применения (Сигнатура) - например "По 2 капли 3 раза в день"
- validity: Срок действия рецепта (15 дней / 30 дней)
- patient_summary: Краткая инструкция на ПРОСТОМ языке для пациента: какое лекарство купить, как принимать, сколько дней`
};


// Функция для распознавания аудио через Deepgram (Nova-2 + Speaker Diarization)
async function transcribeWithDeepgram(audioBuffer) {
    if (audioBuffer.length === 0) return "";

    const response = await axios.post(
        'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
            model: 'nova-2',            // Nova-2 — поддерживает diarization
            diarize: 'true',            // Разделение спикеров (Врач / Пациент)
            detect_language: 'true',    // Авто-определение языка
            punctuate: 'true',          // Автопунктуация (запятые, точки)
            smart_format: 'true',       // Умное форматирование чисел, дат
        }).toString(),
        audioBuffer,
        {
            headers: {
                'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                'Content-Type': 'audio/webm',
            },
            timeout: 60000,
            maxBodyLength: Infinity
        }
    );

    const detectedLang = response.data?.results?.channels?.[0]?.detected_language || "?";
    const words = response.data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];

    if (words.length === 0) {
        // Fallback: обычный транскрипт без диаризации
        const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log(`Deepgram fallback (язык: ${detectedLang}): "${transcript.substring(0, 80)}..."`);
        return transcript;
    }

    // Группируем слова по спикерам для читаемой транскрипции
    let formatted = "";
    let currentSpeaker = -1;

    for (const word of words) {
        if (word.speaker !== currentSpeaker) {
            currentSpeaker = word.speaker;
            if (formatted) formatted += "\n";
            formatted += `[Спикер ${currentSpeaker}]: `;
        }
        formatted += (word.punctuated_word || word.word) + " ";
    }

    const result = formatted.trim();
    console.log(`Deepgram (nova-2 + diarization, язык: ${detectedLang}): "${result.substring(0, 120)}..."`);
    return result;
}

// ========== AUTH API ==========
app.post('/api/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const existing = db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email уже зарегистрирован' });

    const password_hash = await bcrypt.hash(password, 10);
    const userId = db.createUser({ email, password_hash, name });
    const token = jwt.sign({ id: userId, email, name }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: userId, email, name } });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/me', authenticateToken, (req, res) => {
    const user = db.getUserById(req.user.id);
    if (user) res.json(user);
    else res.status(404).json({ error: 'Пользователь не найден' });
});

app.get('/api/me/prompt', authenticateToken, (req, res) => {
    const user = db.getUserById(req.user.id);
    res.json({ custom_prompt: user?.custom_prompt || '' });
});

app.post('/api/me/prompt', authenticateToken, (req, res) => {
    const { prompt } = req.body;
    db.updateUserPrompt(req.user.id, prompt || '');
    res.json({ success: true });
});

// ========== PROTECTED REST API ==========
app.get('/api/appointments', authenticateToken, (req, res) => {
    const search = req.query.search || '';
    res.json(db.getAllAppointments(req.user.id, search));
});
app.get('/api/appointments/:id', authenticateToken, (req, res) => {
    const appointment = db.getAppointmentById(req.params.id, req.user.id);
    if (appointment) res.json(appointment);
    else res.status(404).json({ error: 'Приём не найден' });
});
app.delete('/api/appointments/:id', authenticateToken, (req, res) => {
    const success = db.deleteAppointment(req.params.id, req.user.id);
    if (success) res.json({ success: true });
    else res.status(404).json({ error: 'Приём не найден' });
});

// ========== MAGIC EDIT ==========
app.post('/api/magic-edit', authenticateToken, async (req, res) => {
    const { currentForm, instruction } = req.body;
    if (!instruction || !currentForm) {
        return res.status(400).json({ error: 'Нужна форма и инструкция' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `Ты медицинский ассистент. У тебя есть заполненная медицинская форма (JSON) и голосовая инструкция врача.
Задача: примени инструкцию врача к форме и верни обновлённый JSON.
Не меняй поля, которые не затронуты инструкцией. Верни ТОЛЬКО валидный JSON.

Текущая форма:
${JSON.stringify(currentForm, null, 2)}

Инструкция врача: "${instruction}"

Верни обновлённый JSON.`;

    let result = null;
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: geminiJsonConfig,
            });
            break; // Успешно
        } catch (err) {
            lastErr = err;
            const statusCode = err.status || err.httpStatusCode || 0;
            // 503 Service Unavailable или 429 Too Many Requests
            if ((statusCode === 429 || statusCode === 503) && attempt < 2) {
                console.log(`⏳ Magic Edit: Ждём 5 секунд и повторяем (попытка ${attempt + 2}/3)...`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                break;
            }
        }
    }

    if (!result) {
        console.error('Magic Edit ошибка API:', lastErr?.message);
        return res.status(503).json({ error: 'Нейросеть сейчас перегружена. Попробуйте еще раз.' });
    }

    try {
        const updatedForm = JSON.parse(result.response.text());
        console.log('✨ Magic Edit успешно:', instruction.substring(0, 60));
        res.json({ updatedForm });
    } catch (err) {
        console.error('Magic Edit ошибка парсинга:', err.message);
        res.status(500).json({ error: 'Ошибка ответа нейросети' });
    }
});

// WebSocket для Real-Time обработки
const MAX_BINARY_MSG_BYTES = 2 * 1024 * 1024;

wss.on('connection', (ws, req) => {
    // Аутентификация WebSocket по токену из URL
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let wsUserId = null;

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        wsUserId = decoded.id;
        console.log(`Клиент подключён (врач ID: ${wsUserId})`);
    } catch (err) {
        console.log('WebSocket: неавторизованное подключение, закрываем.');
        ws.close(4001, 'Unauthorized');
        return;
    }

    let audioChunks = [];
    let sessionData = {};
    let processInterval = null;
    let isProcessing = false;
    let fullTextAccumulated = "";

    // Асинхронная функция обработки накопившегося аудио
    const processCurrentAudio = async () => {
        if (isProcessing || audioChunks.length === 0) return;
        isProcessing = true;
        console.log(`\n--- Цикл обработки [${new Date().toLocaleTimeString()}] ---`);
        console.log(`Аудио чанков: ${audioChunks.length}`);

        try {
            const currentAudioData = Buffer.concat(audioChunks);
            console.log(`Размер аудио: ${currentAudioData.length} байт`);

            // 1. STT (Deepgram Whisper Large)
            console.log('➡️  Отправка в Deepgram...');
            const transcriptionText = await transcribeWithDeepgram(currentAudioData);
            if (!transcriptionText.trim()) {
                console.log('⚠️  Deepgram вернул пустой текст, пропускаем.');
                isProcessing = false;
                return;
            }

            fullTextAccumulated = transcriptionText;

            // Отправляем сырой текст на фронтенд
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'transcription_update', text: fullTextAccumulated }));
                console.log('✅ Текст отправлен на фронтенд');
            }

            // 2. Генерация JSON (Gemini 1.5 Flash)
            console.log('➡️  Отправка в Gemini 1.5 Flash...');
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            let prompt = SYSTEM_PROMPTS[sessionData.formType] || SYSTEM_PROMPTS['052'];

            // Загружаем кастомный промпт текущего врача
            const userData = db.getUserById(wsUserId);
            if (userData && userData.custom_prompt && userData.custom_prompt.trim()) {
                prompt += `\n\n=== ПРАВИЛА И ПРИВЫЧКИ ВРАЧА (ВЫСШИЙ ПРИОРИТЕТ) ===\n${userData.custom_prompt}\n`;
            }

            const userPrompt = `Транскрипция:\n"${fullTextAccumulated}"\n\nЗаполни форму. Верни ТОЛЬКО JSON без markdown.`;

            let geminiResult = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    geminiResult = await model.generateContent({
                        contents: [{ role: "user", parts: [{ text: prompt + "\n\n" + userPrompt }] }],
                        generationConfig: geminiJsonConfig,
                    });
                    break;
                } catch (geminiErr) {
                    const statusCode = geminiErr.status || geminiErr.httpStatusCode || 0;
                    console.log(`❌ Gemini ошибка ${statusCode}: ${geminiErr.message}`);
                    if ((statusCode === 429 || statusCode === 503) && attempt < 2) {
                        console.log(`⏳ Ждём 10 секунд и повторяем (попытка ${attempt + 2}/3)...`);
                        await new Promise(r => setTimeout(r, 10000));
                    } else {
                        throw geminiErr;
                    }
                }
            }

            if (geminiResult) {
                const jsonResponseText = geminiResult.response.text();
                console.log('📄 Ответ Gemini (сырой):', jsonResponseText.substring(0, 200));
                try {
                    const parsedData = JSON.parse(jsonResponseText);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'form_update', formJson: parsedData }));
                    }
                    console.log('✅ Форма успешно обновлена от Gemini!');
                } catch (jsonErr) {
                    console.error('❌ Ошибка парсинга JSON от Gemini:', jsonResponseText.substring(0, 300));
                }
            }

        } catch (error) {
            console.error('❌ Ошибка в цикле:', error.message || error);
        } finally {
            isProcessing = false;
            console.log('--- Конец цикла ---\n');
        }
    };

    ws.on('message', async (message, isBinary) => {
        if (isBinary) {
            if (message.length > MAX_BINARY_MSG_BYTES) return;
            audioChunks.push(Buffer.from(message));
            return;
        }

        let data;
        try { data = JSON.parse(message.toString()); } catch { return; }

        if (data.type === 'start') {
            sessionData = data.payload || {};
            sessionData.formType = sessionData.formType || '052';
            audioChunks = [];
            fullTextAccumulated = "";
            console.log(`Начат приём. Форма: ${sessionData.formType}`);

            // Запускаем автоматический цикл каждые 20 секунд (чтобы не превышать лимиты Gemini)
            processInterval = setInterval(processCurrentAudio, 20000);
        }
        else if (data.type === 'stop') {
            console.log('Остановка приёма. Финальное сохранение...');
            if (processInterval) clearInterval(processInterval);

            ws.send(JSON.stringify({ type: 'processing', message: 'Сохраняем данные в БД...' }));

            // manualOverrides содержат финальные данные из полей, которые мог отредактировать Врач перед кнопкой "Завершить"
            const finalFormJson = data.manualOverrides || {};

            try {
                // Сохраняем в БД (medCard как JSON-строка)
                const appointmentId = db.saveAppointment({
                    user_id: wsUserId,
                    patient_name: sessionData.patientName,
                    doctor_name: sessionData.doctorName,
                    date: new Date().toISOString(),
                    transcription: fullTextAccumulated,
                    med_card: JSON.stringify(finalFormJson),
                    form_type: sessionData.formType
                });

                ws.send(JSON.stringify({ type: 'success', appointmentId }));
            } catch (err) {
                console.error('Ошибка БД:', err);
                ws.send(JSON.stringify({ type: 'error', message: 'Ошибка БД' }));
            }
        }
    });

    ws.on('error', (error) => console.error('WebSocket ошибка:', error));
    ws.on('close', () => {
        console.log('Клиент отключился');
        if (processInterval) clearInterval(processInterval);
        audioChunks = [];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер MediQaz запущен на порту ${PORT}`));
