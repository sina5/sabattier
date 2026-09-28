import { h } from '../dom.js';
import { icon } from '../icons.js';
import { backend } from '../backend.js';
import { SPONSOR_URL, heartIcon } from './AboutDialog.js';

const LAUNCHES_KEY = 'sabattier.launchCount';
const DISMISSED_KEY = 'sabattier.supportNoteDismissed';
const SHOW_AFTER_LAUNCHES = 20;

/** Counts this launch and reports whether the note is due: from the 20th launch until dismissed. */
function countLaunch() {
  const launches = Number(localStorage.getItem(LAUNCHES_KEY) ?? 0) + 1;
  localStorage.setItem(LAUNCHES_KEY, String(launches));
  return launches >= SHOW_AFTER_LAUNCHES && localStorage.getItem(DISMISSED_KEY) !== 'true';
}

/** A one-time corner note asking regular users to sponsor or review the app. */
export function SupportNote() {
  const el = h('aside', { className: 'support-note', role: 'status', hidden: !countLaunch() });
  // Any choice, including just closing it, ends the note for good.
  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    el.hidden = true;
  };
  const review = h(
    'button',
    { className: 'btn', hidden: true, onClick: () => (dismiss(), void backend.openReview()) },
    'Leave a review',
  );
  backend
    .reviewAvailable()
    .then((ok) => (review.hidden = !ok))
    .catch(() => {});

  el.append(
    h(
      'button',
      { className: 'support-note-close', 'aria-label': 'Dismiss', onClick: dismiss },
      icon('close', 16),
    ),
    h('div', { className: 'support-note-title' }, heartIcon(18), 'Enjoying Sabattier?'),
    h(
      'p',
      { className: 'support-note-text' },
      'It is free and built by one person. A sponsorship or a review helps keep it going.',
    ),
    h(
      'div',
      { className: 'support-note-actions' },
      h(
        'button',
        { className: 'btn primary', onClick: () => (dismiss(), void backend.openLink(SPONSOR_URL)) },
        'Support this project',
      ),
      review,
    ),
  );
  return el;
}
