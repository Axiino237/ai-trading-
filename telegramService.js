const axios = require('axios');
require('dotenv').config();

class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    async sendMessage(message) {
        if (!this.token || !this.chatId) {
            console.warn('[TELEGRAM] Config missing, skipping notification');
            return;
        }

        const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
        try {
            await axios.post(url, {
                chat_id: this.chatId,
                text: message,
                parse_mode: 'Markdown'
            });
            console.log('[TELEGRAM] Notification sent ✅');
        } catch (error) {
            console.error('[TELEGRAM ERROR]:', error.response?.data || error.message);
        }
    }

    async sendTradeAlert(tradeData) {
        const { symbol, side, price, sl, tp, confidence } = tradeData;
        const emoji = side === 'BUY' ? '🟢' : '🔴';
        
        const message = `
${emoji} *NEW TRADE ALERT* ${emoji}

*Symbol:* ${symbol}
*Side:* ${side}
*Entry:* ₹${price}
*Stop Loss:* ₹${sl.toFixed(2)}
*Take Profit:* ₹${tp.toFixed(2)}
*Confidence:* ${confidence}%

🚀 _StocksPro AI Engine Execution_
        `;
        
        await this.sendMessage(message);
    }
}

module.exports = new TelegramService();
