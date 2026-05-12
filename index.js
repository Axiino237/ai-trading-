require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
// Gemini Service (Rotating Keys)
const geminiService = require('./geminiService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const angelOneService = require('./angelOneService');
const supabaseService = require('./supabaseService');
const ta = require('./technicalAnalysis');
const scannerService = require('./scannerService');

// Make IO accessible to other services
global.io = io;

app.get('/', (req, res) => {
    res.send('Stocks Hybrid AI Backend is Running with WebSockets! 🚀');
});

/**
 * Socket.io Connection
 */
io.on('connection', (socket) => {
    console.log('Client connected to real-time updates ⚡');

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

/**
 * Login to Angel One
 */
app.post('/angel/login', async (req, res) => {
    const { clientId, password, totpSecret } = req.body;
    const result = await angelOneService.login(clientId, password, totpSecret);
    res.json(result);
});

app.post('/angel/auto-login', async (req, res) => {
    const result = await angelOneService.login();
    res.json(result);
});

app.get('/angel/quote/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const { exchange } = req.query;
    try {
        const data = await angelOneService.getQuote(symbol, exchange || 'NSE');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/analyze', async (req, res) => {
    const { symbol, autoTrade = false, user_id } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

    try {
        const quote = await angelOneService.getQuote(symbol);
        const candles = await angelOneService.getCandleData(symbol, 'FIVE_MINUTE', 2);
        const rsi = ta.calculateRSI(candles);
        const ema20 = ta.calculateEMA(candles, 20);
        const ema50 = ta.calculateEMA(candles, 50);
        const trend = ta.getTrend(ema20, ema50);
        
        const prompt = `
            You are a Professional Quant Trader.
            SYMBOL: ${symbol}, Price: ${quote.lastTradedPrice}, RSI: ${rsi.toFixed(2)}, Trend: ${trend}
            TASK: Final Sentiment (BULLISH/BEARISH/NEUTRAL) in Tanglish.
            OUTPUT FORMAT (JSON): {"sentiment": "BULLISH", "confidence": 85, "explanation": "...", "suggested_entry": 100, "suggested_sl": 95, "suggested_tp": 110}
        `;

        const text = await geminiService.generateAnalysis(prompt);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('AI analysis returned invalid format');
        const analysis = JSON.parse(jsonMatch[0]);
        
        if (autoTrade && analysis.confidence >= 75 && analysis.sentiment !== 'NEUTRAL') {
            await supabaseService.saveTrade({
                user_id,
                symbol,
                symbolToken: quote.symbolToken,
                type: analysis.sentiment === 'BULLISH' ? 'BUY' : 'SELL',
                entry_price: analysis.suggested_entry || quote.lastTradedPrice,
                stop_loss: analysis.suggested_sl,
                take_profit: analysis.suggested_tp
            });
            // Broadcast trade event
            io.emit('trade-executed', { symbol, type: analysis.sentiment });
        }

        res.json({ ...analysis, indicators: { rsi, trend, ema20, ema50 }, symbol });
    } catch (error) {
        res.status(500).json({ sentiment: 'NEUTRAL', explanation: error.message });
    }
});

/**
 * Manual Trade Execution
 */
app.post('/trade/manual', async (req, res) => {
    const { symbol, type, user_id, price } = req.body;
    if (!symbol || !type) return res.status(400).json({ error: 'Missing required fields' });

    try {
        const quote = await angelOneService.getQuote(symbol);
        const entryPrice = price || quote.lastTradedPrice;
        
        // Place order via Angel One
        const order = await angelOneService.placeOrder(
            symbol, 
            quote.symbolToken, 
            1, 
            type, 
            'LIMIT', 
            entryPrice
        );

        const settings = await supabaseService.getUserSettings(MOCK_USER_ID);
        
        // Save to DB as MANUAL with correct trading_type
        await supabaseService.saveTrade({
            user_id: user_id || MOCK_USER_ID,
            symbol,
            type,
            entry_price: entryPrice,
            trade_mode: 'MANUAL',
            trading_type: settings.trade_mode || 'PAPER'
        });

        io.emit('trade-executed', { symbol, type, price: entryPrice, mode: 'MANUAL' });
        res.json({ success: true, order });
    } catch (error) {
        console.error('Manual Trade Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 2) return res.json([]);
    try {
        console.log(`[SEARCH] Query: ${query}`);
        const result = await angelOneService.searchScrip('NSE', query.toUpperCase());
        console.log(`[SEARCH] Results found: ${result.data.length}`);
        res.json(result.data || []);
    } catch (error) {
        console.error('[SEARCH] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000000';

app.get('/watchlist', async (req, res) => {
    try {
        const list = await supabaseService.getUserWatchlist(MOCK_USER_ID);
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/watchlist', async (req, res) => {
    const { symbol } = req.body;
    console.log(`[WATCHLIST] Attempting to add symbol: ${symbol}`);
    try {
        const { data, error } = await supabaseService.supabase
            .from('watchlist')
            .upsert({ user_id: MOCK_USER_ID, symbol: symbol.toUpperCase() });
        
        if (error) {
            console.error('[WATCHLIST] DB Error:', error.message);
            throw error;
        }
        console.log(`[WATCHLIST] Successfully added: ${symbol}`);
        res.json({ success: true });
    } catch (error) {
        console.error('[WATCHLIST] Catch Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/watchlist/:symbol', async (req, res) => {
    const { symbol } = req.params;
    try {
        const { error } = await supabaseService.supabase
            .from('watchlist')
            .delete()
            .eq('user_id', MOCK_USER_ID)
            .eq('symbol', symbol.toUpperCase());
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/history', async (req, res) => {
    const settings = await supabaseService.getUserSettings(MOCK_USER_ID);
    const history = await supabaseService.getHistory(settings.trade_mode || 'PAPER');
    res.json(history);
});

app.get('/settings', async (req, res) => {
    const userId = req.query.user_id || MOCK_USER_ID;
    const settings = await supabaseService.getUserSettings(userId);
    res.json(settings);
});

app.post('/settings', async (req, res) => {
    const { user_id, ...settings } = req.body;
    const result = await supabaseService.updateSettings(user_id || MOCK_USER_ID, settings);
    res.json(result);
});

app.get('/balances', async (req, res) => {
    try {
        const userId = req.query.user_id || MOCK_USER_ID;
        const realFunds = await angelOneService.getRMSBalance();
        const paperFunds = await supabaseService.getPaperFunds(userId);
        res.json({
            real: realFunds?.net || 0,
            paper: paperFunds
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Backend listening at http://0.0.0.0:${port}`);
    scannerService.start();
});
