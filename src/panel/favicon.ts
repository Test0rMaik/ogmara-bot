/**
 * The panel's favicon — the official Ogmara monogram.
 *
 * Byte-for-byte the project logo (`assets/logo-concepts/concept-3-monogram.svg`
 * in the planning hub, and the same file `web/public/favicon.svg` ships), not a
 * lookalike drawn for this repo. The standing rule is that every favicon, app
 * icon and tray icon renders from that one source; a "close enough" placeholder
 * is how a project ends up with five slightly different logos.
 *
 * Inlined as a string rather than added as a static file because the panel has
 * no static-file serving at all — the page and its script are both rendered
 * from code, and adding a file-serving path just for an icon would mean adding
 * a path-resolution surface to an authenticated admin server.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f0f1a"/>
      <stop offset="100%" style="stop-color:#1a0f2e"/>
    </linearGradient>
    <linearGradient id="grad3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#a855f7"/>
      <stop offset="50%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#3b82f6"/>
    </linearGradient>
    <linearGradient id="grad3b" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#c084fc"/>
      <stop offset="100%" style="stop-color:#818cf8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg3)"/>
  <circle cx="256" cy="256" r="120" fill="none" stroke="url(#grad3)" stroke-width="36"
          stroke-linecap="round" stroke-dasharray="300 50 200 50" transform="rotate(-30 256 256)"/>
  <circle cx="256" cy="256" r="72" fill="none" stroke="url(#grad3b)" stroke-width="4" opacity="0.5"
          stroke-dasharray="8 12"/>
  <rect x="236" y="236" width="40" height="40" rx="4"
        fill="url(#grad3)" transform="rotate(45 256 256)"/>
  <circle cx="256" cy="136" r="6" fill="#a855f7" opacity="0.6"/>
  <circle cx="360" cy="310" r="6" fill="#6366f1" opacity="0.6"/>
  <circle cx="152" cy="310" r="6" fill="#3b82f6" opacity="0.6"/>
</svg>
`;
