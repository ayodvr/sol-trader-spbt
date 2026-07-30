import { CONFIG } from '../config.js';
import pino from 'pino';

const logger = pino({ name: 'tip-calculator' });

export class TipCalculator {
  /**
   * Calculate a dynamic Jito tip based on the RugCheckResult score.
   * If dynamic tipping is disabled, it returns the static fallback tip.
   * 
   * @param score The safety/hype score of the token from the analyzer (e.g. 45 to 150)
   * @param isEmergency If true, returns the max tip to guarantee immediate inclusion
   * @returns The tip amount in lamports
   */
  public static calculateTip(score: number, isEmergency: boolean = false): number {
    if (!CONFIG.DYNAMIC_TIPPING_ENABLED) {
      return CONFIG.JITO_TIP_LAMPORTS;
    }

    const maxTipLamports = Math.floor(CONFIG.JITO_MAX_TIP_SOL * 1_000_000_000);
    const minTipLamports = Math.floor(CONFIG.JITO_MIN_TIP_SOL * 1_000_000_000);

    if (isEmergency) {
      logger.warn({ tip: CONFIG.JITO_MAX_TIP_SOL }, '🚨 Emergency tip applied');
      return maxTipLamports;
    }

    // Baseline passing score is 45 (as per analyzer.ts). 
    // A phenomenal score (great socials, great dev) might be 150+.
    // We linearly scale the tip between these bounds.
    const SCORE_MIN = 45;
    const SCORE_MAX = 120; // Cap scaling here to reach max tip

    // Clamp score
    const clampedScore = Math.max(SCORE_MIN, Math.min(score, SCORE_MAX));

    // Calculate percentage along the scale (0.0 to 1.0)
    const percentage = (clampedScore - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);

    // Calculate dynamic tip
    const dynamicTip = minTipLamports + (maxTipLamports - minTipLamports) * percentage;
    const roundedTip = Math.floor(dynamicTip);

    logger.debug({
      score,
      percentage: `${(percentage * 100).toFixed(1)}%`,
      tipSol: (roundedTip / 1_000_000_000).toFixed(5)
    }, 'Dynamic tip calculated');

    return roundedTip;
  }
}
