const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
require('dotenv').config();

const angelOneService = require('./angelOneService');
const geminiService = require('./geminiService');
const scannerService = require('./scannerService');
const supabaseService = require('./supabaseService');
const ta = require('./technicalAnalysis');

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(bodyParser.json());

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Expose io to services
global.io = io;

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function getAdminEmails() {
    return (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
        .split(',')
        .map(email => normalizeEmail(email))
        .filter(Boolean);
}

async function authenticateRequest(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const token = authHeader.slice(7).trim();
        if (!token) {
            return res.status(401).json({ error: 'Authentication token missing' });
        }

        const tokenHash = sha256(token);
        const session = await supabaseService.getSession(tokenHash);
        if (!session) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        if (session.expires_at && new Date(session.expires_at) < new Date()) {
            await supabaseService.deleteSession(tokenHash);
            return res.status(401).json({ error: 'Session expired' });
        }

        const user = await supabaseService.getUserById(session.user_id);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        const settings = await supabaseService.getUserSettings(user.id);

        req.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role || 'USER',
            plan_tier: settings.plan_tier || 'STARTER'
        };
        req.sessionTokenHash = tokenHash;
        next();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access denied' });
    }
    next();
}

// ────────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('StocksPro Backend Live 🚀'));

app.post('/auth/register', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || '');

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existing = await supabaseService.getUserByEmail(email);
        if (existing) {
            return res.status(409).json({ error: 'User already exists' });
        }

        const { salt, hash } = hashPassword(password);
        const role = getAdminEmails().includes(email) ? 'ADMIN' : 'USER';

        const user = await supabaseService.createUser({
            id: crypto.randomUUID(),
            name,
            email,
            password_salt: salt,
            password_hash: hash,
            role,
            created_at: new Date().toISOString()
        });

        const token = generateSessionToken();
        await supabaseService.createSession({
            id: crypto.randomUUID(),
            user_id: user.id,
            token_hash: sha256(token),
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        });

        res.json({ token, user });
    } catch (error) {
        console.error('[AUTH ERROR] Register failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || '');

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await supabaseService.getUserByEmail(email);
        if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateSessionToken();
        await supabaseService.createSession({
            id: crypto.randomUUID(),
            user_id: user.id,
            token_hash: sha256(token),
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        });

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role || 'USER'
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/auth/me', authenticateRequest, async (req, res) => {
    res.json({ user: req.user });
});

