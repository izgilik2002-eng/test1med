// auth.js — единая JWT-логика для HTTP и WebSocket
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Верифицирует JWT-токен и возвращает payload.
 * @param {string} token — JWT-токен
 * @returns {{ id: number, email: string, name: string } | null} — payload или null
 */
function verifyToken(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

/**
 * Создаёт JWT-токен для пользователя.
 * @param {{ id: number, email: string, name: string }} user
 * @returns {string} JWT-токен (7 дней)
 */
function signToken(user) {
    return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Express middleware — защита HTTP-маршрутов.
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Необходима авторизация' });
    }

    req.user = decoded;
    next();
}

/**
 * Аутентификация WebSocket — извлекает userId из токена в URL.
 * @param {import('http').IncomingMessage} req
 * @returns {number|null} userId или null
 */
function authenticateWs(req) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const decoded = verifyToken(token);
    return decoded ? decoded.id : null;
}

module.exports = { verifyToken, signToken, authenticateToken, authenticateWs };
