const Database = require('better-sqlite3');
const path = require('path');

// Инициализация базы данных (файл будет создан автоматически)
const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'mediqaz.db');
const db = new Database(dbPath);

// Создание таблицы пользователей (врачей)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    custom_prompt TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Создание таблицы приёмов
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    patient_name TEXT,
    doctor_name TEXT,
    date TEXT,
    transcription TEXT,
    med_card TEXT,
    form_type TEXT DEFAULT '052',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Миграции для существующих таблиц
function safeMigrate(sql, description) {
    try {
        db.exec(sql);
    } catch (e) {
        if (e.message && e.message.includes('duplicate column name')) {
            // Колонка уже существует — нормально при повторном запуске
            return;
        }
        console.error(`[DB Migration FAILED] ${description}:`, e.message);
        throw e;
    }
}

safeMigrate("ALTER TABLE appointments ADD COLUMN form_type TEXT DEFAULT '052'", 'add form_type to appointments');
safeMigrate("ALTER TABLE appointments ADD COLUMN user_id INTEGER", 'add user_id to appointments');
safeMigrate("ALTER TABLE users ADD COLUMN custom_prompt TEXT", 'add custom_prompt to users');

module.exports = {
  // --- Пользователи (Врачи) ---
  createUser: (data) => {
    const stmt = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)');
    const info = stmt.run(data.email, data.password_hash, data.name);
    return info.lastInsertRowid;
  },

  getUserByEmail: (email) => {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserById: (id) => {
    return db.prepare('SELECT id, email, name, custom_prompt, created_at FROM users WHERE id = ?').get(id);
  },

  updateUserPrompt: (id, prompt) => {
    const stmt = db.prepare('UPDATE users SET custom_prompt = ? WHERE id = ?');
    return stmt.run(prompt, id).changes > 0;
  },

  // --- Приёмы (изолированы по user_id) ---
  saveAppointment: (data) => {
    const stmt = db.prepare(`
      INSERT INTO appointments (user_id, patient_name, doctor_name, date, transcription, med_card, form_type) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(data.user_id, data.patient_name, data.doctor_name, data.date, data.transcription, data.med_card, data.form_type || '052');
    return info.lastInsertRowid;
  },

  // Получить приёмы только этого врача (с поиском)
  getAllAppointments: (userId, search) => {
    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      return db.prepare('SELECT id, patient_name, doctor_name, date, form_type, created_at FROM appointments WHERE user_id = ? AND (patient_name LIKE ? OR doctor_name LIKE ?) ORDER BY created_at DESC').all(userId, q, q);
    }
    return db.prepare('SELECT id, patient_name, doctor_name, date, form_type, created_at FROM appointments WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },

  // Получить детали приёма (только если принадлежит этому врачу)
  getAppointmentById: (id, userId) => {
    return db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, userId);
  },

  // Удалить приём (только если принадлежит этому врачу)
  deleteAppointment: (id, userId) => {
    const stmt = db.prepare('DELETE FROM appointments WHERE id = ? AND user_id = ?');
    return stmt.run(id, userId).changes > 0;
  }
};