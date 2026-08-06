/**
 * WsPoolMonitor — Free real-time pool account monitoring via Solana WebSocket accountSubscribe.
 *
 * Instead of polling the pool account every 200ms (RPC calls), we subscribe once and receive
 * pushed notifications whenever any trade happens in the pool. This gives ~100-400ms response
 * time using the existing Helius WebSocket — no gRPC or paid upgrades required.
 *
 * Flow:
 *   addPool(address) → sends accountSubscribe to WS → Helius pushes update on every trade
 *   → callback fires with new baseReserves/quoteReserves → ExitManager checks immediately
 */

import WebSocket from 'ws';
import pino from 'pino';

const logger = pino({ name: 'ws-pool-monitor' });

export type PoolUpdateCallback = (
  poolAddress: string,
  baseReserves: bigint,
  quoteReserves: bigint,
) => void;

export class WsPoolMonitor {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly onUpdate: PoolUpdateCallback;

  /** requestId → poolAddress (pending subscription confirmation) */
  private pendingSubs: Map<number, string> = new Map();
  /** subscriptionId → poolAddress (confirmed subscriptions) */
  private activeSubs: Map<number, string> = new Map();
  /** poolAddress → subscriptionId (reverse lookup for unsubscribe) */
  private poolToSubId: Map<string, number> = new Map();

  private reqId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(wsUrl: string, onUpdate: PoolUpdateCallback) {
    this.wsUrl = wsUrl;
    this.onUpdate = onUpdate;
    this.connect();
  }

  // ─── Connection management ────────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'WsPoolMonitor: failed to create WS — retrying');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      logger.info('✅ WsPoolMonitor connected — real-time pool monitoring active');
      // Re-subscribe to any pools we were tracking
      const pools = new Set([...this.poolToSubId.keys()]);
      this.activeSubs.clear();
      this.poolToSubId.clear();
      this.pendingSubs.clear();
      for (const pool of pools) this.subscribeToPool(pool);
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch { /* ignore parse errors */ }
    });

    this.ws.on('close', () => {
      if (!this.destroyed) {
        logger.warn('WsPoolMonitor disconnected — will reconnect');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'WsPoolMonitor WS error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2_000);
  }

  // ─── Message handling ─────────────────────────────────────────────────────

  private handleMessage(msg: any): void {
    // Subscription confirmation: { id, result: <subscriptionId> }
    if (typeof msg.result === 'number' && msg.id !== undefined) {
      const pool = this.pendingSubs.get(msg.id);
      if (pool) {
        this.pendingSubs.delete(msg.id);
        this.activeSubs.set(msg.result, pool);
        this.poolToSubId.set(pool, msg.result);
        logger.debug({ pool, subId: msg.result }, '📡 Pool subscribed');
      }
      return;
    }

    // Account notification
    if (msg.method !== 'accountNotification') return;
    const subId: number = msg.params?.subscription;
    const pool = this.activeSubs.get(subId);
    if (!pool) return;

    const dataArr: [string, string] | undefined = msg.params?.result?.value?.data;
    if (!dataArr || dataArr[1] !== 'base64') return;

    const raw = Buffer.from(dataArr[0], 'base64');
    // PumpSwap pool layout: baseReserves at byte 107, quoteReserves at byte 115
    if (raw.length < 123) return;

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const baseReserves = view.getBigUint64(107, true);
    const quoteReserves = view.getBigUint64(115, true);

    this.onUpdate(pool, baseReserves, quoteReserves);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  subscribeToPool(poolAddress: string): void {
    if (this.destroyed) return;
    if (this.poolToSubId.has(poolAddress)) return; // already subscribed

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Will re-subscribe on reconnect
      this.poolToSubId.set(poolAddress, -1);
      return;
    }

    const id = this.reqId++;
    this.pendingSubs.set(id, poolAddress);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'accountSubscribe',
      params: [poolAddress, { encoding: 'base64', commitment: 'processed' }],
    }));
  }

  unsubscribePool(poolAddress: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const subId = this.poolToSubId.get(poolAddress);
    if (subId === undefined || subId === -1) {
      this.poolToSubId.delete(poolAddress);
      return;
    }
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: this.reqId++,
      method: 'accountUnsubscribe',
      params: [subId],
    }));
    this.activeSubs.delete(subId);
    this.poolToSubId.delete(poolAddress);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  get isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
