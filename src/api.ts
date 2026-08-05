import express from 'express';
import cors from 'cors';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

const logger = pino({ name: 'api' });

export interface BotState {
  isRunning: boolean;
  isTestMode: boolean;
  stats: any;
  activePositions: any[];
  tradeHistory: any[];
  walletStats: () => any;
  recentLogs: any[];
}

export interface BotControls {
  start: () => void;
  stop: () => void;
  forceExit?: (mint: string) => Promise<boolean>;
  sweepWallets?: () => Promise<{ success: boolean; message: string }>;
  updateConfig: (updates: Record<string, string>) => void;
}

// Fix 22: Restrict CORS to configured dashboard URL + localhost dev
function buildCorsOptions() {
  const allowedOrigins: (string | RegExp)[] = [
    'http://localhost:5173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
    /\.vercel\.app$/,
    /\.cybroxlabs\.com$/,
  ];

  const dashboardUrl = process.env.DASHBOARD_URL;
  if (dashboardUrl) {
    allowedOrigins.push(dashboardUrl);
  }

  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);

      const allowed = allowedOrigins.some(o =>
        typeof o === 'string' ? o === origin : (o as RegExp).test(origin)
      );

      if (allowed) {
        callback(null, true);
      } else {
        logger.warn({ origin }, 'CORS: blocked request from disallowed origin');
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    credentials: true,
  };
}

