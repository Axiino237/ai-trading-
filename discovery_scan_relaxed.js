const angelOneService = require('./angelOneService');
const ta = require('./technicalAnalysis');
require('dotenv').config();

async function discoveryScanRelaxed() {
    const symbols = [
        'ADANIENT-EQ', 'BHARTIARTL-EQ', 'COALINDIA-EQ', 'MARUTI-EQ', 'SUNPHARMA-EQ',
        'ULTRACEMCO-EQ', 'NTPC-EQ', 'ASIANPAINT-EQ', 'M&M-EQ', 'HINDUNILVR-EQ',
        'ICICIBANK-EQ', 'INFY-EQ', 'LT-EQ', 'BAJFINANCE-EQ', 'ADANIPORTS-EQ',
        'GRASIM-EQ', 'HEROMOTOCO-EQ', 'JSWSTEEL-EQ', 'NESTLEIND-EQ', 'ONGC-EQ'
    ];

    console.log('--- RELAXED DISCOVERY SCAN START ---');
    console.log(`Scanning ${symbols.length} symbols with AGGRESSIVE mode...\n`);

    try {
        const quotes = await angelOneService.getMultipleQuotes(symbols);
        
        for (const symbol of symbols) {
            const quote = quotes.find(q => q.tradingSymbol === symbol);
            if (!quote) continue;

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

            const rules = ta.checkRules(indicators, 'RELAXED');
            
            if (rules.pass) {
                console.log(`✅ [${symbol}] PASS! (Relaxed Mode)`);
                console.log(`   Price: ₹${quote.lastTradedPrice} | RSI: ${indicators.rsi.toFixed(2)}`);
            } else {
                console.log(`❌ [${symbol}] FAIL`);
            }
            await new Promise(r => setTimeout(r, 200));
        }
    } catch (e) {
        console.error('Scan Error:', e.message);
    }
    console.log('\n--- RELAXED SCAN END ---');
}

discoveryScanRelaxed();
