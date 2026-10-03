import { put, get } from '@vercel/blob';
import { Readable } from 'node:stream';
import { waitUntil } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { synthesize } from '../lib/gemini.js';
import { pcmToWav, splitText } from '../lib/audio.js';
import { processChunks } from '../lib/runner.js';

const CONCURRENCY = 2;
// 関数の最大実行時間(300秒)に収めるため、160秒を過ぎたら新しいチャンクに着手せず次の呼び出しへ引き継ぐ
const BUDGET_MS = 160000;
// この時間(ms)更新が無い running ジョブは、強制終了などで止まったものとみなす
const STALE_MS = 150000;
const MAX_CHARS = 60000;
// ストアはプライベート設定。保存も読み出しも pathname + access:'private' で行う
const blobOpts = { access: 'private', addRandomSuffix: false, allowOverwrite: true };

const jobPath = (id) => `tts/${id}/job.json`;

async function readBlob(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  return r && r.statusCode === 200 ? r : null;
}

async function readJob(id) {
  try {
    const r = await readBlob(jobPath(id));
    return r ? JSON.parse(await new Response(r.stream).text()) : null;
  } catch {
    return null;
  }
}

const saveJob = (job) => {
  job.updatedAt = Date.now();
  return put(jobPath(job.id), JSON.stringify(job), { ...blobOpts, contentType: 'application/json' });
};

// 自分自身(/api/jobs)を再度呼び出して、残りのチャンクの処理を新しい関数呼び出しに引き継ぐ
async function chain(id) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const res = await fetch(`https://${host}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': process.env.APP_PASSWORD, 'x-chain': '1' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`自動継続に失敗しました(HTTP ${res.status})`);
}

// バックグラウンドで未処理チャンクを音声化し、全部終わったらWAVへ結合する
async function runJob(job) {
  const apiKey = process.env.GEMINI_API_KEY;
  job.status = 'running';
  await saveJob(job);

  try {
    const { remaining } = await processChunks(job, {
      synth: (text) => synthesize({ apiKey, model: job.model, voice: job.voice, style: job.style, text }),
      putPcm: async (index, pcm) =>
        (await put(`tts/${job.id}/${index}.pcm`, pcm, { ...blobOpts, contentType: 'application/octet-stream' })).pathname,
      save: saveJob,
      concurrency: CONCURRENCY,
      budgetMs: BUDGET_MS,
    });
    if (remaining > 0) {
      // 時間予算を使い切った: 残りは新しい関数呼び出しに任せる(running のまま)
      await chain(job.id);
      return;
    }
    const parts = [];
    for (const c of job.chunks) {
      const r = await readBlob(c.pcmPath);
      if (!r) throw new Error(`チャンク${c.index}の音声が見つかりません`);
      parts.push(Buffer.from(await new Response(r.stream).arrayBuffer()));
    }
    const wav = pcmToWav(Buffer.concat(parts));
    const out = await put(`tts/${job.id}/final.wav`, wav, { ...blobOpts, contentType: 'audio/wav' });
    job.audioPath = out.pathname;
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

  if (req.method === 'GET' && req.query.audio) {
    // 完成WAVを認証付きでストリーム配信（プライベートBlobのため直接URLでは取得できない）
    const r = await readBlob(`tts/${req.query.id}/final.wav`);
    if (!r) return res.status(404).json({ error: '音声が見つかりません' });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, no-store');
    return Readable.fromWeb(r.stream).pipe(res);
  }

  if (req.method === 'GET') {
    const job = await readJob(req.query.id);
    if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
    const { audioPath, ...rest } = job;
    return res.json({ ...rest, ageMs: Date.now() - (job.updatedAt || 0), audioReady: !!audioPath, chunks: job.chunks.map(({ index, status }) => ({ index, status })) });
  }

  if (req.method === 'POST') {
    const { id, text, model, voice, style } = req.body || {};
    let job;
    if (id) {
      // 再開: 制限時間切れなどで止まったジョブの未処理チャンクを続行
      job = await readJob(id);
      if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
      if (job.status === 'done') return res.json({ id: job.id });
      // 実行中(更新が新しい)なら二重起動しない。自動継続(x-chain)と、停止とみなせる場合は再開を許可
      const fresh = Date.now() - (job.updatedAt || 0) < STALE_MS;
      if ((job.status === 'running' || job.status === 'queued') && fresh && req.headers['x-chain'] !== '1') {
        return res.json({ id: job.id });
      }
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
        audioPath: null,
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
