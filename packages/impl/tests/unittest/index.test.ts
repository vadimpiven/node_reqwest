import { describe, expect, it } from 'vitest';
import { hello } from '../../export/index.ts';

describe('hello', () => {
  it('should return hello', () => {
    expect(hello()).toBe('hello');
  });
});
