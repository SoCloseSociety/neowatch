/** @type {import('tailwindcss').Config} */
// Sentinel TV OS tokens (index.css :root, Lunaire + Doux). Every colour reads a
// CSS variable, so the theme switch is a `data-theme` flip and nothing else.
// The existing class names are kept and re-pointed (spec 1.2): `accent` is BONE
// (the primary, the selection, the focus), never mint; mint is `ok` (state only).
const rgbVar = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // The design classes of index.css (@layer components) are always emitted, so a
  // lot may build them dynamically (`btn-${variant}`) without Tailwind purging them.
  safelist: [
    'btn', 'btn-primary', 'btn-secondary', 'btn-quiet', 'btn-danger', 'btn-icon',
    'pill', 'pill-live', 'pill-pulse', 'pill-ok', 'pill-att', 'pill-alert',
    'overline', 'meta', 'brand', 'kbd', 'row', 'row-title', 'row-track', 'card-surface',
    'scrim-hero', 'text-on-image', 'thread', 'toast', 'glass', 'input', 'field-input', 'lift',
  ],
  theme: {
    extend: {
      colors: {
        accent: rgbVar('--accent-rgb'),
        'accent-soft': 'rgb(var(--accent-rgb) / 0.08)',
        ink: rgbVar('--ink'),
        'ink-2': rgbVar('--ink-2'),
        'ink-3': rgbVar('--ink-3'),
        surface: rgbVar('--surface'),
        panel: rgbVar('--panel'),
        'panel-2': rgbVar('--panel-2'),
        // State colours (word + glyph always go with them).
        live: rgbVar('--live'),
        gold: rgbVar('--gold'),
        ok: rgbVar('--ok'),
        // New token colours (no alpha modifier: they are full colours).
        line: 'var(--line)',
        'line-soft': 'var(--line-soft)',
        'line-strong': 'var(--line-strong)',
        primary: 'var(--primaire-fond)',
        'primary-ink': 'var(--primaire-encre)',
        mint: 'var(--mint)',
        amber: 'var(--amber)',
        red: 'var(--red)',
        cyan: 'var(--cyan)',
        violet: 'var(--violet)',
        card: 'var(--surface-carte)',
        mini: 'var(--surface-mini)',
        pillbg: 'var(--surface-pill)',
        'image-ink': 'var(--encre-image)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'Arial', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      // Type scale (x --ech, floor 12 px; TV uses the 1920-unit block).
      fontSize: {
        min: 'var(--ts-min)',
        sur: ['var(--ts-sur)', { letterSpacing: 'var(--ls-sur)' }],
        meta: 'var(--ts-meta)',
        sous: 'var(--ts-sous)',
        libelle: 'var(--ts-libelle)',
        corps: ['var(--ts-corps)', { lineHeight: 'var(--lh-corps)' }],
        carte: 'var(--ts-carte)',
        rangee: 'var(--ts-rangee)',
        titre2: ['var(--ts-titre-2)', { lineHeight: 'var(--lh-titre)' }],
        titre: ['var(--ts-titre)', { lineHeight: 'var(--lh-titre)', letterSpacing: 'var(--ls-titre)' }],
        geant: ['var(--ts-geant)', { lineHeight: 'var(--lh-titre)', letterSpacing: 'var(--ls-geant)' }],
      },
      borderRadius: {
        card: 'var(--rayon)',
        field: 'var(--rayon-sm)',
        pill: 'var(--rp)',
      },
      boxShadow: {
        ring: 'var(--anneau)',
        panel: 'var(--ombre-panneau)',
        toast: 'var(--ombre-toast)',
        menu: 'var(--ombre-menu)',
      },
      transitionDuration: {
        d1: 'var(--d1)',
        d2: 'var(--d2)',
        d3: 'var(--d3)',
      },
      transitionTimingFunction: {
        ease: 'var(--ease)',
      },
      // Only transform/opacity animate (Sentinel rule). One stepped pulse for
      // the LIVE point, one fade. pulse-live, pulse-green, shimmer, rise and
      // kenburns are gone: a leftover class is a harmless no-op.
      animation: {
        // Two states (on 1.2 s / dim 1.2 s), no interpolation: cheap on a TV SoC.
        'pulse-red': 'nwPulse 2.4s steps(1, end) infinite',
        'fade-in': 'fadeIn var(--d2) var(--ease)',
      },
      keyframes: {
        nwPulse: {
          '0%': { opacity: '1' },
          '50%, 100%': { opacity: '.35' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
