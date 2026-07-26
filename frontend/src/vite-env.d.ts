/// <reference types="vite/client" />

interface OneShellDesktopSettings {
  available: boolean;
  platform: string;
  port: number;
  url: string;
  startAtLogin: boolean;
  backgroundOnClose: boolean;
  skipLocalLogin: boolean;
  serviceRunning: boolean;
  serviceManaged: boolean;
  dataDir: string;
  envFile: string;
}

interface OneShellUpdateState {
  supported: boolean;
  currentVersion: string;
  githubUrl: string;
  releasesUrl: string;
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  version: string;
  releaseNotes: string;
  percent: number;
  error: string;
}

interface OneShellDesktopBridge {
  isDesktop: boolean;
  getSettings(): Promise<OneShellDesktopSettings>;
  refreshLocalSession?(): Promise<boolean>;
  updateSettings(patch: Partial<Pick<OneShellDesktopSettings, 'startAtLogin' | 'backgroundOnClose' | 'skipLocalLogin'>>): Promise<OneShellDesktopSettings>;
  openWindow(): Promise<OneShellDesktopSettings>;
  quit(): Promise<void>;
  getUpdateState(): Promise<OneShellUpdateState>;
  checkUpdate(): Promise<OneShellUpdateState>;
  downloadUpdate(): Promise<OneShellUpdateState>;
  installUpdate(): Promise<boolean>;
  onUpdateState(callback: (state: OneShellUpdateState) => void): () => void;
}

interface Window {
  oneshellDesktop?: OneShellDesktopBridge;
}
