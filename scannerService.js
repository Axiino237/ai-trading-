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
        this.broadcasterInterval = 15 * 1000; // 15 sec price update
        this.marketOpenTime = "09:15";
        this.marketCloseTime = "15:30";
    }

    isMarketOpen() {
        const now = new Date();
        const day = now.getDay();
        const time = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');

        // Monday to Friday only
        if (day === 0 || day === 6) return false;
        
        // Between 9:15 and 15:30
        return time >= this.marketOpenTime && time <= this.marketCloseTime;
    }

    start() {
        console.log('[ENTERPRISE] AI Rule Engine Started... 🚀');
        this.safeScan();
        this.startBroadcaster();
        this.startSquareOffMonitor(); // Day end square-off check
    }

    startSquareOffMonitor() {
        const run = async () => {
            try {
                await this.checkAutoSquareOff();
            } catch (e) {
                console.error('[SQUARE-OFF MONITOR ERROR]:', e.message);
            }
            // Check every minute
            setTimeout(run, 60000);
        };
        run();
    }

    startBroadcaster() {
        const run = async () => {
            try {
                const defaultSymbols = ['RELIANCE-EQ', 'TATASTEEL-EQ', 'SBIN-EQ', 'HDFCBANK-EQ', 'INFY-EQ'];
                
                const userSymbols = await supabaseService.getAllWatchlistSymbols();

                const symbols = [...new Set([...defaultSymbols, ...userSymbols])];
                const quotes = await angelOneService.getMultipleQuotes(symbols);
                
                for (const quote of quotes) {
                    if (global.io) {
                        global.io.emit('symbol-status', {
                            symbol: quote.tradingSymbol, 
                            price: quote.lastTradedPrice,
                            change: (quote.pChange || quote.percentChange || (quote.close ? ((quote.ltp - quote.close) / quote.close * 100).toFixed(2) : '0')) + '%'
                        });
                    }
                }
            } catch (e) {
                console.error('[BROADCASTER ERROR]:', e.message);
            }
            // Recursive call for safety instead of setInterval
            setTimeout(run, this.broadcasterInterval);
        };
        run();
    }

    async safeScan() {
        if (this.isMarketOpen()) {
            await this.scan();
        } else {
            console.log(`[SCANNER] Market is CLOSED (${new Date().toLocaleTimeString()}). Sleeping... 😴`);
        }
        setTimeout(() => this.safeScan(), this.interval);
    }

    async scan() {
        if (this.isScanning) return;
        this.isScanning = true;

        try {
            const users = await supabaseService.getAutoEnabledUsers();
            if (users.length === 0) {
                logger.info('[SCANNER] No auto-trading users found. Skipping scan cycle.');
                return;
            }

            // 1. COLLECT ALL UNIQUE SYMBOLS ACROSS ALL USERS
            const allSymbolsSet = new Set();
            const userWatchlists = {}; // userId -> symbols[]

            for (const user of users) {
                const watchlist = await supabaseService.getUserWatchlist(user.user_id);
                const symbols = (watchlist || []).map(item => item.symbol);
                userWatchlists[user.user_id] = symbols;
                symbols.forEach(s => allSymbolsSet.add(s));
            }

            const uniqueSymbols = Array.from(allSymbolsSet);
            if (uniqueSymbols.length === 0) {
                logger.info('[SCANNER] Total watchlist is empty across all users.');
                return;
            }

            logger.info(`[SCANNER] Batch Scanning ${uniqueSymbols.length} unique symbols for ${users.length} users...`);

            // 2. FETCH ALL QUOTES IN ONE BATCH CALL
            const quotesArray = await angelOneService.getMultipleQuotes(uniqueSymbols);
            const quotesMap = new Map();
            (quotesArray || []).forEach(q => quotesMap.set(q.tradingSymbol, q));

            // 3. CACHE FOR INDICATORS (Computed once per symbol per scan)
            const indicatorCache = new Map();

            // 4. PROCESS EACH USER INDIVIDUALLY (Personal Risk Logic)
            for (const user of users) {
                const userId = user.user_id;
                const todayCount = await supabaseService.getTodayTradeCount(userId);
                
                // ENFORCE PLAN LIMITS (Gating Logic)
                const planLimit = user.plan_tier === 'PRO' ? 100 : 5;
                // If ADMIN, follow their settings exactly. If USER, cap settings by plan limit.
                const currentLimit = user.role === 'ADMIN' 
                    ? (user.max_trades_per_day || 999) 
                    : Math.min(user.max_trades_per_day || 5, planLimit);

                if (todayCount >= currentLimit) {
                    logger.info(`[SCANNER] User ${userId} (${user.role}/${user.plan_tier}) reached limit (${todayCount}/${currentLimit}). skipping.`, { userId });
                    continue;
                }

                const symbols = userWatchlists[userId] || [];
                for (const sym of symbols) {
                    const quote = quotesMap.get(sym);
                    if (!quote) continue;

                    // Fetch or compute indicators (using cache)
                    let indicators = indicatorCache.get(sym);
                    if (!indicators) {
                        const candles = await angelOneService.getCandleData(sym, 'FIVE_MINUTE', 5);
                        if (candles && candles.length > 0) {
                            indicators = {
                                ema9: ta.calculateEMA(candles, 9),
                                ema20: ta.calculateEMA(candles, 20),
                                ema50: ta.calculateEMA(candles, 50),
                                rsi: ta.calculateRSI(candles),
                                macd: ta.calculateMACD(candles),
                                volume: quote.volume || candles[candles.length - 1][5],
                                avgVolume: ta.calculateAvgVolume(candles, 20),
                                candles: candles
                            };
                            indicatorCache.set(sym, indicators);
                        }
                    }

                    if (indicators) {
                        // Pass quote and indicators to processEnterpriseFlow
                        await this.processEnterpriseFlow(sym, userId, quote, indicators);
                    }
                    
                    // Small delay to prevent CPU spikes
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        } catch (error) {
            console.error('[SCANNER] Fatal Error during batch scan:', error.message);
        } finally {
            this.isScanning = false;
        }
    }


    async processEnterpriseFlow(symbol, userId, quote, indicators) {
        try {
            if (!quote || !indicators) return;

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
                const trend = indicators.ema9 > indicators.ema20 ? 'UP' : 'DOWN';
                
                if (indicators.rsi > 70) reasons.push('Overbought (RSI > 70)');
                if (indicators.rsi < 30) reasons.push('Oversold (RSI < 30)');
                if (trend === 'DOWN') reasons.push('Bearish Trend (EMA9 < EMA20)');
                if (trend === 'UP') reasons.push('Bullish Trend (EMA9 > EMA20)');
                
                logger.info(`[SCANNER] ${symbol} Rejected: No valid BUY or SELL setup.`, { reasons, userId, symbol });
                return;
            }

            logger.success(`[SCANNER] ${symbol} PASSED Technical Check! ✅`, { side: rules.side, rsi: indicators.rsi, userId, symbol });


            if (!settings.auto_trade_on) {
                logger.info(`[SCANNER] Automation OFF for User. Skipping AI Analysis for ${symbol}.`, { userId, symbol });
                return;
            }

            const tradingMode = settings.trade_mode || 'PAPER';

            // RE-CHECK PER-DAY LIMIT
            const todayCount = await supabaseService.getTodayTradeCount(userId);
            const planLimit = settings.plan_tier === 'PRO' ? 100 : 5;
            const currentLimit = settings.role === 'ADMIN' 
                ? (settings.daily_trade_limit || 999) 
                : Math.min(settings.daily_trade_limit || 5, planLimit);

            if (todayCount >= currentLimit) {
                logger.warn(`[SCANNER] ${symbol} limit reached (${todayCount}/${currentLimit}). Skipping.`, { userId, symbol });
                return;
            }
            
            const isLimitBypassed = settings.role === 'ADMIN'; // For utilization check below
            // PRE-AI CAPACITY CHECK (Cost Optimization)
            const investedCapital = await supabaseService.getInvestedCapital(userId, tradingMode);
            const totalFundsAvailable = (tradingMode === 'REAL') 
                ? parseFloat((await angelOneService.getRMSBalance())?.net || 0)
                : await supabaseService.getPaperFunds(userId);
            
            const totalCapacity = totalFundsAvailable + investedCapital;
            const maxUtilization = settings.max_utilization_pct || 60;
            const currentUtilPct = totalCapacity > 0 ? (investedCapital / totalCapacity) * 100 : 0;

            if (!isLimitBypassed && currentUtilPct >= maxUtilization) {
                // EXCEPTION: Only proceed to AI if the technical setup is extremely strong (STRICT)
                const strictCheck = ta.checkRules(indicators, 'STRICT');
                if (!strictCheck.pass) {
                    logger.info(`[SCANNER] ${symbol} Utilization at ${currentUtilPct.toFixed(1)}%. Skipping AI as setup is not 'STRICT' quality.`, { userId, symbol });
                    return;
                }
                logger.info(`[SCANNER] ${symbol} Utilization at ${currentUtilPct.toFixed(1)}%, but setup is STRICT quality. Proceeding to AI for high-probability check.`, { userId, symbol });
            }

            // AI Analysis
            const aiResult = await this.getAIAnalysis({ 
                symbol, 
                price: quote.lastTradedPrice, 
                indicators, 
                smartMode: settings.smart_mode 
            });
            
            // Check configurable confidence threshold
            const confidenceThreshold = settings.ai_confidence_threshold || 70;
            if (aiResult.sentiment === 'NEUTRAL' || aiResult.confidenceScore < confidenceThreshold) {
                logger.info(`[SCANNER] AI Analysis weak for ${symbol}: ${aiResult.sentiment} (${aiResult.confidenceScore} < ${confidenceThreshold}). Skipping.`, { userId, symbol });
                return;
            }

            // NEW: Determine Trade Type (SHORT vs LONG) based on current ratio
            const counts = await supabaseService.getTradeTypeCounts(userId);
            const totalActive = counts.SHORT_TERM + counts.LONG_TERM;
            const targetShortRatio = settings.short_term_ratio || 70;
            
            let holdingType = 'SHORT_TERM';
            if (totalActive > 0) {
                const currentShortRatio = (counts.SHORT_TERM / totalActive) * 100;
                if (currentShortRatio > targetShortRatio) {
                    holdingType = 'LONG_TERM';
                }
            }
            
            logger.info(`[SCANNER] Selected Holding Type: ${holdingType} (Current Short Ratio: ${totalActive === 0 ? 100 : (counts.SHORT_TERM/totalActive*100).toFixed(1)}%)`);

            const risk = this.calculateRisk(quote.lastTradedPrice, aiResult.sentiment);
            
            // NEW: Calculate dynamic quantity based on Advanced Risk management
            const quantity = await this.calculateQuantity(userId, quote.lastTradedPrice, risk.sl, tradingMode);

            // Fetch per-user credentials
            const creds = await supabaseService.getBrokerCredentials(userId);

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
                    tradeMode: tradingMode,
                    holdingType: holdingType,
                    expectedDuration: aiResult.suggestedHolding || 'N/A'
                }, creds);

                console.log(`[EXECUTION] Placing ${aiResult.sentiment} order for ${symbol} (Qty: ${quantity})... 💰`);
                await this.executeTrade(userId, symbol, quote.symbolToken, aiResult.sentiment, risk, quantity, holdingType, aiResult.suggestedHolding, creds);
            } else {
                console.log(`[EXECUTION SKIPPED] ${symbol} - Insufficient capital or risk limit reached.`);
            }

        } catch (error) {
            console.error(`[FLOW ERROR] ${symbol}:`, error.message);
        }
    }

    async getAIAnalysis({ symbol, price, indicators, smartMode = false }) {
        const trend = indicators.ema9 > indicators.ema50 ? 'BULLISH' : 'BEARISH';
        
        // ELITE PROMPT (Only for Smart Mode)
        if (smartMode) {
            const candleSummary = indicators.candles.slice(-5).map(c => `[O:${c[1]}, H:${c[2]}, L:${c[3]}, C:${c[4]}, V:${c[5]}]`).join(' | ');
            const elitePrompt = `
                You are an Elite Institutional Algorithmic Trader. Identify high-probability setups.
                SYMBOL: ${symbol} @ ₹${price}
                EMA Trend: ${trend} | RSI: ${indicators.rsi.toFixed(2)} | MACD: ${indicators.macd.histogram.toFixed(2)}
                LAST 5 CANDLES: ${candleSummary}
                RULES: BUY if Price>EMA9, MACD increasing, RSI 40-70. SELL if Price<EMA9, MACD decreasing, RSI 30-60.
                OUTPUT JSON: {"sentiment": "BUY"|"SELL"|"NEUTRAL", "confidenceScore": 0-100, "reasoning": "...", "sl": price, "tp": price, "holdingType": "SHORT_TERM"}
            `;
            return await this.executeAI(elitePrompt, price);
        }

        // STANDARD PROMPT (Fallback)
        const standardPrompt = `
            Analyze ${symbol} at ₹${price}. 
            Trend: ${trend}, RSI: ${indicators.rsi.toFixed(2)}, MACD: ${indicators.macd.histogram.toFixed(2)}.
            Suggest BUY, SELL, or NEUTRAL.
            OUTPUT JSON: {"sentiment": "BUY"|"SELL"|"NEUTRAL", "confidenceScore": 0-100, "reasoning": "...", "holdingType": "SHORT_TERM"}
        `;
        return await this.executeAI(standardPrompt, price);
    }

    async executeAI(prompt, price) {
        try {
            const text = await geminiService.generateAnalysis(prompt);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('AI failed to return valid JSON');
            const result = JSON.parse(jsonMatch[0]);
            
            if (!result.sl || !result.tp) {
                const risk = this.calculateRisk(price, result.sentiment);
                result.sl = result.sl || risk.sl;
                result.tp = result.tp || risk.tp;
            }
            return result;
        } catch (e) {
            console.error('[AI ERROR]:', e.message);
            return { sentiment: 'NEUTRAL', confidenceScore: 0, reasoning: 'AI Offline' };
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
            // 1. Get Capital & Settings
            let capital = 100000; // Default
            if (tradingMode === 'REAL') {
                const balance = await angelOneService.getRMSBalance();
                capital = parseFloat(balance?.net || 0);
            } else {
                capital = await supabaseService.getPaperFunds(userId);
            }

            const settings = await supabaseService.getUserSettings(userId);
            
            // 2. UTILIZATION CHECK (60% Rule)
            const maxUtilization = settings.max_utilization_pct || 60;
            const investedCapital = await supabaseService.getInvestedCapital(userId, tradingMode);
            const totalCapacity = capital + investedCapital; // Total capital including current value
            const maxAllowedToInvest = totalCapacity * (maxUtilization / 100);
            
            if (investedCapital >= maxAllowedToInvest) {
                logger.warn(`[RISK] Max Utilization reached (${((investedCapital/totalCapacity)*100).toFixed(1)}% / ${maxUtilization}%). No new trades.`);
                return 0;
            }

            // 3. PER-STOCK LIMIT (10-20% Rule)
            const minAllocPct = settings.min_allocation_pct || 10;
            const maxAllocPct = settings.max_allocation_pct || 20;
            
            // Target roughly middle of min/max or just min
            const targetAllocAmt = totalCapacity * (maxAllocPct / 100);
            
            // 4. RISK PER TRADE (Standard SL based calculation)
            const riskPct = settings.risk_per_trade || 1; 
            const riskAmt = totalCapacity * (riskPct / 100);
            const slDistance = Math.abs(entryPrice - slPrice);

            // Calculation A: Quantity by Risk
            let qtyByRisk = Math.floor(riskAmt / slDistance);

            // Calculation B: Quantity by Allocation Limit
            let qtyByAlloc = Math.floor(targetAllocAmt / entryPrice);

            // 5. ABSOLUTE CASH LIMIT (Safety Net)
            const availableCash = capital;
            const maxQtyByCash = Math.floor(availableCash / entryPrice);
            
            // Final Qty is the lowest of all three logic paths
            let qty = Math.min(qtyByRisk, qtyByAlloc, maxQtyByCash);

            // Safety check: Cannot exceed remaining allowed utilization
            const remainingUtil = maxAllowedToInvest - investedCapital;
            const maxQtyByUtil = Math.floor(remainingUtil / entryPrice);
            if (qty > maxQtyByUtil) qty = maxQtyByUtil;

            // Safety check: Ensure it doesn't exceed available cash (Double Check)
            if (qty * entryPrice > availableCash) {
                qty = Math.floor(availableCash / entryPrice);
            }

            // Safety check: Ensure it meets MIN allocation (10%)
            const minAllocAmt = totalCapacity * (minAllocPct / 100);
            if (qty * entryPrice < minAllocAmt) {
                // If the suggested qty is too low, we try to bump it to min allocation 
                // BUT only if we have enough cash
                const qtyToMeetMin = Math.ceil(minAllocAmt / entryPrice);
                if (qtyToMeetMin * entryPrice <= availableCash && qtyToMeetMin * entryPrice <= remainingUtil) {
                    qty = qtyToMeetMin;
                    logger.info(`[QTY] Bumping to min allocation: ${qty} shares (₹${(qty*entryPrice).toFixed(2)})`, { userId });
                } else {
                    // If we can't meet min allocation with available cash, we just use whatever we can OR skip
                    const maxPossible = Math.floor(Math.min(availableCash, remainingUtil) / entryPrice);
                    if (maxPossible > 0) {
                        qty = maxPossible;
                        logger.warn(`[QTY] Using reduced qty ${qty} (₹${(qty*entryPrice).toFixed(2)}) as min allocation cannot be met.`, { userId });
                    } else {
                        logger.warn(`[QTY] Cannot meet min allocation and insufficient cash. Skipping.`, { userId });
                        return 0;
                    }
                }
            }

            console.log(`[QTY CALC] ${userId} | TotalCap: ${totalCapacity.toFixed(0)} | RiskAmt: ${riskAmt.toFixed(0)} | TargetAlloc: ${targetAllocAmt.toFixed(0)} | Final Qty: ${qty}`);

            return qty > 0 ? qty : 0;
        } catch (error) {
            console.error('[QTY CALC ERROR]:', error.message);
            return 0;
        }
    }

    async executeTrade(userId, symbol, token, side, risk, quantity = 1, holdingType = 'SHORT_TERM', duration = null, creds = null) {
        let tradeRecord = null;
        const settings = await supabaseService.getUserSettings(userId);
        const tradingType = settings.trade_mode || 'PAPER';

        try {
            logger.info(`[EXECUTION START] Processing ${side} for ${symbol} (Qty: ${quantity}, Mode: ${tradingType})...`);
            
            const productType = side === 'SELL' ? 'INTRADAY' : 'CARRYFORWARD';
            const orderType = settings.order_type || 'LIMIT';

            logger.info(`[DATABASE] Creating ${tradingType} trade record...`);
            const dbResult = await supabaseService.saveTrade({
                user_id: userId,
                symbol,
                symbolToken: token,
                type: side,
                quantity: quantity,
                entry_price: risk.entry,
                stop_loss: risk.sl,
                take_profit: risk.tp,
                trading_type: tradingType,
                trade_mode: 'BOT',
                holding_type: holdingType,
                expected_duration: duration,
                product_type: productType
            });
            
            tradeRecord = dbResult.data?.[0];

            // 2. If REAL mode, execute on Broker
            if (tradingType === 'REAL') {
                try {
                    logger.info(`[ANGEL ONE] Placing REAL order for ${symbol}...`);
                    if (!creds || !creds.api_key) {
                        throw new Error('Broker credentials not configured for this user.');
                    }
                    const orderRes = await angelOneService.placeUserOrder(creds, symbol, token, quantity, side, orderType, risk.entry, productType);
                    
                    if (!orderRes.status) {
                        throw new Error(orderRes.message || 'Broker order rejected');
                    }
                    logger.success(`[ANGEL ONE] Order success: ${orderRes.data?.orderid}`);
                } catch (brokerError) {
                    logger.error(`[EXECUTION FAILED] Broker rejected order: ${brokerError.message}`);
                    
                    // Update DB record to FAILED if it was created
                    if (tradeRecord?.id) {
                        await supabaseService.supabase
                            .from('trades')
                            .update({ status: 'FAILED', message: brokerError.message })
                            .eq('id', tradeRecord.id);
                    }
                    throw brokerError;
                }
            }
            
            logger.success(`[DATABASE] Trade sequence complete for ${symbol}! ✅`);

            // 3. Notify UI
            if (global.io) {
                global.io.emit('trade-executed', { symbol, mode: 'BOT', userId });
            }

            logger.success(`[EXECUTION COMPLETE] ${symbol} is now LIVE on Dashboard! 🚀`);
        } catch (error) {
            logger.error(`[EXECUTION FATAL ERROR] ${symbol}: ${error.message}`);
            // Re-throw to handle higher up if needed
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

                    // 1. Fetch User Settings to check for Smart Mode
                    const userSettings = await supabaseService.getUserSettings(trade.user_id);

                    // 2. TRAILING STOP LOSS (Only in SMART MODE)
                    if (userSettings.smart_mode) {
                        const profitPct = trade.type === 'BUY' 
                            ? (ltp - trade.entry_price) / trade.entry_price * 100
                            : (trade.entry_price - ltp) / trade.entry_price * 100;

                        if (profitPct >= 2.0) {
                            const isSlAtEntry = trade.type === 'BUY' 
                                ? trade.stop_loss >= trade.entry_price
                                : trade.stop_loss <= trade.entry_price;

                            if (!isSlAtEntry) {
                                console.log(`[MONITOR] ${trade.symbol} in 2% profit (Smart Mode). Trailing SL to Entry Price... 🛡️`);
                                await supabaseService.supabase
                                    .from('trades')
                                    .update({ stop_loss: trade.entry_price })
                                    .eq('id', trade.id);
                                trade.stop_loss = trade.entry_price; 
                            }
                        }
                    }

                    if (trade.type === 'BUY') {
                        if (ltp <= trade.stop_loss) { shouldClose = true; exitReason = 'SL'; }
                        else if (ltp >= trade.take_profit) { shouldClose = true; exitReason = 'TP'; }
                    } else if (trade.type === 'SELL') {
                        if (ltp >= trade.stop_loss) { shouldClose = true; exitReason = 'SL'; }
                        else if (ltp <= trade.take_profit) { shouldClose = true; exitReason = 'TP'; }
                    }

                    if (shouldClose) {
                        console.log(`[MONITOR] ${trade.symbol} Hit ${exitReason}! Closing position at ₹${ltp}... 🚪`);

                        const creds = await supabaseService.getBrokerCredentials(trade.user_id);

                        // 1. REAL MODE → Place actual exit order on Angel One
                        if (trade.side === 'REAL') {
                            try {
                                // Exit side is opposite of entry
                                // BUY trade exit = SELL order | SELL trade exit = BUY order
                                const exitSide = trade.type === 'BUY' ? 'SELL' : 'BUY';
                                // Determine product type to square off correctly
                                const originalProductType = trade.product_type || (trade.type === 'SELL' ? 'INTRADAY' : 'CARRYFORWARD');
                                
                                logger.info(`[ANGEL EXIT] Placing REAL ${exitSide} exit order for ${trade.symbol} @ ₹${ltp} (${originalProductType})...`);
                                
                                if (!creds || !creds.api_key) {
                                    throw new Error('Broker credentials not configured for this user.');
                                }

                                await angelOneService.placeUserOrder(
                                    creds,
                                    trade.symbol,
                                    trade.symbolToken,
                                    trade.quantity || 1,
                                    exitSide,
                                    'MARKET', 
                                    0,
                                    originalProductType
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
                        if (trade.side === 'PAPER') {
                            const qty = trade.quantity || 1;
                            const originalCost = trade.entry_price * qty;
                            const isBuy = trade.type === 'BUY';
                            const pnl = isBuy ? (ltp - trade.entry_price) * qty : (trade.entry_price - ltp) * qty;
                            const creditAmount = originalCost + pnl;
                            await supabaseService.creditPaperFunds(trade.user_id, creditAmount, 'TRADE_EXIT', trade.id);
                            logger.info(`[MONITOR] Credited ₹${creditAmount.toFixed(2)} to paper wallet for ${trade.symbol}`);
                        }

                        // 4. Notify UI & Telegram
                        if (global.io) global.io.emit('trade-executed', { symbol: trade.symbol, mode: 'EXIT', reason: exitReason, userId: trade.user_id });
                        
                        const telegramService = require('./telegramService');
                        const qty = trade.quantity || 1;
                        const pnlVal = trade.type === 'BUY' ? (ltp - trade.entry_price) * qty : (trade.entry_price - ltp) * qty;
                        await telegramService.sendTradeAlert({
                            symbol: trade.symbol,
                            side: trade.type,
                            price: ltp,
                            action: `EXIT (${exitReason})`,
                            exitReason: exitReason === 'SL' ? 'Stop Loss' : 'Take Profit',
                            pnl: pnlVal,
                            entryPrice: trade.entry_price,
                            tradeMode: trade.side || 'PAPER'
                        }, creds);
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

    /**
     * Day-End Square-off (3:15 PM IST)
     * Closes all INTRADAY positions automatically
     */
    async checkAutoSquareOff() {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // 1. Check if already squared off today
        const lastRun = await supabaseService.getSystemState('last_square_off_date');
        if (lastRun === today) return;

        const istTime = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
        const timeParts = istTime.split(', ')[1];
        if (!timeParts) return;
        
        const [hour, minute] = timeParts.split(':').map(Number);
        const currentTime = hour * 60 + minute;
        
        const squareOffStartTime = 15 * 60 + 15; // 3:15 PM

        if (currentTime >= squareOffStartTime) {
            console.log(`[SQUARE-OFF] Market closing soon/closed. Running Daily Auto Square-off... ⏰`);
            
            const { data: openIntradayTrades } = await supabaseService.supabase
                .from('trades')
                .select('*')
                .eq('status', 'OPEN')
                .eq('product_type', 'INTRADAY');

            if (openIntradayTrades && openIntradayTrades.length > 0) {
                for (const trade of openIntradayTrades) {
                    console.log(`[SQUARE-OFF] Force closing INTRADAY: ${trade.symbol}...`);
                    try {
                        const quote = await angelOneService.getQuote(trade.symbol);
                        const ltp = quote?.lastTradedPrice || trade.entry_price;
                        const creds = await supabaseService.getBrokerCredentials(trade.user_id);

                        if (trade.side === 'REAL' && creds) {
                            const exitSide = trade.type === 'BUY' ? 'SELL' : 'BUY';
                            await angelOneService.placeUserOrder(
                                creds, trade.symbol, trade.symbolToken, trade.quantity,
                                exitSide, 'MARKET', 0, trade.product_type
                            );
                        }
                        await supabaseService.closeTrade(trade.id, ltp, 'AUTO_SQUARE_OFF');
                    } catch (e) {
                        console.error(`[SQUARE-OFF ERROR] Failed for ${trade.symbol}:`, e.message);
                    }
                }
            }

            // Mark as done for today
            await supabaseService.setSystemState('last_square_off_date', today);
            console.log(`[SQUARE-OFF] Completed for ${today} ✅`);
        }
    }
}

const scanner = new ScannerService();
// Start Exit Monitor every 30 seconds
setInterval(() => scanner.monitorExits(), 30000);

module.exports = scanner;
