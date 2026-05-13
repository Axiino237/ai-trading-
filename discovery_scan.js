const angelOneService = require('./angelOneService');
const ta = require('./technicalAnalysis');
require('dotenv').config();

async function discoveryScan() {
    // Symbols to check (mostly not in user's previous list)
    const symbols = [
        'ADANIENT-EQ', 'BHARTIARTL-EQ', 'COALINDIA-EQ', 'MARUTI-EQ', 'SUNPHARMA-EQ',
        'ULTRACEMCO-EQ', 'NTPC-EQ', 'ASIANPAINT-EQ', 'M&M-EQ', 'HINDUNILVR-EQ',
        'ICICIBANK-EQ', 'INFY-EQ', 'LT-EQ', 'BAJFINANCE-EQ', 'ADANIPORTS-EQ',
        'GRASIM-EQ', 'HEROMOTOCO-EQ', 'JSWSTEEL-EQ', 'NESTLEIND-EQ', 'ONGC-EQ'
    ];

    console.log('--- DISCOVERY SCAN START (Checking New Symbols) ---');
    console.log(`Scanning ${symbols.length} symbols...\n`);

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

            const rules = ta.checkRules(indicators);
            
            if (rules.pass) {
                console.log(`✅ [${symbol}] PASS! (Technical Criteria Met)`);
                console.log(`   Price: ₹${quote.lastTradedPrice} | RSI: ${indicators.rsi.toFixed(2)} | Trend: UP`);
            } else {
                // Just log failures briefly to keep it clean
                const d = rules.details;
                const reason = `${!d.trendBullish ? 'Trend,' : ''}${!d.macdBullish ? 'MACD,' : ''}${!d.rsiValid ? 'RSI,' : ''}${!d.volumeBreakout ? 'Vol,' : ''}${!d.patternConfirmed ? 'Pattern' : ''}`;
                console.log(`❌ [${symbol}] FAIL (Reason: ${reason.replace(/,$/, '')})`);
            }
            
            // Small delay to avoid rate limiting during sequential candle fetch
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (e) {
        console.error('Scan Error:', e.message);
    }
    console.log('\n--- DISCOVERY SCAN END ---');
}

discoveryScan();
