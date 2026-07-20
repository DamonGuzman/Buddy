/**
 * Renderer-side acknowledgement for a main-process-installed native glass
 * wrapper. Renderers must not remove their opaque fallback until main has
 * successfully installed NSGlassEffectView for that exact BrowserWindow.
 */
export function hasNativeGlass(search: string): boolean {
  return new URLSearchParams(search).get('nativeGlass') === '1';
}
