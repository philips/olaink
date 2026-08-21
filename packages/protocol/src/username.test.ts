import { describe, expect, it } from 'vitest';
import { generateUniqueUsername, generateUsername, isValidUsername } from './username.ts';

describe('generateUsername', () => {
  it('produces adjective-noun-number names', () => {
    const seq = [0, 0, 0.42];
    let i = 0;
    const rand = () => {
      const v = seq[i % seq.length];
      i++;
      return v as number;
    };
    expect(generateUsername(rand)).toBe('amber-otter-42');
  });

  it('always yields structurally valid usernames', () => {
    for (let i = 0; i < 500; i++) {
      const name = generateUsername();
      expect(isValidUsername(name)).toBe(true);
    }
  });
});

describe('isValidUsername', () => {
  it('accepts well-formed names', () => {
    expect(isValidUsername('quiet-otter-42')).toBe(true);
    expect(isValidUsername('a')).toBe(true);
  });

  it('rejects bad shapes', () => {
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('Quiet')).toBe(false); // uppercase
    expect(isValidUsername('has space')).toBe(false);
    expect(isValidUsername('-leading')).toBe(false);
    expect(isValidUsername('trailing-')).toBe(false);
    expect(isValidUsername('double--dash')).toBe(false);
    expect(isValidUsername('x'.repeat(25))).toBe(false);
    expect(isValidUsername('echo')).toBe(false); // reserved
    expect(isValidUsername('server')).toBe(false); // reserved
  });
});

describe('generateUniqueUsername', () => {
  it('avoids taken names', () => {
    let seq = 0;
    // Deterministic walk: every pick returns increasing fractions.
    const rand = () => (seq++ % 90) / 90;
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const name = generateUniqueUsername(taken);
      expect(isValidUsername(name)).toBe(true);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it('never returns the same candidate as the only taken one when it can help it', () => {
    // Force a collision: rand always picks the same slot.
    const rand = () => 0.5;
    const first = generateUsername(rand);
    const second = generateUniqueUsername([first], rand);
    // With a fully deterministic rand the fallback path (extra suffix) kicks in,
    // producing a different string.
    expect(second).not.toBe(first);
  });
});
