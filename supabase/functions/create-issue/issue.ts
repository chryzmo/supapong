// Checking a feedback submission and turning it into a GitHub issue.  Pure,
// with no Deno or npm imports, so the app's Vitest can test it
// (issue.test.ts) and the function can import it.

export const FEEDBACK_KINDS = ['bug', 'feature'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** The same limits as the feedback table's checks, so the form fails early with a clear message. */
export const TITLE_MIN = 3;
export const TITLE_MAX = 80;
export const BODY_MAX = 2000;
export const DOING_MAX = 1000;

export interface Feedback {
  kind: FeedbackKind;
  title: string;
  body: string;
  /** Bugs only, optional: what the player was doing. */
  doing?: string;
  /** What the app attaches: version, browser, screen.  Short strings, numbers and booleans. */
  context: Record<string, string | number | boolean>;
}

export interface Issue {
  title: string;
  body: string;
  labels: string[];
}

/** A submission as the function receives it, or why it won't do. */
export function parseFeedback(value: unknown): Feedback | string {
  if (typeof value !== 'object' || value === null) return 'Send the feedback as JSON.';
  const raw = value as Record<string, unknown>;
  if (!FEEDBACK_KINDS.includes(raw.kind as FeedbackKind)) return 'Say whether it’s a bug or a feature request.';
  const kind = raw.kind as FeedbackKind;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) return `Give it a title of ${TITLE_MIN} to ${TITLE_MAX} characters.`;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (body.length === 0 || body.length > BODY_MAX) return `Describe it in up to ${BODY_MAX} characters.`;
  const doing = kind === 'bug' && typeof raw.doing === 'string' ? raw.doing.trim() : '';
  if (doing.length > DOING_MAX) return `Keep “what you were doing” to ${DOING_MAX} characters.`;

  const context: Feedback['context'] = {};
  if (typeof raw.context === 'object' && raw.context !== null) {
    for (const [key, entry] of Object.entries(raw.context).slice(0, 10)) {
      if (!/^[a-z][a-zA-Z]{0,19}$/.test(key)) continue;
      if (typeof entry === 'string') context[key] = entry.slice(0, 200);
      else if (typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) context[key] = entry;
    }
  }
  return { kind, title, body, ...(doing ? { doing } : {}), context };
}

/**
 * The issue to file.  The player's words go inside code fences, so their
 * markdown, links, images and @mentions show as plain text: nobody gets
 * pinged, and nothing renders on the repo that the player wrote as markup.
 */
export function buildIssue(feedback: Feedback, displayName: string): Issue {
  const isBug = feedback.kind === 'bug';
  const sections = [
    `${isBug ? 'Bug report' : 'Feature request'} from ${inlineCode(displayName)}, sent from the in-app feedback form.`,
    `### ${isBug ? 'What happened' : 'The idea'}\n\n${fenced(feedback.body)}`,
    ...(feedback.doing ? [`### What they were doing\n\n${fenced(feedback.doing)}`] : []),
  ];
  const context = Object.entries(feedback.context);
  if (context.length > 0) {
    const rows = context.map(([key, value]) => `| ${key} | ${inlineCode(String(value))} |`);
    sections.push(`<details><summary>Context</summary>\n\n| | |\n|---|---|\n${rows.join('\n')}\n\n</details>`);
  }
  return {
    // Titles don't render markdown, but they do link #123 and @name.
    title: `[${isBug ? 'Bug' : 'Feature'}] ${defuse(feedback.title)}`,
    body: sections.join('\n\n'),
    labels: [isBug ? 'bug' : 'enhancement', 'from-app'],
  };
}

/** Text in a code block whose fence no run of backticks inside can close. */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Text in an inline code span, likewise unbreakable.  Pipes are escaped, for table cells. */
function inlineCode(text: string): string {
  const ticks = '`'.repeat(longestBacktickRun(text) + 1);
  return `${ticks} ${text.replace(/\|/g, '\\|').replace(/\n/g, ' ')} ${ticks}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** Breaks @mentions and #references with a zero-width space, so they don't link. */
function defuse(text: string): string {
  return text.replace(/([@#])(?=[\w-])/g, '$1​');
}
