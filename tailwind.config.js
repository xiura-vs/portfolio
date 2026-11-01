module.exports = {
  content: ['./public/index.html', './public/js/app.js'],
  theme: {
    extend: {
      colors: {
        void: '#05060a', panel: '#0b0d14', edge: '#1a1e2e',
        neon: { cyan: '#00f0ff', violet: '#8b5cf6', magenta: '#ff2e97', lime: '#b6ff3b' }
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      },
      boxShadow: {
        'glow-cyan': '0 0 20px rgba(0,240,255,0.35)',
        'glow-violet': '0 0 20px rgba(139,92,246,0.35)'
      },
      keyframes: {
        blink: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
        scan: { '0%': { transform: 'translateY(-100%)' }, '100%': { transform: 'translateY(100%)' } },
        floaty: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } }
      },
      animation: {
        blink: 'blink 1s step-end infinite',
        scan: 'scan 6s linear infinite',
        floaty: 'floaty 4s ease-in-out infinite'
      }
    }
  }
};