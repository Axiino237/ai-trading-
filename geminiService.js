const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

class GeminiService {
    constructor() {
        // Load all keys from .env
        this.apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
        this.currentKeyIndex = 0;
        this.modelName = 'gemini-flash-latest'; // More stable than 1.5-flash alias
    }

    /**
     * Get the current working GenAI instance
     */
    getGenAI() {
        const key = this.apiKeys[this.currentKeyIndex];
        return new GoogleGenerativeAI(key);
    }

    /**
     * Rotate to the next key if current one fails
     */
    rotateKey() {
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        console.log(`[GEMINI] Rotating to API Key Index: ${this.currentKeyIndex}`);
    }

    /**
     * Core function to generate analysis with auto-retry on different keys
     */
    async generateAnalysis(prompt, retries = 3) {
        if (this.apiKeys.length === 0) {
            throw new Error('No Gemini API keys found in .env');
        }

        for (let i = 0; i < this.apiKeys.length; i++) {
            try {
                const genAI = this.getGenAI();
                const model = genAI.getGenerativeModel({ model: this.modelName });
                
                const result = await model.generateContent(prompt);
                const response = await result.response;
                return response.text();
                
            } catch (error) {
                console.error(`[GEMINI] Error with key ${this.currentKeyIndex}:`, error.message);
                
                // If 404, might be model name, but usually it's key limit or regional
                if (error.message.includes('429') || error.message.includes('Quota') || error.message.includes('404')) {
                    this.rotateKey();
                } else {
                    // Other errors we might want to throw immediately
                    this.rotateKey();
                }
                
                // Wait a bit before next key if it was a rate limit
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        throw new Error('All Gemini API keys failed or reached quota limits');
    }
}

module.exports = new GeminiService();
