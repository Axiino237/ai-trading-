const axios = require('axios');
require('dotenv').config();

class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    async sendMessage(message, customToken = null, customChatId = null) {
        const token = customToken || this.token;
        const chatId = customChatId || this.chatId;

        if (!token || !chatId) {
            console.warn('[TELEGRAM] Config missing, skipping notification');
            return;
        }
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        try {
            await axios.post(url, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            });
            console.log(`[TELEGRAM] Notification sent to ${chatId} ✅`);
        } catch (error) {
            console.error('[TELEGRAM ERROR]:', error.response?.data || error.message);
        }
    }

    async sendTradeAlert(tradeData, customCreds = null) {
        const {
            symbol, side, sentiment, price, sl, tp,
            confidence, action, pnl, tradeMode,
            indicators, exitReason
        } = tradeData;

        const actualSide = side || sentiment || 'BUY';
        const isBuy = actualSide === 'BUY' || actualSide === 'BULLISH';
        const sideEmoji = isBuy ? '🟢' : '🔴';

        // Mode badge — LIVE or PAPER
        const mode = tradeMode || 'PAPER';
        const modeBadge = mode === 'REAL' ? '⚡ *LIVE TRADE*' : '📄 *PAPER TRADE*';
        const modeTag = mode === 'REAL' ? '🔴 REAL MONEY' : '🟡 PAPER MONEY';

        // ── Validation Gates ─────────────────────────────────────────
        // SIGNAL: indicators illama anupa vendaam
        if (action === 'SIGNAL' && !indicators) {
            console.warn(`[TELEGRAM] SIGNAL skipped for ${symbol} — no indicators`);
            return;
        }
        // EXECUTION: AI confidence or SL/TP illama anupa vendaam
        if (action === 'EXECUTION' && (!confidence || !sl || !tp)) {
            console.warn(`[TELEGRAM] EXECUTION skipped for ${symbol} — missing confidence/SL/TP`);
            return;
        }
        // EXIT: price illama anupa vendaam
        if (action && action.startsWith('EXIT') && !price) {
            console.warn(`[TELEGRAM] EXIT skipped for ${symbol} — no exit price`);
            return;
        }
        // ─────────────────────────────────────────────────────────────

        let message = '';

        // ─────────────────────────────────────
        // SIGNAL — Technical check passed
        // ─────────────────────────────────────
        if (action === 'SIGNAL') {
            const rsi    = indicators?.rsi     ? indicators.rsi.toFixed(1)              : 'N/A';
            const trend  = indicators?.trend   ? indicators.trend                        : (indicators?.ema9 > indicators?.ema20 ? '📈 BULLISH' : '📉 BEARISH');
            const macd   = indicators?.macd    ? indicators.macd.histogram?.toFixed(3)  : 'N/A';
            const ema9   = indicators?.ema9    ? indicators.ema9.toFixed(2)             : 'N/A';
            const ema20  = indicators?.ema20   ? indicators.ema20.toFixed(2)            : 'N/A';

            message = `
🎯 *SCANNER SIGNAL FOUND* 🔍
${modeBadge} | ${modeTag}
━━━━━━━━━━━━━━━━━━━━━
*Symbol:* \`${symbol}\`
*Signal:* ${sideEmoji} ${actualSide}
*Price:* ₹${price}

📊 *Technical Analysis:*
• RSI: \`${rsi}\` ${parseFloat(rsi) > 60 ? '🔥 Strong' : parseFloat(rsi) < 40 ? '❄️ Weak' : '➡️ Neutral'}
• EMA Trend: \`${trend}\`
• EMA 9: \`${ema9}\` | EMA 20: \`${ema20}\`
• MACD Histogram: \`${macd}\`

_⏳ Waiting for AI confirmation..._
            `;

        // ─────────────────────────────────────
        // EXECUTION — AI confirmed, order placed
        // ─────────────────────────────────────
        } else if (action === 'EXECUTION') {
            const slVal = sl ? sl.toFixed(2) : 'N/A';
            const tpVal = tp ? tp.toFixed(2) : 'N/A';
            const slPct = sl && price ? (Math.abs(price - sl) / price * 100).toFixed(1) : 'N/A';
            const tpPct = tp && price ? (Math.abs(tp - price) / price * 100).toFixed(1) : 'N/A';

            message = `
🚀 *ORDER EXECUTED* 💰
${modeBadge} | ${modeTag}
━━━━━━━━━━━━━━━━━━━━━
*Symbol:* \`${symbol}\`
*Side:* ${sideEmoji} *${actualSide}*
*Quantity:* \`${tradeData.quantity || 1}\`
*Entry Price:* ₹${price}

📉 *Risk Management:*
• Stop Loss: ₹${slVal} \`(-${slPct}%)\`
• Take Profit: ₹${tpVal} \`(+${tpPct}%)\`
• Risk:Reward: \`1:2\`

🤖 *AI Confidence:* ${confidence || 'N/A'}%

_✅ Trade is now LIVE on dashboard_
            `;

        // ─────────────────────────────────────
        // EXIT — SL or TP hit
        // ─────────────────────────────────────
        } else if (action && action.startsWith('EXIT')) {
            const reason = exitReason || (action.includes('SL') ? 'Stop Loss' : action.includes('TP') ? 'Take Profit' : 'Manual');
            const pnlVal = typeof pnl === 'number' ? pnl : 0;
            const isProfit = pnlVal >= 0;
            const pnlEmoji = isProfit ? '✅ PROFIT' : '❌ LOSS';
            const entryPrice = tradeData.entryPrice || tradeData.entry_price || 'N/A';

            message = `
🚪 *TRADE CLOSED* | ${reason.toUpperCase()}
${modeBadge} | ${modeTag}
━━━━━━━━━━━━━━━━━━━━━
*Symbol:* \`${symbol}\`
*Direction:* ${sideEmoji} ${actualSide}

💹 *Trade Summary:*
• Entry Price: ₹${entryPrice !== 'N/A' ? parseFloat(entryPrice).toFixed(2) : 'N/A'}
• Exit Price: ₹${price}
• Exit Reason: \`${reason}\`
• P&L: *${isProfit ? '+' : ''}₹${pnlVal.toFixed(2)}* ${pnlEmoji}

_📊 Dashboard updated_
            `;
        }

        if (message) await this.sendMessage(message, customCreds?.telegram_bot_token, customCreds?.telegram_chat_id);
    }
}

module.exports = new TelegramService();
