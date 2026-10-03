import { put, head } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { synthesize } from '../lib/gemini.js';
import { pcmToWav, splitText } from '../lib/audio.js';

const CONCURRENCY = 2;
const MAX_CHARS = 60000;
const blobOpts = { access: 'public', addRandomSuffix: false, allowOverwrite: true };

const jobPath = (id) => `tts/${id}/job.json`;

async function readJob(id) {
  try {
    const meta = await head(jobPath(id));
    const res = await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const saveJob = (job) => put(jobPath(job.id), JSON.stringify(job), { ...blobOpts, contentType: 'application/json' });

// バックグラウンドで未処理チャンクを順に音声化し、最後にWAVへ結合する
async function runJob(job) {
  const apiKey = process.env.GEMINI_API_KEY;
  job.status = 'running';
  await saveJob(job);
  const queue = job.chunks.filter((c) => c.status !== 'done');
  let failed = null;

  async function worker() {
    while (queue.length && !failed) {
      const c = queue.shift();
      try {
        const { pcm, usage } = await synthesize({
          apiKey, model: job.model, voice: job.voice, style: job.style, text: c.text,
        });
        const blob = await put(`tts/${job.id}/${c.index}.pcm`, pcm, { ...blobOpts, contentType: 'application/octet-stream' });
        c.status = 'done';
        c.pcmUrl = blob.url;
        c.usage = usage;
        c.bytes = pcm.length;
      } catch (e) {
        c.status = 'error';
        failed = e;
      }
      job.tokens = job.chunks.reduce(
        (a, x) => ({ input: a.input + (x.usage?.input || 0), output: a.output + (x.usage?.output || 0) }),
        { input: 0, output: 0 },
      );
      job.doneCount = job.chunks.filter((x) => x.status === 'done').length;
      await saveJob(job);
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failed) throw failed;
    const parts = [];
    for (const c of job.chunks) {
      const r = await fetch(c.pcmUrl);
      parts.push(Buffer.from(await r.arrayBuffer()));
    }
    const wav = pcmToWav(Buffer.concat(parts));
    const out = await put(`tts/${job.id}/final.wav`, wav, { ...blobOpts, contentType: 'audio/wav' });
    job.audioUrl = out.url;
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = String(e.message || e);
  }
  await saveJob(job);
}

export default async function handler(req, res) {
  if (!process.env.APP_PASSWORD || !process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: '環境変数 APP_PASSWORD / GEMINI_API_KEY が未設定です' });
  }
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  if (req.method === 'GET') {
    const job = await readJob(req.query.id);
    if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
    return res.json({ ...job, chunks: job.chunks.map(({ index, status }) => ({ index, status })) });
  }

  if (req.method === 'POST') {
    const { id, text, model, voice, style } = req.body || {};
    let job;
    if (id) {
      // 再開: 制限時間切れなどで止まったジョブの未処理チャンクを続行
      job = await readJob(id);
      if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
      if (job.status === 'running' || job.status === 'done') return res.json({ id: job.id });
      job.chunks.forEach((c) => { if (c.status === 'error') c.status = 'pending'; });
      job.error = null;
    } else {
      if (!text || !text.trim()) return res.status(400).json({ error: 'テキストが空です' });
      if (text.length > MAX_CHARS) return res.status(400).json({ error: `テキストが長すぎます(上限${MAX_CHARS}文字)` });
      const pieces = splitText(text);
      job = {
        id: randomUUID(),
        status: 'queued',
        model: model || 'gemini-3.8-flash-tts',
        voice: voice || 'Kore',
        style: style || '',
        createdAt: new Date().toISOString(),
        chunks: pieces.map((t, index) => ({ index, text: t, status: 'pending' })),
        doneCount: 0,
        tokens: { input: 0, output: 0 },
        audioUrl: null,
        error: null,
      };
    }
    await saveJob(job);
    // レスポンス返却後もこの関数を維持して生成を続ける(端末を閉じても継続)
    waitUntil(runJob(job));
    return res.status(202).json({ id: job.id, total: job.chunks.length });
  }

  res.status(405).json({ error: 'Method Not Allowed' });
}
