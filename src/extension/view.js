// iframe内部のvideoだけでは、親側の先読み/非表示状態は判定できない。
export function visibleElement(node) {
  if (!node?.isConnected) return false;
  // Driveは独自の操作UIを使うため、表示中のvideo自身にもaria-hiddenを付ける。
  for (let ancestor = node; ancestor?.nodeType === 1; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (ancestor.hidden || (ancestor.tagName !== 'VIDEO' && ancestor.getAttribute('aria-hidden') === 'true') ||
        style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
    rect.left < window.innerWidth && rect.top < window.innerHeight;
}
export function playerFrame(node) {
  try {
    const url = new URL(node.src);
    return url.protocol === 'https:' && (url.hostname === 'youtube.googleapis.com'
      ? url.pathname === '/embed/' && url.searchParams.get('ps') === 'docs' && url.searchParams.get('origin') === 'https://drive.google.com'
      : ['drive.google.com', 'docs.google.com'].includes(url.hostname) && /^\/file\/d\/[A-Za-z0-9_-]+\/(preview|view)$/.test(url.pathname));
  } catch { return false; }
}
export function visiblePlayers() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visibleElement);
  const scope = dialogs.length === 1 ? dialogs[0] : document;
  if (dialogs.length > 1) return [];
  return [...scope.querySelectorAll('video,iframe[src]')].filter(node => visibleElement(node) && (node.tagName === 'VIDEO' || playerFrame(node)));
}
