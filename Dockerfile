FROM node:20-bullseye-slim

# Установка зависимостей для компиляции SQLite (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Создаем директорию приложения
WORKDIR /app

# Копируем package.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --omit=dev

# Копируем исходный код
COPY . .

# Создаём non-root пользователя для безопасности
RUN useradd -m -u 1001 mediqaz && chown -R mediqaz:mediqaz /app
USER mediqaz

# Открываем порт HTTP сервера
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]
