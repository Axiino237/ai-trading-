const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

class GeminiService {
    constructor() {
        this.keys = (process.env.GEMINI_API_KEYS || '').split(',').filter(k => k.trim());
        this.currentIndex = 0;
        this.instances = this.keys.map(key => new GoogleGenerativeAI(key));
    }

    getNextInstance() {
        if (this.instances.length === 0) return null;
        const instance = this.instances[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.instances.length;
        return instance;
    }

    async generateAnalysis(prompt, retryCount = 0) {
        const genAI = this.getNextInstance();
        if (!genAI) throw new Error('No Gemini API keys configured');

        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
            const result = await model.generateContent(prompt);
            const text = (await result.response).text();
            return text;
        } catch (error) {
            console.error(`[GEMINI] Key ${this.currentIndex} failed:`, error.message);
            
            // If we hit a rate limit or service error, try the next key
            if (retryCount < this.keys.length) {
                console.log(`[GEMINI] Retrying with next key... (${retryCount + 1}/${this.keys.length})`);
                return this.generateAnalysis(prompt, retryCount + 1);
            }
            throw error;
        }
    }
}

module.exports = new GeminiService();
