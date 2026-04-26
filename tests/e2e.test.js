// tests/e2e.test.js — smoke-тест критического пути MediQaz
// Запуск: npm test (или node --test tests/)
const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('MediQaz E2E', () => {

    test('Модули загружаются без ошибок', () => {
        // Проверяем, что все модули экспортируют ожидаемые функции/объекты
        const { SYSTEM_PROMPTS, buildMagicEditPrompt } = require('../prompts');
        assert.ok(SYSTEM_PROMPTS['052'], 'Промпт 052 должен существовать');
        assert.ok(SYSTEM_PROMPTS['035'], 'Промпт 035 должен существовать');
        assert.ok(SYSTEM_PROMPTS['130'], 'Промпт 130 должен существовать');
        assert.strictEqual(typeof buildMagicEditPrompt, 'function', 'buildMagicEditPrompt должна быть функцией');
    });

    test('buildMagicEditPrompt генерирует корректный промпт', () => {
        const { buildMagicEditPrompt } = require('../prompts');
        const form = { complaints: 'головная боль', diagnosis: '' };
        const instruction = 'добавь диагноз мигрень';
        const result = buildMagicEditPrompt(form, instruction);

        assert.ok(result.includes('головная боль'), 'Промпт должен содержать данные формы');
        assert.ok(result.includes('мигрень'), 'Промпт должен содержать инструкцию');
        assert.ok(result.includes('JSON'), 'Промпт должен просить вернуть JSON');
    });

    test('auth модуль экспортирует нужные функции', () => {
        // Устанавливаем JWT_SECRET для тестов, если не установлен
        if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-for-ci';

        const { verifyToken, signToken, authenticateToken, authenticateWs } = require('../auth');
        assert.strictEqual(typeof verifyToken, 'function');
        assert.strictEqual(typeof signToken, 'function');
        assert.strictEqual(typeof authenticateToken, 'function');
        assert.strictEqual(typeof authenticateWs, 'function');
    });

    test('signToken и verifyToken — цикл подписи и проверки', () => {
        if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-for-ci';

        const { verifyToken, signToken } = require('../auth');
        const user = { id: 42, email: 'doc@test.kz', name: 'Тест Врач' };
        const token = signToken(user);

        assert.ok(token, 'Токен должен быть создан');
        const decoded = verifyToken(token);
        assert.strictEqual(decoded.id, 42);
        assert.strictEqual(decoded.email, 'doc@test.kz');
    });

    test('verifyToken возвращает null для невалидного токена', () => {
        if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-for-ci';

        const { verifyToken } = require('../auth');
        assert.strictEqual(verifyToken('invalid.token.here'), null);
        assert.strictEqual(verifyToken(null), null);
        assert.strictEqual(verifyToken(''), null);
    });

    // TODO: Добавить полный E2E тест когда будет mock для Deepgram/Groq
    // test('full appointment flow', async () => {
    //     // 1. Запускаем сервер
    //     // 2. POST /api/register → token
    //     // 3. WebSocket start/stop
    //     // 4. GET /api/appointments → проверяем запись
    // });
});
