const angelOneService = require('./angelOneService');
const supabaseService = require('./supabaseService');
const ta = require('./technicalAnalysis');
const geminiService = require('./geminiService');
const telegramService = require('./telegramService');
const logger = require('./logger');

require('dotenv').config();

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
                const MOCK_USER_ID = '550e8400-e29b-41d4-a716-446655440000'; // Matches auto_settings
                
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
            const users = await supabaseService.getAutoEnabledUsers();
            
            for (const user of users) {
                const userId = user.user_id; // Dynamic from DB
                if (!userId) continue;
                const settings = await supabaseService.getUserSettings(userId);
                const todayCount = await supabaseService.getTodayTradeCount(userId);
                const limit = settings.daily_trade_limit || 5;

                logger.info(`[SCANNER] Monitoring User ID: ${userId}. Trades today: ${todayCount}/${limit}`);

                if (todayCount >= limit) {
                    logger.info(`[SCANNER] User reached per-day limit. Skipping scan.`);
                    continue;
                }

                // FETCH USER WATCHLIST ONLY
                const watchlist = await supabaseService.getUserWatchlist(userId);
                const symbols = watchlist.map(item => item.symbol);

                if (symbols.length === 0) {
                    logger.info(`[SCANNER] Watchlist empty for user: ${userId}. Skipping.`);
                    continue;
                }

                logger.info(`[SCANNER] Scanning ${symbols.length} watchlist stocks for ID: ${userId}...`);

                for (const sym of symbols) {
                    await this.processEnterpriseFlow(sym, user.user_id, settings.auto_trade_on);
                    await new Promise(r => setTimeout(r, 1500)); 
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

            const settings = await supabaseService.getUserSettings(userId);
            const rules = ta.checkRules(indicators, settings.scan_mode || 'STRICT');

            if (global.io) {
                global.io.emit('symbol-status', {
                    symbol,
                    pass: rules.pass,
                    side: rules.side,
                    indicators: {
                        rsi: indicators.rsi,
                        trend: indicators.ema9 > indicators.ema20 ? 'UP' : 'DOWN'
                    },
                    price: quote.lastTradedPrice,
                    change: (quote.pChange || quote.percentChange || (quote.close ? ((quote.ltp - quote.close) / quote.close * 100).toFixed(2) : '0')) + '%'
                });
            }

            if (!rules.pass) {
                // DETAILED REJECTION LOGGING
                const reasons = [];
                if (indicators.rsi > 70) reasons.push('Overbought (RSI > 70)');
                if (indicators.rsi < 30) reasons.push('Oversold (RSI < 30)');
                if (indicators.ema9 < indicators.ema20) reasons.push('Bearish Trend (EMA9 < EMA20)');
                
                logger.info(`[SCANNER] ${symbol} Rejected: Technical criteria not met.`, { reasons });
                return;
            }

            logger.success(`[SCANNER] ${symbol} PASSED Technical Check! ✅`, { side: rules.side, rsi: indicators.rsi });

            // Send Telegram Notification (Signal Found)
            const tradingMode = (await supabaseService.getUserSettings(userId)).trade_mode || 'PAPER';
            await telegramService.sendTradeAlert({
                symbol,
                side: rules.side,
                price: quote.lastTradedPrice,
                action: 'SIGNAL',
                tradeMode: tradingMode,
                indicators: {
                    rsi: indicators.rsi,
                    ema9: indicators.ema9,
                    ema20: indicators.ema20,
                    macd: indicators.macd,
                    trend: indicators.ema9 > indicators.ema20 ? '📈 BULLISH' : '📉 BEARISH'
                }
            });

            if (!settings.auto_trade_on) {
                logger.info(`[SCANNER] Automation OFF for User. Skipping AI Analysis for ${symbol}.`);
                return;
            }

            // RE-CHECK PER-DAY LIMIT
            const todayCount = await supabaseService.getTodayTradeCount(userId);
            if (todayCount >= (settings.daily_trade_limit || 5)) {
                logger.warn(`[SCANNER] Daily trade limit reached. Skipping AI for ${symbol}.`);
                return;
            }

            // AI Analysis
            const aiResult = await this.getAIAnalysis(symbol, quote.lastTradedPrice, indicators);
            if (aiResult.sentiment === 'NEUTRAL' || aiResult.confidenceScore < 70) {
                logger.info(`[SCANNER] AI Analysis weak for ${symbol}: ${aiResult.sentiment} (${aiResult.confidenceScore}). Skipping.`);
                return;
            }

            const risk = this.calculateRisk(quote.lastTradedPrice, aiResult.sentiment);
            
            // NEW: Calculate dynamic quantity based on Risk management
            const quantity = await this.calculateQuantity(userId, quote.lastTradedPrice, risk.sl, tradingMode);

            // Send Telegram Notification (Execution)
            if (quantity > 0) {
                await telegramService.sendTradeAlert({
                    symbol,
                    side: aiResult.sentiment,
                    price: quote.lastTradedPrice,
                    sl: risk.sl,
                    tp: risk.tp,
                    quantity: quantity,
                    confidence: aiResult.confidenceScore,
                    action: 'EXECUTION',
                    tradeMode: tradingMode
                });

                console.log(`[EXECUTION] Placing ${aiResult.sentiment} order for ${symbol} (Qty: ${quantity})... 💰`);
                await this.executeTrade(userId, symbol, quote.symbolToken, aiResult.sentiment, risk, quantity);
            } else {
                console.log(`[EXECUTION SKIPPED] ${symbol} - Insufficient capital for 1 share.`);
            }

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
        const isBuy = side === 'BUY' || side === 'BULLISH';
        const entry = price;
        const sl = isBuy ? price * (1 - slPercent) : price * (1 + slPercent);
        const tp = isBuy ? price * (1 + tpPercent) : price * (1 - tpPercent);
        
        return {
            entry,
            sl,
            tp,
            rr: '1:2'
        };
    }

    async calculateQuantity(userId, entryPrice, slPrice, tradingMode) {
        try {
            // 1. Get Capital
            let capital = 100000; // Default
            if (tradingMode === 'REAL') {
                const balance = await angelOneService.getRMSBalance();
                capital = parseFloat(balance?.net || 0);
            } else {
                capital = await supabaseService.getPaperFunds(userId);
            }

            // 2. Get Risk % from Settings
            const settings = await supabaseService.getUserSettings(userId);
            const riskPct = settings.risk_per_trade || 1; // Default 1% risk

            // 3. Risk Amount in Rupees
            const riskAmt = capital * (riskPct / 100);

            // 4. Stop Loss Distance
            const slDistance = Math.abs(entryPrice - slPrice);

            // 5. Quantity = Risk Amount / SL Distance
            let qty = Math.floor(riskAmt / slDistance);

            console.log(`[QTY CALC] ${userId} | Capital: ${capital} | RiskAmt: ${riskAmt} | SL Dist: ${slDistance} | Final Qty: ${qty}`);

            // Safety check: Don't buy more than total capital / price
            const maxQtyByCapital = Math.floor(capital / entryPrice);
            if (qty > maxQtyByCapital) qty = maxQtyByCapital;

            // If capital is 0 or insufficient for even 1 share, return 0
            return qty > 0 ? qty : 0;
        } catch (error) {
            console.error('[QTY CALC ERROR]:', error.message);
            return 1;
        }
    }

    async executeTrade(userId, symbol, token, side, risk, quantity = 1) {
        try {
            logger.info(`[EXECUTION START] Processing ${side} for ${symbol} (Qty: ${quantity})...`);
            
            const settings = await supabaseService.getUserSettings(userId);
            const tradingType = settings.trade_mode || 'PAPER';

            if (tradingType === 'REAL') {
                logger.info(`[ANGEL ONE] Placing REAL order for ${symbol}...`);
                await angelOneService.placeOrder(symbol, token, quantity, side, 'LIMIT', risk.entry);
            }
            
            logger.info(`[DATABASE] Saving ${tradingType} trade to Supabase...`);
            await supabaseService.saveTrade({
                user_id: userId,
                symbol,
                symbolToken: token,
                type: side,
                quantity: quantity,
                entry_price: risk.entry,
                stop_loss: risk.sl,
                take_profit: risk.tp,
                status: 'OPEN',
                trading_type: tradingType,
                trade_mode: 'BOT'
            });
            logger.success(`[DATABASE] Trade saved successfully for ${symbol}! ✅`);

            // Notify UI
            if (global.io) {
                logger.info(`[WEBSOCKET] Broadcasting UI Refresh...`);
                global.io.emit('trade-executed', { symbol, mode: 'BOT' });
            }

            logger.success(`[EXECUTION COMPLETE] ${symbol} is now LIVE on Dashboard! 🚀`);
        } catch (error) {
            logger.error(`[EXECUTION FATAL ERROR] ${symbol}: ${error.message}`);
            throw error; 
        }
    }

    /**
     * MONITOR OPEN POSITIONS (Auto-Exit SL/TP)
     */
    async monitorExits() {
        try {
            const { data: openTrades, error } = await supabaseService.supabase
                .from('trades')
                .select('*')
                .eq('status', 'OPEN');

            if (error || !openTrades || openTrades.length === 0) return;

            console.log(`[MONITOR] Checking ${openTrades.length} open positions... 🔍`);

            for (const trade of openTrades) {
                try {
                    const quote = await angelOneService.getQuote(trade.symbol);
                    if (!quote) continue;

                    const ltp = quote.lastTradedPrice;
                    let shouldClose = false;
                    let exitReason = '';

                    if (trade.type === 'BUY') {
                        if (ltp <= trade.stop_loss) { shouldClose = true; exitReason = 'SL'; }
                        else if (ltp >= trade.take_profit) { shouldClose = true; exitReason = 'TP'; }
                    } else if (trade.type === 'SELL') {
                        if (ltp >= trade.stop_loss) { shouldClose = true; exitReason = 'SL'; }
                        else if (ltp <= trade.take_profit) { shouldClose = true; exitReason = 'TP'; }
                    }

                    if (shouldClose) {
                        console.log(`[MONITOR] ${trade.symbol} Hit ${exitReason}! Closing position at ₹${ltp}... 🚪`);

                        // 1. REAL MODE → Place actual exit order on Angel One
                        if (trade.trading_type === 'REAL') {
                            try {
                                // Exit side is opposite of entry
                                // BUY trade exit = SELL order | SELL trade exit = BUY order
                                const exitSide = trade.type === 'BUY' ? 'SELL' : 'BUY';
                                logger.info(`[ANGEL EXIT] Placing REAL ${exitSide} exit order for ${trade.symbol} @ ₹${ltp}...`);
                                await angelOneService.placeOrder(
                                    trade.symbol,
                                    trade.symbolToken,
                                    trade.quantity || 1,
                                    exitSide,
                                    'MARKET', // Market order for instant exit
                                    0         // Price = 0 for MARKET orders
                                );
                                logger.success(`[ANGEL EXIT] Real exit order placed for ${trade.symbol}! ✅`);
                            } catch (exitErr) {
                                logger.error(`[ANGEL EXIT] Failed to place exit order for ${trade.symbol}: ${exitErr.message}`);
                                // Still close in DB even if Angel One fails (manual fallback)
                            }
                        }

                        // 2. Mark as CLOSED in DB
                        await supabaseService.supabase
                            .from('trades')
                            .update({ 
                                status: 'CLOSED', 
                                exit_price: ltp,
                                closed_at: new Date().toISOString()
                            })
                            .eq('id', trade.id);

                        // 3. Credit back to Wallet (Paper mode only)
                        if (trade.trading_type === 'PAPER') {
                            const originalCost = trade.entry_price * (trade.quantity || 1);
                            const isBuy = trade.type === 'BUY';
                            const pnl = isBuy ? (ltp - trade.entry_price) : (trade.entry_price - ltp);
                            const creditAmount = originalCost + pnl;
                            await supabaseService.creditPaperFunds(trade.user_id, creditAmount);
                            logger.info(`[MONITOR] Credited ₹${creditAmount.toFixed(2)} to paper wallet for ${trade.symbol}`);
                        }

                        // 4. Notify UI & Telegram
                        if (global.io) global.io.emit('trade-executed', { symbol: trade.symbol, mode: 'EXIT', reason: exitReason });
                        
                        const telegramService = require('./telegramService');
                        const pnlVal = trade.type === 'BUY' ? (ltp - trade.entry_price) : (trade.entry_price - ltp);
                        await telegramService.sendTradeAlert({
                            symbol: trade.symbol,
                            side: trade.type,
                            price: ltp,
                            action: `EXIT (${exitReason})`,
                            exitReason: exitReason === 'SL' ? 'Stop Loss' : 'Take Profit',
                            pnl: pnlVal,
                            entryPrice: trade.entry_price,
                            tradeMode: trade.trading_type || 'PAPER'
                        });
                        logger.success(`[MONITOR] ${trade.symbol} EXIT complete. P&L: ₹${pnlVal.toFixed(2)} | Reason: ${exitReason}`);
                    }
                } catch (e) {
                    console.error(`[MONITOR ERROR] ${trade.symbol}:`, e.message);
                }
            }
        } catch (error) {
            console.error('[MONITOR ENGINE ERROR]:', error.message);
        }
    }
}

const scanner = new ScannerService();
// Start Exit Monitor every 30 seconds
setInterval(() => scanner.monitorExits(), 30000);

module.exports = scanner;
