const angelOneService = require('./angelOneService');
const supabaseService = require('./supabaseService');
const ta = require('./technicalAnalysis');

require('dotenv').config();

const geminiService = require('./geminiService');

class ScannerService {
    constructor() {
        this.interval = 5 * 60 * 1000; // 5 min scan
        this.isScanning = false;
        this.broadcasterInterval = 15 * 1000; // 15 sec price update (Slower for rate limit safety)
    }

    start() {
        console.log('[ENTERPRISE] AI Rule Engine Started... 🚀');
        this.safeScan();
        this.startBroadcaster();
    }

    startBroadcaster() {
        setInterval(async () => {
            try {
                const defaultSymbols = ['RELIANCE-EQ', 'TATASTEEL-EQ', 'SBIN-EQ', 'HDFCBANK-EQ', 'INFY-EQ'];
                const MOCK_USER_ID = '00000000-0000-0000-0000-000000000000';
                
                // Always fetch mock user watchlist for live updates
                const list = await supabaseService.getUserWatchlist(MOCK_USER_ID);
                const userSymbols = list.map(item => item.symbol);

                const symbols = [...new Set([...defaultSymbols, ...userSymbols])];
                const quotes = await angelOneService.getMultipleQuotes(symbols);
                
                for (const quote of quotes) {
                    if (global.io) {
                        global.io.emit('symbol-status', {
                            symbol: quote.tradingSymbol, 
                            price: quote.lastTradedPrice,
                            change: (quote.pChange || quote.percentChange || (quote.close ? ((quote.ltp - quote.close) / quote.close * 100).toFixed(2) : '0')) + '%'
                            // Omit 'pass' to avoid overwriting scanner signals
                        });
                        console.log(`[BROADCAST] Sent live price for ${quote.tradingSymbol}: ₹${quote.lastTradedPrice}`);
                    }
                }
                // Wait longer between batches to stay safe
                await new Promise(r => setTimeout(r, 5000));
            } catch (e) {
                // Global broadcaster fail
            }
        }, this.broadcasterInterval);
    }

    async safeScan() {
        await this.scan();
        setTimeout(() => this.safeScan(), this.interval);
    }

    async scan() {
        if (this.isScanning) return;
        this.isScanning = true;

        try {
            const symbols = [
                'RELIANCE-EQ', 'TCS-EQ', 'HDFCBANK-EQ', 'ICICIBANK-EQ', 'INFY-EQ', 
                'BHARTIARTL-EQ', 'SBI-EQ', 'LICI-EQ', 'HINDUNILVR-EQ', 'ITC-EQ',
                'LT-EQ', 'BAJFINANCE-EQ', 'KOTAKBANK-EQ', 'ADANIENT-EQ', 'AXISBANK-EQ',
                'TITAN-EQ', 'SUNPHARMA-EQ', 'ULTRACEMCO-EQ', 'TATASTEEL-EQ', 'NTPC-EQ',
                'MARUTI-EQ', 'COALINDIA-EQ', 'ASIANPAINT-EQ', 'M&M-EQ'
            ];

            const users = await supabaseService.getAutoEnabledUsers();
            
            for (const user of users) {
                const settings = await supabaseService.getUserSettings(user.user_id);
                const todayCount = await supabaseService.getTodayTradeCount(user.user_id);
                const limit = settings.daily_trade_limit || 5;

                console.log(`[SCANNER] Checking User ${user.email}. Trades today: ${todayCount}/${limit}`);

                if (todayCount >= limit) {
                    console.log(`[SCANNER] User ${user.email} reached per-day limit. Skipping scan.`);
                    continue;
                }

                for (const sym of symbols) {
                    await this.processEnterpriseFlow(sym, user.user_id, settings.auto_trade_on);
                    await new Promise(r => setTimeout(r, 1500)); // Increased for rate limit safety
                }
            }
        } catch (error) {
            console.error('[SCANNER] Fatal Error:', error.message);
        } finally {
            this.isScanning = false;
        }
    }