export function startApi(state: BotState, controls: BotControls) {
  const app = express();

  // Fix 22: restricted CORS
  app.use(cors(buildCorsOptions()));
  app.use(express.json());

  // Security Middleware — accepts key from header OR query param (EventSource needs query param)
  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = (req.headers['x-api-key'] as string) || (req.query['x-api-key'] as string);
    const validKey = process.env.API_SECRET_KEY;

    if (!validKey) {
      logger.fatal('API_SECRET_KEY not set in .env! API is disabled for safety.');
      return res.status(500).json({ error: 'Server misconfiguration: No API key set' });
    }

    if (apiKey !== validKey) {
      logger.warn({ ip: req.ip }, 'Unauthorized API access attempt blocked');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
  };

  // Fix 20: SSE clients registry
  const sseClients = new Set<express.Response>();

  // Helper to safely serialize BigInts
  const jsonReplacer = (key: string, value: any) =>
    typeof value === 'bigint' ? value.toString() : value;

  app.set('json replacer', jsonReplacer);

  // Broadcast state change to all SSE clients
  function broadcastUpdate() {
    if (sseClients.size === 0) return;
    const payload = JSON.stringify({
      isRunning: state.isRunning,
      isTestMode: state.isTestMode,
      stats: state.stats,
      activePositions: state.activePositions,
      tradeHistory: state.tradeHistory.slice(0, 20),
      walletStats: state.walletStats(),
      recentLogs: state.recentLogs,
    }, jsonReplacer);
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  // Fix 20: SSE endpoint — real-time push to dashboard
  app.get('/events', authMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    res.flushHeaders();

    // Send initial state immediately on connect
    const initialPayload = JSON.stringify({
      isRunning: state.isRunning,
      isTestMode: state.isTestMode,
      stats: state.stats,
      activePositions: state.activePositions,
      tradeHistory: state.tradeHistory.slice(0, 20),
      walletStats: state.walletStats(),
      recentLogs: state.recentLogs,
    }, jsonReplacer);
    res.write(`data: ${initialPayload}\n\n`);

    sseClients.add(res);
    logger.info({ totalClients: sseClients.size }, '📡 SSE client connected');

    // Keepalive ping every 25s (prevents proxy timeout)
    const keepalive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepalive);
        sseClients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
      logger.info({ totalClients: sseClients.size }, '📡 SSE client disconnected');
    });
  });

  // Push broadcast function onto controls so bot can trigger it on state change
  (controls as any).broadcastUpdate = broadcastUpdate;

  // ─── Real-time heartbeat: push live state to all SSE clients every 2s ───
  // This ensures the dashboard always has fresh data (positions, P&L, logs)
  // without requiring the bot to manually call broadcastUpdate on every event.
  setInterval(() => {
    if (sseClients.size > 0) broadcastUpdate();
  }, 2000);

  // Polling fallback: GET /status (kept for compatibility)
  app.get('/status', authMiddleware, (req, res) => {
    res.json({
      isRunning: state.isRunning,
      isTestMode: state.isTestMode,
      stats: state.stats,
      activePositions: state.activePositions,
      tradeHistory: state.tradeHistory,
      walletStats: state.walletStats(),
      recentLogs: state.recentLogs,
    });
  });

  // Start / Stop the bot
  app.post('/control', authMiddleware, (req, res) => {
    const { action } = req.body;
    if (action === 'start') {
      controls.start();
      broadcastUpdate(); // Push to SSE clients immediately
      res.json({ success: true, message: 'Bot started' });
    } else if (action === 'stop') {
      controls.stop();
      broadcastUpdate();
      res.json({ success: true, message: 'Bot stopped' });
    } else {
      res.status(400).json({ error: 'Invalid action. Use "start" or "stop".' });
    }
  });

  // Emergency exit single active position
  app.post('/exit-position', authMiddleware, async (req, res) => {
    try {
      const { mint } = req.body;
      if (!mint) return res.status(400).json({ error: 'Mint address required' });
      if (controls.forceExit) {
        const success = await controls.forceExit(mint);
        broadcastUpdate();
        return res.json({ success, message: success ? 'Manual exit triggered' : 'Position not found' });
      }
      return res.status(500).json({ error: 'Emergency exit not supported' });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed manual exit');
      res.status(500).json({ error: 'Failed to execute manual exit' });
    }
  });

  // Manual sweep all sub-wallets back to Master Vault
  app.post(['/sweep', '/sweep-wallets'], authMiddleware, async (req, res) => {
    try {
      if (controls.sweepWallets) {
        const result = await controls.sweepWallets();
        broadcastUpdate();
        return res.json(result);
      }
      return res.status(500).json({ error: 'Sweep function not supported' });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed manual sweep from API');
      res.status(500).json({ error: err.message || 'Failed to sweep wallets' });
    }
  });

  // GET current configuration for dashboard modal
  app.get(['/config', '/settings'], authMiddleware, (req, res) => {
    res.json({
      PAPER_TRADING: CONFIG.DRY_RUN ? 'true' : 'false',
      PAPER_BALANCE_SOL: '1.0',
      TRADE_SIZE_SOL: (CONFIG.SNIPE_AMOUNT_LAMPORTS / 1_000_000_000).toString(),
      MAX_OPEN_POSITIONS: '5',
      TAKE_PROFIT_MULTIPLIER: (CONFIG.EXIT_PROFIT_PERCENT / 100).toString(),
      STOP_LOSS_PERCENT: CONFIG.EXIT_DRAWDOWN_PERCENT.toString(),
      TRAILING_STOP_PERCENT: CONFIG.TRAILING_STOP_PERCENT.toString(),
      SIGNAL_SCORE_THRESHOLD: '30',
      VOLUME_SPIKE_MULTIPLIER: '1.5',
      AI_SCORE_THRESHOLD: '70',
      MIN_LP_BURNED_PERCENT: '80',
      REJECT_HONEYPOT: 'true',
      REJECT_MINTABLE: 'true',
    });
  });

  // Update .env configuration & live in-memory config
  app.post(['/config', '/settings'], authMiddleware, (req, res) => {
    try {
      const updates = req.body;
      const envPath = path.resolve(process.cwd(), '.env');

      let envContent = fs.readFileSync(envPath, 'utf8');

      // Map frontend field names to .env key names if needed
      const envUpdates: Record<string, string> = { ...updates };
      if (updates.PAPER_TRADING !== undefined) envUpdates.DRY_RUN = updates.PAPER_TRADING;
      if (updates.TRADE_SIZE_SOL) envUpdates.SNIPE_AMOUNT_SOL = updates.TRADE_SIZE_SOL;
      if (updates.TAKE_PROFIT_MULTIPLIER) {
        envUpdates.EXIT_PROFIT_PERCENT = Math.floor(parseFloat(updates.TAKE_PROFIT_MULTIPLIER) * 100).toString();
      }
      if (updates.STOP_LOSS_PERCENT) envUpdates.EXIT_DRAWDOWN_PERCENT = updates.STOP_LOSS_PERCENT;

      for (const [key, value] of Object.entries(envUpdates)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (envContent.match(regex)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent += `\n${key}=${value}`;
        }
      }

      fs.writeFileSync(envPath, envContent);
      controls.updateConfig(updates as Record<string, string>);
      broadcastUpdate(); // Push config change to SSE clients

      logger.info({ keys: Object.keys(updates) }, 'Configuration updated via API');
      res.json({ success: true, message: 'Configuration updated and applied!' });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to update config');
      res.status(500).json({ error: 'Failed to update configuration' });
    }
  });

  const PORT = process.env.API_PORT || 3001;
  app.listen(PORT as number, '0.0.0.0', () => {
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
    logger.info(`🌐 API on port ${PORT} — CORS allowed: localhost + ${dashboardUrl}`);
    logger.info(`📡 SSE endpoint: http://0.0.0.0:${PORT}/events`);
  });

  // Expose broadcastUpdate for the main loop to call on position changes
  return { broadcastUpdate };
}
