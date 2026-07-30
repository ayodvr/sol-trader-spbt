import axios from 'axios';
import pino from 'pino';

const logger = pino({ name: 'telegram' });

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId && botToken !== '' && chatId !== '');

    if (!this.enabled) {
      logger.warn('Telegram not configured — notifications disabled');
    }
  }

  private async send(message: string): Promise<void> {
    if (!this.enabled) return;

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 10_000 }
      );
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Telegram send failed');
    }
  }

  async onSnipe(params: {
    mint: string;
    solSpent: string;
    tokenAmount: string;
    bundleId: string;
    score: number;
    flags: string[];
  }): Promise<void> {
    const message = `
🎯 <b>SNIPE CONFIRMED</b>

<b>Token:</b> <code>${params.mint}</code>
<b>SOL Spent:</b> ${params.solSpent}
<b>Tokens:</b> ${params.tokenAmount}
<b>Rug Score:</b> ${params.score}/100
${params.flags.length > 0 ? `<b>Flags:</b> ${params.flags.join(', ')}` : ''}
<b>Bundle:</b> <code>${params.bundleId}</code>

<a href="https://pump.fun/${params.mint}">📈 View on Pump.fun</a>
    `.trim();

    await this.send(message);
  }

  async onExit(params: {
    mint: string;
    reason: string;
    profitPercent: string;
    solReturned: string;
    bundleId?: string;
  }): Promise<void> {
    const emoji = params.reason === 'take_profit' ? '💰'
      : params.reason === 'stop_loss' ? '🛑'
      : params.reason === 'rug_detected' ? '🚨'
      : '📤';

    const message = `
${emoji} <b>EXIT: ${params.reason.toUpperCase().replace('_', ' ')}</b>

<b>Token:</b> <code>${params.mint}</code>
<b>PnL:</b> ${params.profitPercent}
<b>SOL returned:</b> ${params.solReturned}
${params.bundleId ? `<b>Bundle:</b> <code>${params.bundleId}</code>` : ''}
    `.trim();

    await this.send(message);
  }

  async onError(params: {
    context: string;
    error: string;
    mint?: string;
  }): Promise<void> {
    const message = `
❌ <b>ERROR: ${params.context}</b>

<code>${params.error}</code>
${params.mint ? `<b>Token:</b> <code>${params.mint}</code>` : ''}
    `.trim();

    await this.send(message);
  }

  async onStart(params: {
    snipeAmount: string;
    profitTarget: string;
    stopLoss: string;
    jitoTip: string;
    rpcEndpoint: string;
  }): Promise<void> {
    const message = `
🤖 <b>Pump.fun Sniper Bot — ONLINE</b>

<b>Snipe:</b> ${params.snipeAmount} SOL
<b>Take profit:</b> ${params.profitTarget}
<b>Stop loss:</b> ${params.stopLoss}
<b>Jito tip:</b> ${params.jitoTip} SOL
<b>RPC:</b> <code>${params.rpcEndpoint}</code>
<b>VPS:</b> London 🇬🇧
    `.trim();

    await this.send(message);
  }

  async onSummary(params: {
    totalSniped: number;
    successfulExits: number;
    rugSkips: number;
    totalPnlSol: string;
    winRate: string;
  }): Promise<void> {
    const message = `
📊 <b>Trading Summary</b>

<b>Total sniped:</b> ${params.totalSniped}
<b>Successful exits:</b> ${params.successfulExits}
<b>Rugs skipped:</b> ${params.rugSkips}
<b>P&amp;L:</b> ${params.totalPnlSol} SOL
<b>Win rate:</b> ${params.winRate}
    `.trim();

    await this.send(message);
  }
}
