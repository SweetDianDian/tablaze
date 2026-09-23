import { devices } from 'playwright';

const names = {
  'pixel-7': 'Pixel 7',
  'pixel-7-pro': 'Pixel 7 Pro',
} as const;

export type DevicePreset = keyof typeof names;
export const DEVICE_PRESETS = Object.freeze(Object.keys(names) as DevicePreset[]);

/** Use the pinned Playwright descriptors as one coherent Chromium configuration. */
export function devicePresetOptions(value: unknown) {
  if (typeof value !== 'string' || !Object.hasOwn(names, value)) return undefined;
  const descriptor = devices[names[value as DevicePreset]];
  if (!descriptor || descriptor.defaultBrowserType !== 'chromium') return undefined;
  const screen = (descriptor as typeof descriptor & { screen?: { width: number; height: number } }).screen ?? descriptor.viewport;
  return {
    viewport: { ...descriptor.viewport }, screen: { ...screen },
    deviceScaleFactor: descriptor.deviceScaleFactor, userAgent: descriptor.userAgent,
    isMobile: descriptor.isMobile, hasTouch: descriptor.hasTouch,
  };
}
