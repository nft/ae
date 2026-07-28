// Tiny syntax highlighter for the static code samples on the site pages.
// Runs once per <code class="hl"> on import — no dependencies, no build step.

const TOKENS = new RegExp(
  [
    '(\\/\\/[^\\n]*)', // line comment
    '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)', // string
    '\\b(const|let|var|import|export|from|return|if|else|new|for|of|in|function|class|async|await|try|catch|typeof)\\b', // keyword
    '\\b(ae)\\b(?=[.(])', // the library itself
    '(data-ae)', // the one attribute
  ].join('|'),
  'g',
);

const COMMENT = 'text-stone-500';
const STRING = 'text-amber-200/90';
const KEYWORD = 'text-orange-300';
const IDENT = 'text-amber-400';

/** Highlight every un-highlighted `code.hl` inside `root`. */
export function highlight(root = document) {
  for (const el of root.querySelectorAll('code.hl')) {
    if (el.dataset.hl === 'done') continue;
    el.dataset.hl = 'done';
    const escaped = el.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    el.innerHTML = escaped.replace(TOKENS, (match, comment, string, keyword) =>
      comment
        ? `<span class="${COMMENT}">${comment}</span>`
        : string
          ? `<span class="${STRING}">${string}</span>`
          : keyword
            ? `<span class="${KEYWORD}">${keyword}</span>`
            : `<span class="${IDENT}">${match}</span>`,
    );
  }
}

highlight();
