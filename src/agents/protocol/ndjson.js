'use strict';

// 行分隔 JSON（ndjson）读写：协议 agent 子进程的 stdio 传输层。
// 半行缓冲、超长行保护、写入背压透传。

const MAX_LINE_BYTES = 32 * 1024 * 1024;

function createNdjsonReader(stream, { onMessage, onError, maxLineBytes = MAX_LINE_BYTES } = {}) {
  let buffer = '';
  let closed = false;

  function handleChunk(chunk) {
    if (closed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxLineBytes) {
      closed = true;
      onError?.(new Error(`ndjson line exceeds ${maxLineBytes} bytes`));
      return;
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 有些 agent 会往 stdout 混入非 JSON 日志，跳过而不是中断会话
        continue;
      }
      try {
        onMessage?.(parsed);
      } catch (err) {
        onError?.(err);
      }
    }
  }

  stream.setEncoding('utf8');
  stream.on('data', handleChunk);
  stream.on('error', (err) => { if (!closed) onError?.(err); });

  return {
    close() {
      closed = true;
      stream.off('data', handleChunk);
    },
  };
}

function writeNdjson(stream, message) {
  if (!stream || stream.destroyed || !stream.writable) return false;
  try {
    return stream.write(`${JSON.stringify(message)}\n`);
  } catch {
    return false;
  }
}

module.exports = { createNdjsonReader, writeNdjson };
