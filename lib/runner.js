// 未処理チャンクを音声化する本体。外部依存（Gemini/Blob）は引数で受け取る（テストしやすくするため）
// 制限時間(関数の最大実行時間)に収まるよう、budgetMs を過ぎたら新しいチャンクには着手しない
export function recompute(job) {
  job.tokens = job.chunks.reduce(
    (a, x) => ({ input: a.input + (x.usage?.input || 0), output: a.output + (x.usage?.output || 0) }),
    { input: 0, output: 0 },
  );
  job.doneCount = job.chunks.filter((x) => x.status === 'done').length;
}

export async function processChunks(job, { synth, putPcm, save, concurrency = 2, budgetMs = 160000, now = Date.now }) {
  const start = now();
  const queue = job.chunks.filter((c) => c.status !== 'done');
  let failed = null;

  async function worker() {
    while (queue.length && !failed && now() - start < budgetMs) {
      const c = queue.shift();
      try {
        const { pcm, usage } = await synth(c.text);
        c.pcmPath = await putPcm(c.index, pcm);
        c.usage = usage;
        c.bytes = pcm.length;
        c.status = 'done';
      } catch (e) {
        c.status = 'error';
        failed = e;
      }
      recompute(job);
      await save(job);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failed) throw failed;
  return { remaining: job.chunks.filter((c) => c.status !== 'done').length };
}
