'use strict';

const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g;
const CURL_PROGRESS_PATTERN = /#=#=#|-=O=-|#O#-|O=#|-=#=#|-=O=#|%\s*Total\s+%\s*Received|\bDload\s+Upload\b/i;
const DOWNLOAD_PHASE_PATTERN = /BenchOS?|curl|wget|download|downloading|fetching|Dload|Received|chroot|load\s+benchos|加载|下载|获取/i;
const CLEAR_ERROR_PATTERN = /curl:\s*\(\d+\)|wget:|could not resolve|connection refused|connection reset|permission denied|no space left|command not found|syntax error|segmentation fault|HTTP\/\d(?:\.\d)?\s+[45]\d\d|\b(?:failed|failure|error|timed out|timeout|killed|broken pipe)\b|错误|失败|超时|拒绝|无法解析/i;
const CLEAR_COMPLETION_PATTERN = /\b(?:completed|complete|success|succeeded|finished|done)\b|执行成功|完成|成功/i;
const TRUNCATION_PATTERN = /\.\.\.\[truncated\]|\[truncated(?:\s+\d+\s+chars)?\]|\.\.\.\(tool_result|tool_result.*(?:trimmed|truncated|裁剪)|已裁剪|已折叠|省略/i;
const INTERACTIVE_PROMPT_PATTERN = /\[(?:y|n)(?:\/[a-z])+\]\s*[:：]?|(?:press|hit)\s+enter|password:\s*$|are you sure|continue\?|请输入|是否|回车|输入.*(?:y|n)/i;

function stripTerminalControl(text) {
  return String(text || '')
    .replace(/(?:\uFFFD|\?)\[/g, '\x1b[')
    .replace(ANSI_PATTERN, '');
}

function collapseCarriageReturnUpdates(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const segments = line.split('\r');
      return [...segments].reverse().find((segment) => segment.length > 0) || '';
    })
    .join('\n');
}

function splitMeaningfulLines(text, maxLines = 12, maxLineChars = 300) {
  const clean = collapseCarriageReturnUpdates(stripTerminalControl(text));
  return clean
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-maxLines)
    .map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars)}...` : line));
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return (String(text || '').match(re) || []).length;
}

function analyzeCommandOutput(result = {}) {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const combinedRaw = `${stdout}\n${stderr}`;
  const combinedClean = stripTerminalControl(combinedRaw);
  const normalized = collapseCarriageReturnUpdates(combinedClean);
  const durationMs = Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : 0;
  const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null;
  const timeout = Number.isFinite(Number(result.timeout)) ? Number(result.timeout) : 0;
  const tailClean = normalized.slice(-4000);
  const carriageReturns = (combinedRaw.match(/\r/g) || []).length;
  const progressSamples = countMatches(combinedRaw, CURL_PROGRESS_PATTERN);
  const containsTerminalProgress = progressSamples > 0 || carriageReturns >= 8;
  const containsDownloadPhase = DOWNLOAD_PHASE_PATTERN.test(combinedClean);
  const containsClearError = CLEAR_ERROR_PATTERN.test(tailClean);
  const containsClearCompletion = exitCode === 0 || CLEAR_COMPLETION_PATTERN.test(tailClean);
  const outputTruncated = TRUNCATION_PATTERN.test(combinedClean);
  const longRunning = durationMs >= 30000 || (timeout > 0 && durationMs >= Math.max(30000, timeout * 0.8));
  const containsInteractivePrompt = result.interactivePromptDetected === true || INTERACTIVE_PROMPT_PATTERN.test(combinedClean);
  const suspectedStalledDownload = Boolean(
    longRunning
    && containsTerminalProgress
    && containsDownloadPhase
    && !containsClearCompletion,
  );

  return {
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    lineCount: normalized ? normalized.split('\n').length : 0,
    durationMs,
    exitCode,
    outputTruncated,
    containsTerminalProgress,
    terminalProgressSamples: progressSamples,
    carriageReturns,
    containsDownloadPhase,
    containsInteractivePrompt,
    containsClearError,
    containsClearCompletion,
    longRunning,
    suspectedStalledDownload,
    lastMeaningfulLines: splitMeaningfulLines(combinedRaw),
  };
}

function withOutputDiagnostics(result = {}, extra = {}) {
  const source = { ...(result || {}), ...(extra || {}) };
  return {
    ...(result || {}),
    outputDiagnostics: analyzeCommandOutput(source),
  };
}

function formatOutputDiagnostics(diag = {}) {
  if (!diag || typeof diag !== 'object' || Array.isArray(diag)) return '';
  const lines = ['outputDiagnostics:'];
  const fields = [
    'durationMs',
    'exitCode',
    'stdoutBytes',
    'stderrBytes',
    'lineCount',
    'outputTruncated',
    'containsTerminalProgress',
    'terminalProgressSamples',
    'containsDownloadPhase',
    'containsInteractivePrompt',
    'containsClearError',
    'containsClearCompletion',
    'longRunning',
    'suspectedStalledDownload',
  ];
  for (const key of fields) {
    if (diag[key] !== undefined) lines.push(`${key}=${diag[key]}`);
  }
  if (Array.isArray(diag.lastMeaningfulLines) && diag.lastMeaningfulLines.length > 0) {
    lines.push('lastMeaningfulLines:');
    for (const line of diag.lastMeaningfulLines.slice(-8)) lines.push(`- ${line}`);
  }
  return lines.join('\n');
}

module.exports = {
  analyzeCommandOutput,
  formatOutputDiagnostics,
  collapseCarriageReturnUpdates,
  stripTerminalControl,
  withOutputDiagnostics,
};
