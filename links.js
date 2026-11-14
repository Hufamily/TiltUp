/*
 * Public links: the ONE place these URLs live. The game, the web build, the social-card
 * generator and the store check all read this file.
 *
 *   site  - where the web version is hosted (GitHub Pages), ending in '/'.
 *           Used for share links (site + '?seed=N-XXXXXX') so friends without the
 *           extension, or on a phone, can play the challenge in a browser.
 *   store - the Chrome Web Store listing URL. Known after the first upload
 *           (https://chromewebstore.google.com/detail/<item-id>).
 *
 * Leave a value '' until it exists; the game hides whatever isn't set yet.
 * Both must be https:// (`npm run check` enforces it).
 */
window.TILT_LINKS = {
  site: 'https://hufamily.github.io/TiltUp/',
  store: 'https://chromewebstore.google.com/detail/gieekbbcppndlhdlhfcnoohhbidaonkb'
};
