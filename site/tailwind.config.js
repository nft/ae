// Config for the committed site stylesheet. Regenerate after changing
// classes in site/*.html or site/*.js:  bun run site:css
export default {
  content: ['site/*.html', 'site/*.js'],
  theme: {
    extend: {
      colors: {
        cream: '#faf7f2',
        ink: '#2b2622',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
};
