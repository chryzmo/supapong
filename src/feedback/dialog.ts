// The feedback dialog: a bug report or feature request, sent as a public
// GitHub issue.  Opens over whatever screen is showing, and removes itself
// when closed.
import { BODY_MAX, DOING_MAX, TITLE_MAX, parseFeedback, type FeedbackKind } from '../../supabase/functions/create-issue/issue';
import { onMobileBrowser } from '../game/touch';
import { errorMessage, h } from '../ui';
import { sendFeedback } from './api';

/** The repo the issues go to, named in the dialog so players know where their words end up. */
const REPO = 'chryzmo/supapong';

/** @param where Which screen it was opened from, for the issue's context. */
export function openFeedback(where: string): void {
  const kindInput = (kind: FeedbackKind, checked: boolean): HTMLInputElement =>
    h('input', { type: 'radio', name: 'kind', value: kind, checked });
  const bug = kindInput('bug', true);
  const feature = kindInput('feature', false);
  const title = h('input', { name: 'title', maxLength: TITLE_MAX, autocomplete: 'off', required: true });
  const body = h('textarea', { name: 'body', maxLength: BODY_MAX, rows: 5, required: true });
  const doing = h('textarea', { name: 'doing', maxLength: DOING_MAX, rows: 2 });
  const doingLabel = h('label', {}, 'What were you doing? (optional)', doing);
  const bodyLabel = h('span', {}, 'What happened?');
  const status = h('p', { className: 'error' });
  const send = h('button', { type: 'submit' }, 'Send');
  const cancel = h('button', { type: 'button', className: 'secondary' }, 'Cancel');

  const showKind = (): void => {
    doingLabel.hidden = !bug.checked;
    bodyLabel.textContent = bug.checked ? 'What happened?' : 'What would you like?';
  };
  bug.addEventListener('change', showKind);
  feature.addEventListener('change', showKind);
  showKind();

  const form = h(
    'form',
    { className: 'feedback-form' },
    h('h2', {}, 'Send feedback'),
    h(
      'div',
      { className: 'row kind' },
      h('label', { className: 'check' }, bug, 'Bug'),
      h('label', { className: 'check' }, feature, 'Feature request'),
    ),
    h('label', {}, 'Title', title),
    h('label', {}, bodyLabel, body),
    doingLabel,
    h('p', { className: 'muted' }, `This becomes a public issue on GitHub (${REPO}) under your display name, so leave out anything private.`),
    status,
    h('div', { className: 'row' }, send, cancel),
  );
  const dialog = h('dialog', { className: 'panel feedback' }, form);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const feedback = parseFeedback({
      kind: bug.checked ? 'bug' : 'feature',
      title: title.value,
      body: body.value,
      doing: doing.value,
      context: {
        version: __APP_VERSION__,
        where,
        screen: `${window.innerWidth}x${window.innerHeight}`,
        mobile: onMobileBrowser(),
        browser: navigator.userAgent,
      },
    });
    if (typeof feedback === 'string') {
      status.textContent = feedback;
      return;
    }
    send.disabled = true;
    status.textContent = '';
    void sendFeedback(feedback)
      .then(({ issueUrl }) => {
        const close = h('button', { type: 'button' }, 'Close');
        close.addEventListener('click', () => dialog.close());
        const link = issueUrl ? [h('a', { href: issueUrl, target: '_blank', rel: 'noopener' }, 'See it on GitHub')] : [];
        dialog.replaceChildren(
          h('h2', {}, 'Thank you!'),
          h('p', {}, issueUrl ? 'Your feedback is filed.' : 'Your feedback is saved.'),
          ...(link.length ? [h('p', {}, ...link)] : []),
          h('div', { className: 'row' }, close),
        );
      })
      .catch((err: unknown) => {
        status.textContent = errorMessage(err);
        send.disabled = false;
      });
  });

  document.body.append(dialog);
  dialog.showModal();
  title.focus();
}
