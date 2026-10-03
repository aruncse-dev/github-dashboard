import { defineConfig, type Plugin } from 'vite';

// Locks the built page down so it can only talk to GitHub's API and load GitHub avatars.
// Applied to production builds only (the dev server needs its own websocket).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  'connect-src https://api.github.com',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build works under any GitHub Pages sub-path.
  base: './',
  plugins: [contentSecurityPolicy()],
  // Listen on all interfaces so phones on the same Wi-Fi can open the dev/preview server.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022' },
});
