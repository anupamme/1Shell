import type { Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

// 按文件名匹配 CodeMirror 语言包（language-data 懒加载，未命中返回空扩展）。
// AgentFilePanel（右栏编辑器）与 IdeEditDiff（工具卡 diff）共用。
export async function languageExtensionForFile(fileName: string): Promise<Extension> {
  const desc = LanguageDescription.matchFilename(languages, fileName);
  if (!desc) return [];
  try {
    return await desc.load();
  } catch {
    return [];
  }
}

export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

// 监听全局暗色切换（documentElement class），返回解绑函数
export function watchDarkTheme(onChange: (dark: boolean) => void): () => void {
  const observer = new MutationObserver(() => onChange(isDarkTheme()));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
