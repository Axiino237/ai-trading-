const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const angelOneService = require('./angelOneService');
const geminiService = require('./geminiService');
const scannerService = require('./scannerService');
const supabaseService = require('./supabaseService');
const ta = require('./technicalAnalysis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(bodyParser.json());

// Expose io to services
global.io = io;

// Helper to get the primary user (First one in DB)
async function getSystemUser() {
    // 1. Try to get auto-active user first
    const activeUsers = await supabaseService.getAutoEnabledUsers();
    if (activeUsers.length > 0) return activeUsers[0].user_id;

    // 2. Fallback: Get ANY user from auto_settings if none are active
    const { data } = await supabaseService.supabase.from('auto_settings').select('user_id').limit(1);
    return (data && data.length > 0) ? data[0].user_id : null;
}

// ────────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('StocksPro Backend Live 🚀'));

app.get('/market/search', async (req, res) => {
    const { query } = req.query;
    try {
        const result = await angelOneService.searchScrip('NSE', query);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Alias for frontend compatibility
app.get('/search', async (req, res) => {
    const { query } = req.query;
    try {
        const result = await angelOneService.searchScrip('NSE', query);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/watchlist', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) return res.json([]);
        const list = await supabaseService.getUserWatchlist(userId);
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/watchlist', async (req, res) => {
    const { symbol } = req.body;
    try {
        const userId = await getSystemUser();
        if (!userId) throw new Error('No user found in DB');
        await supabaseService.addToWatchlist(userId, symbol.toUpperCase());
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/watchlist/:symbol', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) throw new Error('No user found in DB');
        await supabaseService.removeFromWatchlist(userId, req.params.symbol.toUpperCase());
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/trades', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) return res.json([]);
        const trades = await supabaseService.getUserTrades(userId);
        res.json(trades);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/wallet', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) return res.json({ balance: 0, mode: 'PAPER' });
        
        const settings = await supabaseService.getUserSettings(userId);
        const mode = settings.trade_mode || 'PAPER';
        
        let balance = 0;
        if (mode === 'REAL') {
            const rms = await angelOneService.getRMSBalance();
            balance = rms?.net || 0;
        } else {
            balance = await supabaseService.getPaperFunds(userId);
        }
        res.json({ balance, mode });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Alias for frontend compatibility (matches App.tsx line 187)
app.get('/balances', async (req, res) => {
    console.log(`[API] GET /balances requested...`);
    try {
        const userId = await getSystemUser();
        if (!userId) return res.json({ real: 0, paper: 100000 });
        
        const settings = await supabaseService.getUserSettings(userId);
        const mode = settings.trade_mode || 'PAPER';
        
        let real = 0;
        let paper = 0;

        // Fetch Real
        const rms = await angelOneService.getRMSBalance();
        real = rms?.net || 0;

        // Fetch Paper
        paper = await supabaseService.getPaperFunds(userId);
        
        res.json({ real, paper, mode });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/settings', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) return res.status(404).json({ error: 'No user found' });
        const settings = await supabaseService.getUserSettings(userId);
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/settings', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) throw new Error('No user found in DB');
        // FIX: Using correct method name 'updateSettings'
        await supabaseService.updateSettings(userId, req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('[SETTINGS POST ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/history', async (req, res) => {
    try {
        const userId = await getSystemUser();
        if (!userId) return res.json([]);
        const { data, error } = await supabaseService.supabase
            .from('trades')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/logs', async (req, res) => {
    console.log(`[API] GET /logs requested...`);
    try {
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;
        const logs = await supabaseService.getLogs(limit, offset);
        res.json(logs || []);
    } catch (error) {
        console.error(`[API] Logs Error:`, error.message);
        res.json([]);
    }
});

app.post('/trade/close', async (req, res) => {
    const { tradeId } = req.body;
    console.log(`[TRADE] Request to close trade: ${tradeId}`);
    try {
        // 1. Get trade details from Supabase
        const { data: trade, error } = await supabaseService.supabase
            .from('trades')
            .select('*')
            .eq('id', tradeId)
            .single();

        if (error || !trade) throw new Error('Trade not found');
        if (trade.status === 'CLOSED') throw new Error('Trade already closed');

        const isReal = trade.side.includes('REAL');
        const symbol = trade.symbol;
        const quantity = trade.quantity || 1;
        const oppositeSide = trade.type === 'BUY' ? 'SELL' : 'BUY';

        let exitPrice = 0;

        // 2. If Real, execute exit order on Angel One
        if (isReal) {
            console.log(`[ANGEL] Exiting REAL position for ${symbol}...`);
            const quote = await angelOneService.getQuote(symbol);
            exitPrice = quote.lastTradedPrice;

            await angelOneService.placeOrder(
                symbol,
                quote.symbolToken,
                quantity,
                oppositeSide,
                "MARKET"
            );
            console.log(`[ANGEL] Exit order placed for ${symbol} @ ${exitPrice} ✅`);
        } else {
            // If Paper, just get current quote for exit price
            try {
                const quote = await angelOneService.getQuote(symbol);
                exitPrice = quote.lastTradedPrice;
            } catch (e) {
                exitPrice = trade.entry_price; // Fallback
            }
        }

        // 3. Update Supabase record
        const { error: updateError } = await supabaseService.supabase
            .from('trades')
            .update({
                status: 'CLOSED',
                exit_price: exitPrice,
                closed_at: new Date().toISOString()
            })
            .eq('id', tradeId);

        if (updateError) throw updateError;

        // 4. If Paper, credit funds back to wallet
        if (!isReal) {
            console.log(`[PAPER] Crediting funds back for ${symbol}...`);
            const pnl = (exitPrice - trade.entry_price) * (trade.type === 'BUY' ? 1 : -1) * quantity;
            const amountToCredit = (trade.entry_price * quantity) + pnl;
            
            await supabaseService.creditPaperFunds(trade.user_id, amountToCredit);
            console.log(`[PAPER] Credited ₹${amountToCredit.toFixed(2)} to wallet ✅`);
        }

        res.json({ success: true, message: `Trade ${symbol} closed at ${exitPrice}` });
    } catch (error) {
        console.error(`[TRADE] Close Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/analyze', async (req, res) => {
    const { symbol } = req.body;
    try {
        console.log(`[API] AI Analysis requested for ${symbol}...`);
        const quote = await angelOneService.getQuote(symbol);
        const candles = await angelOneService.getCandleData(symbol, 'FIVE_MINUTE', 5);
        
        if (!quote || !candles) throw new Error('Could not fetch market data');

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

        const result = await scannerService.getAIAnalysis(symbol, quote.lastTradedPrice, indicators);

        res.json({
            sentiment: result.sentiment,
            confidenceScore: result.confidenceScore,
            explanation: result.explanation || `AI analysis for ${symbol} @ ₹${quote.lastTradedPrice}`,
            sl: result.sl,
            tp: result.tp,
            holdingType: result.holdingType,
            expectedDuration: result.suggestedHolding
        });
    } catch (error) {
        console.error('[API ANALYZE ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/trade/manual', async (req, res) => {
    const { symbol, side, price } = req.body;
    try {
        const userId = await getSystemUser();
        if (!userId) throw new Error('No user found');

        await angelOneService.loadSymbolMaster();
        const scrip = angelOneService.symbolMaster.find(s => s.symbol.replace('-EQ', '').toUpperCase() === symbol.replace('-EQ', '').toUpperCase());
        if (!scrip) throw new Error('Symbol not found');

        const isBuy = side === 'BUY';
        const sl = isBuy ? price * 0.98 : price * 1.02;
        const tp = isBuy ? price * 1.04 : price * 0.96;

        const settings = await supabaseService.getUserSettings(userId);
        const mode = settings.trade_mode || 'PAPER';

        // Use user-provided quantity or fallback to dynamic calculation
        let finalQuantity = req.body.quantity ? parseInt(req.body.quantity, 10) : 0;
        
        if (!finalQuantity || finalQuantity <= 0) {
            finalQuantity = await scannerService.calculateQuantity(userId, price, sl, mode);
        }

        if (finalQuantity <= 0) {
            return res.status(400).json({ error: 'Insufficient funds or invalid quantity' });
        }

        if (mode === 'REAL') {
            await angelOneService.placeOrder(symbol, scrip.token, finalQuantity, side, 'LIMIT', price);
        }

        await supabaseService.saveTrade({
            user_id: userId,
            symbol,
            symbolToken: scrip.token,
            entry_price: price,
            stop_loss: req.body.sl || sl,
            take_profit: req.body.tp || tp,
            quantity: finalQuantity,
            side: side,
            type: side,
            status: 'OPEN',
            trade_mode: 'MANUAL',
            trading_type: mode,
            holding_type: req.body.holdingType || 'SHORT_TERM',
            expected_duration: req.body.expectedDuration || null
        });

        if (global.io) global.io.emit('trade-executed', { symbol, mode: 'MANUAL' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ────────────────────────────────────────────────────────────────
// SERVER START
// ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Backend listening at http://0.0.0.0:${PORT}`);
    try {
        await angelOneService.login();
        scannerService.start();
        
        // Initial DB Maintenance: Cleanup old logs
        await supabaseService.cleanupOldLogs();
        
        // Schedule DB Maintenance: Every 24 hours
        setInterval(async () => {
            await supabaseService.cleanupOldLogs();
        }, 24 * 60 * 60 * 1000);

    } catch (error) {
        console.error('Initial Login Error:', error.message);
    }
});

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected'));
});
