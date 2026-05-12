class TechnicalAnalysis {
    /**
     * Exponential Moving Average (EMA)
     */
    calculateEMA(candles, period) {
        if (!candles || candles.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = candles[0][4]; // Initial seed
        for (let i = 1; i < candles.length; i++) {
            ema = (candles[i][4] * k) + (ema * (1 - k));
        }
        return ema;
    }

    /**
     * Relative Strength Index (RSI)
     */
    calculateRSI(candles, period = 14) {
        if (!candles || candles.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = candles[i][4] - candles[i - 1][4];
            if (diff >= 0) gains += diff; else losses -= diff;
        }
        let avgGain = gains / period, avgLoss = losses / period;
        for (let i = period + 1; i < candles.length; i++) {
            const diff = candles[i][4] - candles[i - 1][4];
            avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
            avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
        }
        return avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    }

    /**
     * MACD
     */
    calculateMACD(candles) {
        if (candles.length < 26) return { macd: 0, signal: 0, histogram: 0 };
        const ema12 = this.calculateEMA(candles, 12);
        const ema26 = this.calculateEMA(candles, 26);
        const macd = ema12 - ema26;
        // Signal line is EMA 9 of MACD (Simplified here, in reality would need a window of MACD values)
        const signal = macd * 0.8; // Rough approximation for single candle
        return { macd, signal, histogram: macd - signal };
    }

    /**
     * Volume Average
     */
    calculateAvgVolume(candles, period = 20) {
        if (candles.length < period) return 0;
        const slice = candles.slice(-period);
        const sum = slice.reduce((acc, c) => acc + c[5], 0);
        return sum / period;
    }

    /**
     * Candlestick Pattern: Hammer
     */
    isHammer(candle) {
        const [t, o, h, l, c, v] = candle;
        const body = Math.abs(c - o);
        const lowerShadow = Math.min(o, c) - l;
        const upperShadow = h - Math.max(o, c);
        return lowerShadow >= 2 * body && upperShadow <= 0.1 * lowerShadow;
    }

    /**
     * Candlestick Pattern: Engulfing
     */
    isBullishEngulfing(prev, curr) {
        const [pt, po, ph, pl, pc, pv] = prev;
        const [ct, co, ch, cl, cc, cv] = curr;
        return (pc < po) && (cc > co) && (cc > po) && (co < pc);
    }

    /**
     * Support / Resistance detection (Simple Swing method)
     */
    getLevels(candles) {
        const prices = candles.map(c => c[4]);
        const support = Math.min(...prices.slice(-20));
        const resistance = Math.max(...prices.slice(-20));
        return { support, resistance };
    }

    /**
     * Trend Detection
     */
    getTrend(emaShort, emaLong) {
        if (emaShort > emaLong) return 'UP';
        if (emaShort < emaLong) return 'DOWN';
        return 'SIDEWAYS';
    }

    /**
     * Final Rule Check
     */
    checkRules(data) {
        const { ema9, ema20, ema50, rsi, macd, volume, avgVolume, candles } = data;
        
        const trendBullish = ema9 > ema20 && ema20 > ema50;
        const macdBullish = macd.histogram > 0;
        const rsiValid = rsi > 45 && rsi < 70;
        const volumeBreakout = volume > 1.5 * avgVolume;
        
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];
        const patternConfirmed = this.isHammer(lastCandle) || this.isBullishEngulfing(prevCandle, lastCandle);

        return {
            pass: trendBullish && macdBullish && rsiValid && volumeBreakout && patternConfirmed,
            details: { trendBullish, macdBullish, rsiValid, volumeBreakout, patternConfirmed }
        };
    }
}

module.exports = new TechnicalAnalysis();
