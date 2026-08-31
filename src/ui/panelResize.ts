import type { ViewerContext } from '../viewer/viewerEngine.js';
import { btnToggleProps, propsDrawer, propsResizer, sidebar, sidebarResizer } from './dom.js';

const SIDEBAR_STORAGE_KEY = 'gim-viewer-sidebar-width';
const PROPS_STORAGE_KEY = 'gim-viewer-props-width';
const MIN_SIDEBAR_WIDTH = 240;
const MIN_PROPS_WIDTH = 280;
const MIN_VIEWPORT_WIDTH = 360;
const MAX_PANEL_WIDTH = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readStoredWidth(key: string, fallback: number): number {
  const parsed = Number.parseFloat(localStorage.getItem(key) || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setPanelWidth(side: 'sidebar' | 'props', width: number): void {
  const property = side === 'sidebar' ? '--sidebar-width' : '--props-width';
  document.documentElement.style.setProperty(property, `${Math.round(width)}px`);
  if (side === 'props' && !propsDrawer.classList.contains('collapsed')) {
    btnToggleProps.style.right = `${Math.round(width) + 14}px`;
  }
}

function refreshViewport(ctx: ViewerContext): void {
  requestAnimationFrame(() => ctx.fragments.core.update(true));
}

function setupHandle(
  ctx: ViewerContext,
  handle: HTMLElement,
  side: 'sidebar' | 'props',
  storageKey: string,
): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === 'sidebar' ? sidebar.getBoundingClientRect().width : propsDrawer.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('panel-resizing');

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const otherWidth = side === 'sidebar' ? propsDrawer.getBoundingClientRect().width : sidebar.getBoundingClientRect().width;
      const available = window.innerWidth - otherWidth - MIN_VIEWPORT_WIDTH;
      const min = side === 'sidebar' ? MIN_SIDEBAR_WIDTH : MIN_PROPS_WIDTH;
      const next = side === 'sidebar' ? startWidth + delta : startWidth - delta;
      const width = clamp(next, min, Math.min(MAX_PANEL_WIDTH, available));
      setPanelWidth(side, width);
      handle.setAttribute('aria-valuenow', String(Math.round(width)));
      refreshViewport(ctx);
    };

    const onEnd = () => {
      const width = side === 'sidebar' ? sidebar.getBoundingClientRect().width : propsDrawer.getBoundingClientRect().width;
      localStorage.setItem(storageKey, String(Math.round(width)));
      handle.classList.remove('dragging');
      document.body.classList.remove('panel-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      refreshViewport(ctx);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  });
}

/** 允许横向拖动左右分隔线，并记住用户上次设置的面板宽度。 */
export function setupPanelResize(ctx: ViewerContext): void {
  const sidebarMax = Math.min(MAX_PANEL_WIDTH, window.innerWidth - MIN_PROPS_WIDTH - MIN_VIEWPORT_WIDTH);
  const sidebarWidth = clamp(readStoredWidth(SIDEBAR_STORAGE_KEY, sidebar.getBoundingClientRect().width), MIN_SIDEBAR_WIDTH, sidebarMax);
  const propsMax = Math.min(MAX_PANEL_WIDTH, window.innerWidth - sidebarWidth - MIN_VIEWPORT_WIDTH);
  const propsWidth = clamp(readStoredWidth(PROPS_STORAGE_KEY, propsDrawer.getBoundingClientRect().width), MIN_PROPS_WIDTH, propsMax);
  setPanelWidth('sidebar', sidebarWidth);
  setPanelWidth('props', propsWidth);
  sidebarResizer.setAttribute('aria-valuemin', String(MIN_SIDEBAR_WIDTH));
  sidebarResizer.setAttribute('aria-valuemax', String(MAX_PANEL_WIDTH));
  sidebarResizer.setAttribute('aria-valuenow', String(Math.round(sidebarWidth)));
  propsResizer.setAttribute('aria-valuemin', String(MIN_PROPS_WIDTH));
  propsResizer.setAttribute('aria-valuemax', String(MAX_PANEL_WIDTH));
  propsResizer.setAttribute('aria-valuenow', String(Math.round(propsWidth)));
  setupHandle(ctx, sidebarResizer, 'sidebar', SIDEBAR_STORAGE_KEY);
  setupHandle(ctx, propsResizer, 'props', PROPS_STORAGE_KEY);
  window.addEventListener('resize', () => {
    const currentSidebar = sidebar.getBoundingClientRect().width;
    const currentProps = propsDrawer.classList.contains('collapsed') ? 0 : propsDrawer.getBoundingClientRect().width;
    const fittedSidebar = clamp(currentSidebar, MIN_SIDEBAR_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - currentProps - MIN_VIEWPORT_WIDTH));
    const fittedProps = clamp(currentProps || propsWidth, MIN_PROPS_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - fittedSidebar - MIN_VIEWPORT_WIDTH));
    setPanelWidth('sidebar', fittedSidebar);
    setPanelWidth('props', fittedProps);
    refreshViewport(ctx);
  });
}