    async processEnterpriseFlow(symbol, userId, autoTradeOn) {
        try {
            const quote = await angelOneService.getQuote(symbol);
            const candles = await angelOneService.getCandleData(symbol, 'FIVE_MINUTE', 5);
            if (!quote || !candles) return;

            const indicators = {
                ema9: ta.calculateEMA(candles, 9),
                ema20: ta.calculateEMA(candles, 20),
                ema50: ta.calculateEMA(candles, 50),
                rsi: ta.calculateRSI(candles),
                macd: ta.calculateMACD(candles),
                volume: quote.volume || candles[candles.length - 1][5],
                avgVolume: ta.calculateAvgVolume(candles, 20),
                candles: candles
            };

            const rules = ta.checkRules(indicators);

            if (global.io) {
                global.io.emit('symbol-status', {
                    symbol,
                    pass: rules.pass,
                    indicators: {
                        rsi: indicators.rsi,
                        trend: indicators.ema9 > indicators.ema20 ? 'UP' : 'DOWN'
                    },
                    price: quote.lastTradedPrice,
                    change: (quote.pChange || quote.percentChange || (quote.close ? ((quote.ltp - quote.close) / quote.close * 100).toFixed(2) : '0')) + '%'
                });
            }

            if (!rules.pass) return;

            console.log(`[RULE ENGINE] ${symbol} PASSED Technical Check! ✅`);

            if (!autoTradeOn) {
                console.log(`[SCANNER] Automation OFF. Skipping AI Analysis for ${symbol}.`);
                return;
            }

            // RE-CHECK PER-DAY LIMIT RIGHT BEFORE AI/EXECUTION (Just to be safe)
            const todayCount = await supabaseService.getTodayTradeCount(userId);
            const settings = await supabaseService.getUserSettings(userId);
            if (todayCount >= (settings.daily_trade_limit || 5)) return;

            console.log(`[AI ENGINE] Starting Deep Prediction for ${symbol}... 🧠`);
            const aiResult = await this.getAIAnalysis(symbol, quote.lastTradedPrice, indicators);
            
            if (aiResult.confidenceScore < 85) {
                console.log(`[AI ENGINE] ${symbol} Low Confidence: ${aiResult.confidenceScore}`);
                return;
            }

            const risk = this.calculateRisk(quote.lastTradedPrice, aiResult.sentiment);
            
            // Send Telegram Notification
            const telegramService = require('./telegramService');
            await telegramService.sendTradeAlert({
                symbol,
                side: aiResult.sentiment,
                price: quote.lastTradedPrice,
                sl: risk.sl,
                tp: risk.tp,
                confidence: aiResult.confidenceScore
            });

            console.log(`[EXECUTION] Placing ${aiResult.sentiment} order for ${symbol}... 💰`);
            await this.executeTrade(userId, symbol, quote.symbolToken, aiResult.sentiment, risk);

        } catch (error) {
            console.error(`[FLOW ERROR] ${symbol}:`, error.message);
        }
    }

    async getAIAnalysis(symbol, price, indicators) {
        const prompt = `
            Expert Quant Trader Analysis:
            SYMBOL: ${symbol} @ ₹${price}
            INDICATORS: RSI: ${indicators.rsi.toFixed(2)}, MACD Histogram: ${indicators.macd.histogram.toFixed(2)}, EMA Trend: ${indicators.ema9 > indicators.ema50 ? 'Bullish' : 'Bearish'}
            TASK: Compare with 2-year historical setups. Detect false breakouts.
            OUTPUT JSON: {"sentiment": "BUY", "confidenceScore": 92, "riskLevel": "Low", "suggestedHolding": "2 days", "winProbability": 88}
        `;
        try {
            const text = await geminiService.generateAnalysis(prompt);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('AI failed to return valid JSON');
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.error('[AI ENGINE ERROR]:', e.message);
            return { sentiment: 'NEUTRAL', confidenceScore: 0 };
        }
    }

    calculateRisk(price, side) {
        const slPercent = 0.02; 
        const tpPercent = 0.04; 
        const isBuy = side === 'BUY';
        return {
            entry: price,
            sl: isBuy ? price * (1 - slPercent) : price * (1 + slPercent),
            tp: isBuy ? price * (1 + tpPercent) : price * (1 - tpPercent),
            rr: '1:2'
        };
    }

    async executeTrade(userId, symbol, token, side, risk) {
        const settings = await supabaseService.getUserSettings(userId);
        const tradingType = settings.trade_mode || 'PAPER';

        if (tradingType === 'REAL') {
            await angelOneService.placeOrder(symbol, token, 1, side, 'LIMIT', risk.entry);
        }
        
        await supabaseService.saveTrade({
            user_id: userId,
            symbol,
            symbolToken: token,
            type: side,
            entry_price: risk.entry,
            stop_loss: risk.sl,
            take_profit: risk.tp,
            status: 'OPEN',
            trading_type: tradingType,
            trade_mode: 'BOT'
        });

        if (global.io) {
            global.io.emit('trade-executed', { symbol, type: side, price: risk.entry });
        }
    }
}

module.exports = new ScannerService();
