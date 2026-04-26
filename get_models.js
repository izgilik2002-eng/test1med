const axios = require('axios');
require('dotenv').config();

async function checkModels() {
    try {
        const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const models = response.data.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));
        console.log("Доступные модели для генерации текста:");
        console.log(models);
    } catch (err) {
        console.error("Ошибка при получении списка: " + err.message);
    }
}
checkModels();
