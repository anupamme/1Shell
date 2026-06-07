/// <reference types="vite/client" />

interface OneShellDesktopSettings {
  available: boolean;
  platform: string;
  port: number;
  url: string;
  startAtLogin: boolean;
  backgroundOnClose: boolean;
  serviceRunning: boolean;
  serviceManaged: boolean;
  dataDir: string;
  envFile: string;
}

interface OneShellDesktopBridge {
  isDesktop: boolean;
  getSettings(): Promise<OneShellDesktopSettings>;
  updateSettings(patch: Partial<Pick<OneShellDesktopSettings, 'startAtLogin' | 'backgroundOnClose'>>): Promise<OneShellDesktopSettings>;
  openWindow(): Promise<OneShellDesktopSettings>;
  quit(): Promise<void>;
}

interface Window {
  oneshellDesktop?: OneShellDesktopBridge;
}
