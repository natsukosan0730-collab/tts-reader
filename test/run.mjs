import assert from 'node:assert/strict';
import { refineText } from '../public/refine.js';
import { pcmToWav, splitText } from '../lib/audio.js';

// 整形
const raw = `# 見出し

**重要**：詳細は https://example.com を参照[1]。


- 項目１　ＡＢＣ
- 売上は10~20％増！！！

12
`;
const refined = refineText(raw);
console.log(refined);
assert.ok(!refined.includes('http'));
assert.ok(refined.includes('詳細はリンクを参照'));
assert.ok(!refined.includes('[1]'));
assert.ok(!refined.includes('**'));
assert.ok(!/\n\n/.test(refined), '空行が残っている');
assert.ok(refined.includes('10から20'));
assert.ok(refined.includes('ABC'));
assert.ok(!/^12/m.test(refined), 'ページ番号が残っている');
assert.ok(refined.startsWith('見出し。'));

// 分割: 全チャンクが上限以内、結合すると元の文字が失われない
const long = '吾輩は猫である。名前はまだ無い。'.repeat(300);
const chunks = splitText(long, 1200);
assert.ok(chunks.length > 1);
assert.ok(chunks.every((c) => c.length <= 1200));
assert.equal(chunks.join('').replace(/\s/g, ''), long);

// WAV
const wav = pcmToWav(Buffer.alloc(48000));
assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
assert.equal(wav.readUInt32LE(24), 24000);
assert.equal(wav.length, 44 + 48000);

console.log('OK');
