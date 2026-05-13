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
        const settings = await supabaseService.getUserSettings(userId);
        const history = await supabaseService.getHistory(settings.trade_mode || 'PAPER');
        res.json(history);
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

        // Dynamic Quantity for Manual Trade
        const quantity = await scannerService.calculateQuantity(userId, price, sl, mode);

        if (quantity <= 0) {
            return res.status(400).json({ error: 'Insufficient funds for 1 share' });
        }

        if (mode === 'REAL') {
            await angelOneService.placeOrder(symbol, scrip.token, quantity, side, 'LIMIT', price);
        }

        await supabaseService.saveTrade({
            user_id: userId,
            symbol,
            symbolToken: scrip.token,
            entry_price: price,
            stop_loss: sl,
            take_profit: tp,
            quantity: quantity,
            side: side,
            type: side,
            status: 'OPEN',
            trade_mode: 'MANUAL',
            trading_type: mode
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
    } catch (error) {
        console.error('Initial Login Error:', error.message);
    }
});

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected'));
});
