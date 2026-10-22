import clipboard from 'clipboardy';
import { LOCAL_LIMIT } from './clipboard.js';

try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > LOCAL_LIMIT) throw new Error('Clipboard helper input exceeds the local copy limit');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks, bytes).toString('utf8');
  await clipboard.write(text);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(Buffer.from(reason, 'utf8').subarray(0, 4096));
  process.exitCode = 1;
}
