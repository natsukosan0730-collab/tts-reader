import assert from 'node:assert/strict';
import { refineText } from '../public/refine.js';
import { pcmToWav, splitText } from '../lib/audio.js';
import { processChunks } from '../lib/runner.js';

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

// ---- ランナー: 2万字(18分割)相当を時間予算つきで処理 ----
const mkJob = (n) => ({
  chunks: Array.from({ length: n }, (_, i) => ({ index: i, text: 't' + i, status: 'pending' })),
  tokens: { input: 0, output: 0 }, doneCount: 0,
});
let clock = 0;                       // 模擬時計(ms)。1チャンク=10秒かかる想定
const calls = [];
const deps = (extra = {}) => ({
  synth: async (t) => { calls.push(t); clock += 10000; return { pcm: Buffer.alloc(10), usage: { input: 5, output: 20 } }; },
  putPcm: async (i) => `p/${i}.pcm`,
  save: async () => {},
  now: () => clock,
  concurrency: 1,                    // 模擬時計を単純にするため直列
  budgetMs: 160000,
  ...extra,
});

const job = mkJob(18);
let r = await processChunks(job, deps());
assert.equal(r.remaining, 2, '160秒=16チャンクで打ち切り、残り2');
assert.equal(job.doneCount, 16);
assert.deepEqual(job.tokens, { input: 80, output: 320 });

// 続きから再開(新しい呼び出し): 完了済みは再処理しない
calls.length = 0; clock = 0;
r = await processChunks(job, deps());
assert.equal(r.remaining, 0);
assert.deepEqual(calls, ['t16', 't17'], '未処理の2つだけ処理');
assert.equal(job.doneCount, 18);
assert.deepEqual(job.tokens, { input: 90, output: 360 });

// 失敗: error を記録して例外を投げ、残りは pending のまま(再開可能)
const job2 = mkJob(5);
let n = 0;
await assert.rejects(() => processChunks(job2, deps({
  synth: async () => { if (++n === 3) throw new Error('boom'); return { pcm: Buffer.alloc(1), usage: { input: 1, output: 1 } }; },
})), /boom/);
assert.deepEqual(job2.chunks.map((c) => c.status), ['done', 'done', 'error', 'pending', 'pending']);

// 実時間の同時実行(2本)でも全件処理される
const job3 = mkJob(7);
r = await processChunks(job3, { ...deps({ now: Date.now, concurrency: 2, synth: async () => ({ pcm: Buffer.alloc(1), usage: { input: 1, output: 1 } }) }) });
assert.equal(r.remaining, 0);
assert.equal(job3.doneCount, 7);

console.log('OK');
