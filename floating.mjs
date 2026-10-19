export const SIZE_KEY = 'wit_floating_size_v1';
export const DEFAULT_SIZE = 48;
export function normalizeSize(value) {
    const size = Number(value);
    return value == null || value === '' || !Number.isFinite(size) ? DEFAULT_SIZE : Math.min(72, Math.max(24, Math.round(size)));
}
export function readSize(storage) {
    try { return normalizeSize(storage?.getItem(SIZE_KEY)); } catch { return DEFAULT_SIZE; }
}
export function touchSize(size = DEFAULT_SIZE) { return Math.max(48, normalizeSize(size)); }
export const POSITION_KEY = 'wit_floating_position_v1';
export function readPosition(storage) {
    try {
        const p = JSON.parse(storage?.getItem(POSITION_KEY) || 'null');
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) return p;
    } catch {}
    return null;
}
export function viewportBounds(view = {}, size = DEFAULT_SIZE) {
    const width = view.width || 390, height = view.height || 700;
    const left = (view.offsetLeft || 0) + 4, top = (view.offsetTop || 0) + 4;
    return { left, top, rangeX: Math.max(0, width - touchSize(size) - 8), rangeY: Math.max(0, height - touchSize(size) - 8), width, height };
}
export function positionPixels(position, view, size = DEFAULT_SIZE) {
    const b = viewportBounds(view, size);
    return position ? { x: b.left + position.x * b.rangeX, y: b.top + position.y * b.rangeY }
        : { x: b.left + Math.max(0, b.width - touchSize(size) - 18), y: b.top + Math.min(b.rangeY, Math.max(0, b.height * .6 - 4)) };
}
export function normalizedPosition(x, y, view, size = DEFAULT_SIZE) {
    const b = viewportBounds(view, size);
    return { x: b.rangeX ? Math.min(1, Math.max(0, (x - b.left) / b.rangeX)) : 0,
        y: b.rangeY ? Math.min(1, Math.max(0, (y - b.top) / b.rangeY)) : 0 };
}
export function attachFloatingDrag(element, { getPosition, getViewport, getSize = () => DEFAULT_SIZE, preview, commit, restore }) {
    let drag = null, suppressClick = false;
    const onDown = e => {
        if (e.isPrimary === false || (e.button !== undefined && e.button !== 0)) return;
        const pixel = positionPixels(getPosition(), getViewport(), getSize());
        drag = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, pixel, moved: false, next: null };
        suppressClick = false;
        element.setPointerCapture?.(e.pointerId);
    };
    const onMove = e => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.clientX, dy = e.clientY - drag.clientY;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        drag.next = normalizedPosition(drag.pixel.x + dx, drag.pixel.y + dy, getViewport(), getSize());
        preview(drag.next);
        e.preventDefault?.();
    };
    const finish = (e, cancel = false) => {
        if (!drag || drag.id !== e.pointerId) return;
        const done = drag; drag = null;
        suppressClick = done.moved;
        if (cancel) restore(); else if (done.moved) commit(done.next);
        if (element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId);
    };
    const onUp = e => finish(e);
    const onCancel = e => finish(e, true);
    const onClick = e => {
        if (!suppressClick) return;
        suppressClick = false; e.preventDefault?.(); e.stopImmediatePropagation?.();
    };
    const handlers = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel], ['lostpointercapture', onCancel]];
    for (const [name, fn] of handlers) element.addEventListener(name, fn);
    element.addEventListener('click', onClick, true);
    return () => { for (const [name, fn] of handlers) element.removeEventListener(name, fn); element.removeEventListener('click', onClick, true); drag = null; };
}