app.post('/auth/logout', authenticateRequest, async (req, res) => {
    try {
        await supabaseService.deleteSession(req.sessionTokenHash);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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

app.use(authenticateRequest);

app.get('/watchlist', async (req, res) => {
    try {
        const userId = req.user.id;
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
        const userId = req.user.id;
        if (!userId) throw new Error('No user found in DB');
        await supabaseService.addToWatchlist(userId, symbol.toUpperCase());
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/watchlist/:symbol', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) throw new Error('No user found in DB');
        await supabaseService.removeFromWatchlist(userId, req.params.symbol.toUpperCase());
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/trades', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.json([]);
        const trades = await supabaseService.getUserTrades(userId);
        res.json(trades);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/wallet', async (req, res) => {
    try {
        const userId = req.user.id;
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
        const userId = req.user.id;
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
        
        // Fetch Invested
        const invested = await supabaseService.getInvestedCapitalAmount(userId, mode);
        
        // Fetch Live P&L (Unrealized)
        const livePnL = await supabaseService.getLivePnL(userId, mode, angelOneService);
        
        res.json({ 
            real, 
            paper, 
            mode,
            invested,
            totalProfit: livePnL,
            totalEquity: (mode === 'REAL' ? real : paper) + invested + livePnL
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/wallet/logs', async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await supabaseService.supabase
            .from('wallet_logs')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.status(404).json({ error: 'No user found' });
        const settings = await supabaseService.getUserSettings(userId);
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) throw new Error('No user found in DB');
        // FIX: Using correct method name 'updateSettings'
        await supabaseService.updateSettings(userId, req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('[SETTINGS POST ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/profile/broker', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.status(404).json({ error: 'No user found' });
        const creds = await supabaseService.getBrokerCredentials(userId);
        res.json(creds || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/profile/broker/rms', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.status(404).json({ error: 'No user found' });
        
        const creds = await supabaseService.getBrokerCredentials(userId);
        if (!creds || !creds.api_key) return res.json({ availableCash: 0 });

        const rms = await angelOneService.getUserRMSBalance(creds);
        res.json({ availableCash: rms?.net || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/profile/broker', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) throw new Error('No user found in DB');
        
        const updates = req.body;
        if (!updates.client_id || !updates.password || !updates.totp_secret || !updates.api_key) {
            return res.status(400).json({ error: 'All broker fields are required' });
        }

        const creds = await supabaseService.updateBrokerCredentials(userId, updates);
        res.json({ success: true, credentials: creds });
    } catch (error) {
        console.error('[BROKER CREDENTIALS POST ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/history', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.json([]);
        const { data, error } = await supabaseService.supabase
            .from('trades')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/logs', requireAdmin, async (req, res) => {
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

app.get('/payment-config', async (req, res) => {
    res.json({
        upiId: process.env.PAYMENT_UPI_ID || '',
        payeeName: process.env.PAYMENT_PAYEE_NAME || 'Stocks Pro',
        qrUrl: process.env.PAYMENT_QR_URL || '',
        instructions: process.env.PAYMENT_INSTRUCTIONS || 'QR scan pannitu transaction ID submit pannunga. Admin verify pannitu wallet credit pannuvanga.'
    });
});

app.get('/payments/mine', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.json([]);
        const payments = await supabaseService.getPaymentRequests({
            userId,
            limit: 20
        });
        res.json(payments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/payments/request', async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) throw new Error('No user found in DB');

        const payment = await supabaseService.createPaymentRequest(userId, req.body);
        res.json({ success: true, payment });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/admin/payments', requireAdmin, async (req, res) => {
    try {
        const status = req.query.status ? String(req.query.status) : null;
        const payments = await supabaseService.getPaymentRequests({
            status,
            limit: 100
        });
        res.json(payments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/payments/:id/approve', requireAdmin, async (req, res) => {
    try {
        const payment = await supabaseService.approvePaymentRequest(req.params.id, {
            approvedBy: req.user.email,
            adminNote: req.body?.admin_note || null
        });
        res.json({ success: true, payment });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/payments/:id/reject', requireAdmin, async (req, res) => {
    try {
        const payment = await supabaseService.rejectPaymentRequest(req.params.id, {
            approvedBy: req.user.email,
            adminNote: req.body?.admin_note || null
        });
        res.json({ success: true, payment });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/admin/stats', requireAdmin, async (req, res) => {
    try {
        const [users, trades, payments, funds] = await Promise.all([
            supabaseService.supabase.from('app_users').select('id', { count: 'exact', head: true }),
            supabaseService.supabase.from('trades').select('status, type, entry_price, exit_price, quantity'),
            supabaseService.supabase.from('payment_requests').select('status', { count: 'exact', head: true }).eq('status', 'PENDING'),
            supabaseService.supabase.from('paper_funds').select('balance')
        ]);

        const allTrades = trades.data || [];
        const closedTrades = allTrades.filter(t => t.status === 'CLOSED');
        
        let totalPnl = 0;
        closedTrades.forEach(t => {
            const pnl = (t.exit_price - t.entry_price) * (t.type === 'BUY' ? 1 : -1) * (t.quantity || 1);
            totalPnl += pnl;
        });

        res.json({
            totalUsers: users.count || 0,
            activeTrades: allTrades.filter(t => t.status === 'OPEN').length,
            pendingPayments: payments.count || 0,
            totalSystemBalance: (funds.data || []).reduce((acc, f) => acc + Number(f.balance), 0),
            totalClosedTrades: closedTrades.length,
            systemWinRate: closedTrades.length > 0 
                ? (closedTrades.filter(t => (t.exit_price - t.entry_price) * (t.type === 'BUY' ? 1 : -1) > 0).length / closedTrades.length * 100).toFixed(1)
                : 0,
            totalNetPnl: totalPnl.toFixed(2)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// Alias
app.post('/trade/open', async (req, res) => {
    req.url = '/trade/manual';
    app.handle(req, res);
});


app.post('/trade/close', async (req, res) => {
    const { tradeId } = req.body;
    console.log(`[TRADE] Request to close trade: ${tradeId}`);
    try {
        const userId = req.user.id;

        // 1. Get trade details from Supabase
        const { data: trade, error } = await supabaseService.supabase
            .from('trades')
            .select('*')
            .eq('id', tradeId)
            .single();

        if (error || !trade) throw new Error('Trade not found');
        if (trade.status === 'CLOSED') throw new Error('Trade already closed');
        if (userId && trade.user_id !== userId) throw new Error('Trade does not belong to the active user');

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

            // Fetch per-user broker credentials
            const creds = await supabaseService.getBrokerCredentials(userId);
            if (!creds || !creds.api_key) {
                throw new Error('Broker credentials not configured for this user.');
            }

            await angelOneService.placeUserOrder(
                creds,
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
        console.log(`[TRADE] Updating trade ${tradeId} status to CLOSED...`);
        const { error: updateError } = await supabaseService.supabase
            .from('trades')
            .update({
                status: 'CLOSED',
                exit_price: exitPrice,
                closed_at: new Date().toISOString()
            })
            .eq('id', tradeId);

        if (updateError) {
            console.error(`[TRADE] Update Error:`, updateError.message);
            throw updateError;
        }

        // 4. If Paper, credit funds back to wallet
        console.log(`[TRADE] Trade side: ${trade.side}, isReal: ${isReal}`);
        if (trade.side === 'PAPER') {
            console.log(`[PAPER] Crediting funds back for ${symbol}...`);
            const pnl = (exitPrice - trade.entry_price) * (trade.type === 'BUY' ? 1 : -1) * quantity;
            const amountToCredit = (trade.entry_price * quantity) + pnl;
            
            console.log(`[PAPER] PnL: ${pnl}, Amount to Credit: ${amountToCredit}`);
            await supabaseService.creditPaperFunds(trade.user_id, amountToCredit, 'TRADE_EXIT', trade.id);
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
    const { symbol, type, price, quantity, sl, tp, holdingType, expectedDuration } = req.body;
    try {
        const userId = req.user.id;
        if (!userId) throw new Error('No user found');
        if (!symbol || !type || !price) throw new Error('Symbol, type (BUY/SELL), and price are required');

        await angelOneService.loadSymbolMaster();
        const scrip = angelOneService.symbolMaster.find(s => 
            s.symbol.replace('-EQ', '').toUpperCase() === symbol.replace('-EQ', '').toUpperCase()
        );
        if (!scrip) throw new Error(`Symbol ${symbol} not found in master list`);

        const isBuy = type.toUpperCase() === 'BUY';
        const entryPrice = parseFloat(price);
        const stopLoss = sl || (isBuy ? entryPrice * 0.98 : entryPrice * 1.02);
        const takeProfit = tp || (isBuy ? entryPrice * 1.04 : entryPrice * 0.96);

        const settings = await supabaseService.getUserSettings(userId);
        const mode = settings.trade_mode || 'PAPER';

        // Determine final quantity
        let finalQuantity = quantity ? parseInt(quantity, 10) : 0;
        if (!finalQuantity || finalQuantity <= 0) {
            finalQuantity = await scannerService.calculateQuantity(userId, entryPrice, stopLoss, mode);
        }

        if (finalQuantity <= 0) {
            return res.status(400).json({ error: 'Insufficient funds or invalid quantity' });
        }

        // Execute REAL order if applicable
        if (mode === 'REAL') {
            const creds = await supabaseService.getBrokerCredentials(userId);
            if (!creds) throw new Error('Broker credentials not found for REAL trading');
            await angelOneService.placeUserOrder(creds, symbol, scrip.token, finalQuantity, type.toUpperCase(), 'LIMIT', entryPrice);
        }

        // Save trade and handle wallet deduction centrally
        const result = await supabaseService.saveTrade({
            user_id: userId,
            symbol: symbol.toUpperCase(),
            symbolToken: scrip.token,
            entry_price: entryPrice,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            quantity: finalQuantity,
            type: type.toUpperCase(),
            status: 'OPEN',
            trade_mode: 'MANUAL',
            trading_type: mode,
            holding_type: holdingType || 'SHORT_TERM',
            expected_duration: expectedDuration || null
        });

        if (global.io) global.io.emit('trade-executed', { symbol, mode: 'MANUAL', userId });
        
        res.json({ success: true, trade: result.data?.[0] });
    } catch (error) {
        console.error('[MANUAL TRADE ERROR]:', error.message);
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
