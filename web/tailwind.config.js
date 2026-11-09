/** @type {import('tailwindcss').Config} */

// Colours come from CSS variables (see src/index.css) so the whole app
// switches between light and dark mode without changing any component.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        green: {
          DEFAULT: v('green'),
          dark: '#064726',
          deep: '#03301A',
          light: v('green-light'),
          mid: '#CFE6D6',
        },
        // Fixed NYSC green, for text that sits on something that is always white.
        brand: '#0B6B3A',
        paper: v('paper'),
        card: v('card'),
        ink: v('ink'),
        muted: v('muted'),
        line: v('line'),
        khaki: '#C9B783',
        warn: { DEFAULT: v('warn'), bg: v('warn-bg') },
        bad: { DEFAULT: '#B42318', bg: v('bad-bg') },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 10px 30px rgb(var(--shadow) / 0.12)',
        lift: '0 24px 60px rgba(3, 48, 26, 0.35)',
      },
    },
  },
  plugins: [],
};
