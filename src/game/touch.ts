// On-screen paddle buttons for phones and tablets.  They're shown only on a
// mobile browser, and feed the same PaddleInput as the keyboard, so the host
// and client code doesn't know the difference.
import { h } from '../ui';
import { TOUCH_LEFT, TOUCH_RIGHT, type PaddleInput } from './input';

/** What isMobileBrowser looks at, so it can be tested without a browser. */
export interface BrowserTraits {
  userAgent: string;
  /** navigator.userAgentData.mobile, where supported (Chromium). */
  uaMobile?: boolean;
  maxTouchPoints: number;
  /** The primary pointer is a finger and can't hover: (pointer: coarse) and (hover: none). */
  touchOnly: boolean;
  /** `?touch=1` or `?touch=0` in the URL forces the answer, for trying it on a desktop. */
  override?: string | null;
}

/**
 * True on a phone or tablet.  Client Hints answer directly where they exist.
 * Otherwise the user agent decides, except for iPads, which report a desktop
 * Mac user agent but have a touch screen.  A touch-only primary pointer
 * catches the rest.  A laptop with a touch screen still has a mouse or
 * trackpad as its primary pointer, so it gets no buttons.
 */
export function isMobileBrowser(traits: BrowserTraits): boolean {
  if (traits.override === '1') return true;
  if (traits.override === '0') return false;
  if (traits.uaMobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(traits.userAgent)) return true;
  if (/Macintosh/.test(traits.userAgent) && traits.maxTouchPoints > 1) return true;
  return traits.touchOnly;
}

/** isMobileBrowser for the current page. */
export function onMobileBrowser(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  return isMobileBrowser({
    userAgent: navigator.userAgent,
    ...(uaData?.mobile !== undefined ? { uaMobile: uaData.mobile } : {}),
    maxTouchPoints: navigator.maxTouchPoints,
    touchOnly: matchMedia('(pointer: coarse) and (hover: none)').matches,
    override: new URLSearchParams(location.search).get('touch'),
  });
}

/**
 * Two hold-to-move buttons, left and right on screen, like ← and →.  Each
 * tracks its own pointers, so a second finger on the same button, or one
 * that slides off, doesn't release it early.
 */
export function touchControls(input: PaddleInput): HTMLElement {
  const button = (code: string, label: string, text: string): HTMLButtonElement => {
    const el = h('button', { type: 'button', className: 'touch-button' }, text);
    el.setAttribute('aria-label', label);
    const pointers = new Set<number>();
    const release = (e: PointerEvent): void => {
      if (!pointers.delete(e.pointerId) || pointers.size > 0) return;
      el.classList.remove('pressed');
      input.hold(code, false);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // Keep getting this pointer's events even if the finger slides off.
      el.setPointerCapture(e.pointerId);
      pointers.add(e.pointerId);
      // :active is unreliable on touch screens, so the pressed look is a class.
      el.classList.add('pressed');
      input.hold(code, true);
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    // A long press would otherwise open the context menu or select text.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  };

  return h(
    'div',
    { className: 'touch-controls' },
    button(TOUCH_LEFT, 'Move left', '◀'),
    button(TOUCH_RIGHT, 'Move right', '▶'),
  );
}
