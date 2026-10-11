import { describe, expect, it } from 'vitest';
import { Gauge } from '../src/engine/index.js';

describe('Gauge', () => {
  it('defaults to full', () => {
    const hp = new Gauge('hp', 100);
    expect(hp.current).toBe(100);
    expect(hp.max).toBe(100);
    expect(hp.isFull).toBe(true);
  });

  it('accepts a starting current value', () => {
    const mana = new Gauge('mana', 50, { current: 20 });
    expect(mana.current).toBe(20);
    expect(mana.isFull).toBe(false);
  });

  it('clamps current to [min, max] on write', () => {
    const hp = new Gauge('hp', 100, { current: 50 });
    hp.current = 150;
    expect(hp.current).toBe(100);
    hp.current = -10;
    expect(hp.current).toBe(0);
    expect(hp.isEmpty).toBe(true);
  });

  it('supports a custom min', () => {
    const hp = new Gauge('hp', 100, { min: 10, current: 5 });
    expect(hp.current).toBe(10);
  });

  it('can disable clamping', () => {
    const hp = new Gauge('hp', 100, { clamp: false });
    hp.current = 130;
    expect(hp.current).toBe(130);
    hp.max = 50;
    expect(hp.current).toBe(130);
  });

  it('re-clamps current when max shrinks below it', () => {
    const hp = new Gauge('hp', 100, { current: 80 });
    hp.max = 50;
    expect(hp.current).toBe(50);
  });

  it('rejects invalid max values', () => {
    expect(() => new Gauge('hp', -5)).toThrow();
    expect(() => new Gauge('hp', Number.NaN)).toThrow();
  });
});
