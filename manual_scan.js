const angelOneService = require('./angelOneService');
const supabaseService = require('./supabaseService');
const ta = require('./technicalAnalysis');
require('dotenv').config();

async function manualScan() {
    console.log('--- MANUAL TECHNICAL SCAN START ---');
    try {
        const MOCK_USER_ID = '00000000-0000-0000-0000-000000000000';
        const watchlist = await supabaseService.getUserWatchlist(MOCK_USER_ID);
        const symbols = watchlist.map(w => w.symbol);
        
        console.log(`Analyzing ${symbols.length} symbols: ${symbols.join(', ')}`);
        
        const quotes = await angelOneService.getMultipleQuotes(symbols);
        
        for (const symbol of symbols) {
            const quote = quotes.find(q => q.tradingSymbol === symbol);
            if (!quote) continue;

            // Fetch enough candles for EMAs and RSI
            const candles = await angelOneService.getCandleData(symbol, 'FIVE_MINUTE', 60);
            if (!candles || candles.length < 50) continue;

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
            
            console.log(`\n[${symbol}] Price: ₹${quote.lastTradedPrice}`);
            console.log(`RSI: ${indicators.rsi.toFixed(2)} | EMA9: ${indicators.ema9.toFixed(2)} | EMA20: ${indicators.ema20.toFixed(2)}`);
            console.log(`Trend: ${indicators.ema9 > indicators.ema20 ? 'UP' : 'DOWN'} | Vol: ${indicators.volume} | AvgVol: ${indicators.avgVolume.toFixed(0)}`);
            console.log(`STATUS: ${rules.pass ? '✅ PASS (CRITERIA MET)' : '❌ FAIL'}`);
            
            if (!rules.pass) {
                const d = rules.details;
                console.log(`REASON: ${!d.trendBullish ? 'Trend Not Bullish, ' : ''}${!d.macdBullish ? 'MACD Negative, ' : ''}${!d.rsiValid ? 'RSI Out of Range, ' : ''}${!d.volumeBreakout ? 'No Volume Breakout, ' : ''}${!d.patternConfirmed ? 'No Hammer/Engulfing' : ''}`);
            }
        }
    } catch (e) {
        console.error('Scan Error:', e.message);
    }
    console.log('\n--- MANUAL SCAN END ---');
}

manualScan();
