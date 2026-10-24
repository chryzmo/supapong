import { describe, expect, it } from 'vitest';
import { BODY_MAX, buildIssue, parseFeedback, type Feedback } from './issue';

const bug: Feedback = {
  kind: 'bug',
  title: 'Ball went through my paddle',
  body: 'It passed right through.',
  doing: 'Playing with 4 bots',
  context: { version: 'abc1234', mobile: false },
};

describe('parseFeedback', () => {
  it('takes a bug report or a feature request, trimmed', () => {
    expect(parseFeedback({ ...bug, title: '  Ball went through my paddle  ' })).toEqual(bug);
    expect(parseFeedback({ kind: 'feature', title: 'Spectators', body: 'Let me watch.', doing: 'ignored for features', context: {} })).toEqual({
      kind: 'feature',
      title: 'Spectators',
      body: 'Let me watch.',
      context: {},
    });
  });

  it('keeps only short, simple context', () => {
    const parsed = parseFeedback({ ...bug, context: { version: 'x'.repeat(500), screen: '390x844', 'Bad Key': 1, nested: { a: 1 }, mobile: true } });
    expect(typeof parsed !== 'string' && parsed.context).toEqual({ version: 'x'.repeat(200), screen: '390x844', mobile: true });
  });

  it.each([
    ['nothing', null],
    ['an unknown kind', { ...bug, kind: 'complaint' }],
    ['a short title', { ...bug, title: 'hi' }],
    ['a long title', { ...bug, title: 'x'.repeat(81) }],
    ['an empty description', { ...bug, body: '   ' }],
    ['a long description', { ...bug, body: 'x'.repeat(BODY_MAX + 1) }],
  ])('refuses %s, saying why', (_label, value) => {
    expect(typeof parseFeedback(value)).toBe('string');
  });
});

describe('buildIssue', () => {
  it('labels bugs and feature requests, and credits the player by name', () => {
    const issue = buildIssue(bug, 'Ada');
    expect(issue.title).toBe('[Bug] Ball went through my paddle');
    expect(issue.labels).toEqual(['bug', 'from-app']);
    expect(issue.body).toContain('Bug report from ` Ada `');
    expect(issue.body).toContain('### What they were doing');
    expect(buildIssue({ ...bug, kind: 'feature' }, 'Ada').labels).toEqual(['enhancement', 'from-app']);
  });

  it("keeps the player's words as plain text, however they're written", () => {
    const sneaky = { ...bug, body: 'Hi @octocat ![x](https://evil.example/x.png)\n```\n# not a heading\n```\nbye' };
    const { body } = buildIssue(sneaky, 'Ada');
    // The fence is longer than any run of backticks inside, so it can't be closed early.
    expect(body).toContain('````text\nHi @octocat');
    expect(body).toContain('bye\n````');
  });

  it("breaks @mentions and #references in the title, so nobody's pinged", () => {
    const { title } = buildIssue({ ...bug, title: 'Ping @octocat about #12' }, 'Ada');
    expect(title).toBe('[Bug] Ping @​octocat about #​12');
  });

  it('puts the context in a collapsed table, escaping what could break it', () => {
    const { body } = buildIssue({ ...bug, context: { screen: '390|844' } }, 'A `name`');
    expect(body).toContain('<details><summary>Context</summary>');
    expect(body).toContain('| screen | ` 390\\|844 ` |');
    expect(body).toContain('from `` A `name` ``');
  });
});
