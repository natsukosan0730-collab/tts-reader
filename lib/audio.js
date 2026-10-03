// 生PCM(24kHz/mono/16bit) を WAV にする
export function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// 文末記号で区切りつつ maxLen 文字以内のチャンクに分割する
export function splitText(text, maxLen = 1200) {
  const sentences = text.match(/[^。！？!?\n]+[。！？!?]*\n?|\n/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > maxLen) {
      chunks.push(cur.trim());
      cur = '';
    }
    cur += s;
    while (cur.length > maxLen) {
      chunks.push(cur.slice(0, maxLen).trim());
      cur = cur.slice(maxLen);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}
