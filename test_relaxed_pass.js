const angelOneService = require('./angelOneService');
const ta = require('./technicalAnalysis');
const supabaseService = require('./supabaseService');

async function testRelaxedSignals() {
    const userId = '00000000-0000-0000-0000-000000000000';
    
    console.log('--- TESTING RELAXED MODE SIGNALS 🎯 ---');
    
    try {
        await angelOneService.loadSymbolMaster();
        
        const wl = await supabaseService.getUserWatchlist(userId);
        const symbols = wl.length > 0 ? wl.map(s => s.symbol) : ['RELIANCE-EQ', 'SBIN-EQ', 'INFY-EQ', 'TATAPOWER-EQ', 'IOC-EQ'];
        
        console.log(`Analyzing ${symbols.length} symbols in RELAXED mode...`);
        
        const passedSymbols = [];

        for (const symbol of symbols) {
            try {
                const quote = await angelOneService.getQuote(symbol);
                const candles = await angelOneService.getCandleData(symbol, 'FIVE_MINUTE', 10); // Get more candles for MACD
                
                if (!quote || !candles || candles.length < 5) {
                    continue;
                }

                const indicators = {
                    ema9: ta.calculateEMA(candles, 9),
                    ema20: ta.calculateEMA(candles, 20),
                    ema50: ta.calculateEMA(candles, 50),
                    rsi: ta.calculateRSI(candles),
                    macd: ta.calculateMACD(candles), // Fixed: Added MACD
                    volume: quote.volume || candles[candles.length - 1][5],
                    avgVolume: ta.calculateAvgVolume(candles, 20),
                    candles: candles
                };

                const rules = ta.checkRules(indicators, 'RELAXED');
                
                if (rules.pass) {
                    passedSymbols.push({
                        Symbol: symbol,
                        LTP: quote.lastTradedPrice,
                        RSI: indicators.rsi.toFixed(2),
                        Trend: indicators.ema9 > indicators.ema20 ? 'UP' : 'DOWN',
                        Status: '✅ PASS'
                    });
                }
                
                await new Promise(r => setTimeout(r, 300));

            } catch (e) {}
        }

        console.log('\n--- RELAXED MODE PASS RESULTS ---');
        if (passedSymbols.length > 0) {
            console.table(passedSymbols);
            console.log(`\nTotal Signals Found: ${passedSymbols.length}`);
        } else {
            console.log('Market conditions match pannala. Currently no signals in Relaxed mode.');
        }

    } catch (error) {
        console.error('Test Failed:', error.message);
    }
}

testRelaxedSignals();
