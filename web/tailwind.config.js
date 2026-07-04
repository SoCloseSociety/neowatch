/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Driven by CSS variables so the accent/theme can change at runtime.
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent) / 0.12)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-2': 'rgba(230,235,242,0.58)',
        'ink-3': 'rgba(230,235,242,0.34)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        'panel-2': '#19212f',
        // Fixed brand colours (independent of the runtime accent).
        live: '#FF3B47',
        gold: '#F5C451',
        ok: '#34D399',
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        'pulse-live': 'pulseLive 1.6s ease-in-out infinite',
        'pulse-red': 'nwPulse 1.9s ease-in-out infinite',
        'pulse-green': 'nwPulseG 2s ease-in-out infinite',
        'fade-in': 'fadeIn 0.25s ease-out',
        rise: 'nwUp 0.5s ease-out both',
        shimmer: 'shimmer 1.4s linear infinite',
      },
      keyframes: {
        pulseLive: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        nwPulse: {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(255,59,71,.55)' },
          '50%': { opacity: '.6', boxShadow: '0 0 0 6px rgba(255,59,71,0)' },
        },
        nwPulseG: {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(52,211,153,.5)' },
          '50%': { opacity: '.55', boxShadow: '0 0 0 5px rgba(52,211,153,0)' },
        },
        nwUp: {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'none' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
