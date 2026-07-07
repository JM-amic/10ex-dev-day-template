import confetti from 'canvas-confetti';
import type { ExpressionContext } from '../types';

export function triggerConfetti(
  _payload: unknown,
  _context: ExpressionContext
): void {
  confetti({
    particleCount: 120,
    spread: 70,
    origin: { y: 0.7 },
  });
}
