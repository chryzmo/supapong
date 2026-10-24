import { describe, expect, it } from 'vitest';
import { isMobileBrowser, type BrowserTraits } from './touch';

const desktop: BrowserTraits = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  maxTouchPoints: 0,
  touchOnly: false,
};

describe('isMobileBrowser', () => {
  it('is false on a desktop browser', () => {
    expect(isMobileBrowser(desktop)).toBe(false);
  });

  it('is false on a touch-screen laptop, whose primary pointer is still a mouse', () => {
    expect(isMobileBrowser({ ...desktop, maxTouchPoints: 10 })).toBe(false);
  });

  it('trusts Client Hints', () => {
    expect(isMobileBrowser({ ...desktop, uaMobile: true })).toBe(true);
  });

  it.each([
    ['Android', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'],
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'],
  ])('recognises an %s user agent', (_, userAgent) => {
    expect(isMobileBrowser({ ...desktop, userAgent })).toBe(true);
  });

  it('recognises an iPad, which reports a Mac user agent', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
    expect(isMobileBrowser({ ...desktop, userAgent: mac, maxTouchPoints: 5 })).toBe(true);
    expect(isMobileBrowser({ ...desktop, userAgent: mac, maxTouchPoints: 0 })).toBe(false);
  });

  it('falls back to a touch-only primary pointer', () => {
    expect(isMobileBrowser({ ...desktop, touchOnly: true })).toBe(true);
  });

  it('lets ?touch=1 and ?touch=0 force the answer', () => {
    expect(isMobileBrowser({ ...desktop, override: '1' })).toBe(true);
    expect(isMobileBrowser({ ...desktop, uaMobile: true, override: '0' })).toBe(false);
  });
});
