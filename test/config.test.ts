import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

describe('loadConfig', () => {
  it('applies defaults when only GITHUB_TOKEN is set', () => {
    const config = loadConfig({ GITHUB_TOKEN: 'x' });
    expect(config).toEqual({
      githubToken: 'x',
      anthropicApiKey: null,
      anthropicModel: 'claude-opus-5-5',
      port: 3000,
      databasePath: './data/tempo.db',
      syncTtlMinutes: 15,
      syncMaxPages: 40,
      syncMaxSeconds: 25,
      logLevel: 'info',
    });
  });

  it('reads overrides and coerces numbers', () => {
    const config = loadConfig({
      GITHUB_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'k',
      PORT: '8080',
      SYNC_TTL_MINUTES: '5',
    });
    expect(config.anthropicApiKey).toBe('k');
    expect(config.port).toBe(8080);
    expect(config.syncTtlMinutes).toBe(5);
  });

  it('treats empty optional values as unset', () => {
    const config = loadConfig({ GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: '', PORT: '' });
    expect(config.anthropicApiKey).toBeNull();
    expect(config.port).toBe(3000);
  });

  it('throws ConfigError naming a missing GITHUB_TOKEN', () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: 'secret-value' })).toThrow(ConfigError);
    try {
      loadConfig({ ANTHROPIC_API_KEY: 'secret-value' });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('GITHUB_TOKEN');
      expect(message).not.toContain('secret-value');
    }
  });

  it('throws on a non-numeric PORT without echoing the value', () => {
    try {
      loadConfig({ GITHUB_TOKEN: 'tok-123', PORT: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toContain('PORT');
      expect(message).not.toContain('abc');
      expect(message).not.toContain('tok-123');
    }
  });

  it('lists every invalid variable', () => {
    try {
      loadConfig({ PORT: '0', SYNC_MAX_PAGES: '-1' });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('GITHUB_TOKEN');
      expect(message).toContain('PORT');
      expect(message).toContain('SYNC_MAX_PAGES');
    }
  });
});
