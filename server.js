require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./database');
const { buildMagicEditPrompt } = require('./prompts');
const { authenticateToken, authenticateWs, signToken } = require('./auth');
const Session = require('./session');
const Groq = require('groq-sdk');

// Fail-fast: сервер не запустится без критически важных ключей
const REQUIRED_ENV = ['DEEPGRAM_API_KEY', 'GROQ_API_KEY', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`FATAL: отсутствуют переменные окружения: ${missing.join(', ')}`);
    console.error('Скопируйте .env.example в .env и заполните значения.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ========== AUTH API ==========
app.post('/api/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const existing = db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email уже зарегистрирован' });

    const password_hash = await bcrypt.hash(password, 10);
    try {
        const userId = db.createUser({ email, password_hash, name });
        const token = signToken({ id: userId, email, name });
        res.json({ token, user: { id: userId, email, name } });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') {
            return res.status(409).json({ error: 'Email уже зарегистрирован' });
        }
        console.error('Ошибка регистрации:', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = signToken(user);
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

    const prompt = buildMagicEditPrompt(currentForm, instruction);

    let chatCompletion = null;
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            chatCompletion = await groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: 'llama-3.3-70b-versatile',
                response_format: { type: 'json_object' }
            });
            break;
        } catch (err) {
            lastErr = err;
            const statusCode = err.status || err.httpStatusCode || 0;
            if ((statusCode === 429 || statusCode === 503) && attempt < 2) {
                console.log(`⏳ Magic Edit: Ждём 5 секунд и повторяем (попытка ${attempt + 2}/3)...`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                break;
            }
        }
    }

    if (!chatCompletion) {
        console.error('Magic Edit ошибка API Groq:', lastErr?.message);
        return res.status(503).json({ error: 'Нейросеть сейчас перегружена. Попробуйте еще раз.' });
    }

    try {
        const updatedForm = JSON.parse(chatCompletion.choices[0].message.content);
        console.log('✨ Magic Edit успешно (Groq):', instruction.substring(0, 60));
        res.json({ updatedForm });
    } catch (err) {
        console.error('Magic Edit ошибка парсинга:', err.message);
        res.status(500).json({ error: 'Ошибка ответа нейросети' });
    }
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws, req) => {
    const userId = authenticateWs(req);
    if (!userId) {
        console.log('WebSocket: неавторизованное подключение, закрываем.');
        ws.close(4001, 'Unauthorized');
        return;
    }

    console.log(`Клиент подключён (врач ID: ${userId})`);
    const session = new Session(ws, userId);

    ws.on('message', (msg, isBinary) => session.handleMessage(msg, isBinary));
    ws.on('error', (error) => console.error('WebSocket ошибка:', error));
    ws.on('close', () => session.cleanup());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер MediQaz запущен на порту ${PORT}`));
