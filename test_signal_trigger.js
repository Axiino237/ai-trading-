const angelOneService = require('./angelOneService');
const ta = require('./technicalAnalysis');
const telegram = require('./telegramService');
const scanner = require('./scannerService'); // We might need to mock scanner context
require('dotenv').config();

async function testSignalTrigger() {
    const symbol = 'RELIANCE-EQ'; // Testing with a major symbol
    console.log(`--- FORCING SIGNAL TRIGGER FOR ${symbol} ---`);

    try {
        // 1. Get real price first
        const quote = await angelOneService.getQuote(symbol);
        const price = quote.lastTradedPrice;

        // 2. MOCK indicators to FORCE a pass
        const mockIndicators = {
            ema9: price + 10,
            ema20: price + 5,
            ema50: price,
            rsi: 55,
            macd: { histogram: 1 },
            volume: 1000000,
            avgVolume: 500000,
            candles: [] // Empty mock
        };

        console.log('✅ Technical Criteria: MOCKED AS PASS');

        // 3. Trigger AI Analysis (Real AI call)
        console.log('🧠 Calling Gemini AI for Analysis...');
        
        // We'll use scannerService's AI analysis logic
        const scannerInstance = new (require('./scannerService').constructor)();
        const aiResult = await scannerInstance.getAIAnalysis(symbol, price, mockIndicators);

        console.log('AI Sentiment:', aiResult.sentiment);
        console.log('AI Confidence:', aiResult.confidence);

        // 4. Send Telegram Alert (Real Telegram call)
        console.log('📱 Sending Telegram Alert...');
        await telegram.sendTradeAlert({
            symbol: symbol,
            sentiment: aiResult.sentiment,
            confidence: aiResult.confidence,
            explanation: aiResult.explanation,
            entry: aiResult.suggested_entry || price,
            sl: aiResult.suggested_sl,
            tp: aiResult.suggested_tp
        });

        console.log('✨ SUCCESS: Signal triggered manually for testing!');

    } catch (e) {
        console.error('Test Error:', e.message);
    }
}

testSignalTrigger();
