const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// 1チャンク分を音声化して { pcm, usage } を返す。429/5xxは指数バックオフで再試行
export async function synthesize({ apiKey, model, voice, style, text }) {
  const prompt = style ? `${style}: ${text}` : text;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error('音声データが返されませんでした: ' + JSON.stringify(json).slice(0, 300));
      return {
        pcm: Buffer.from(part.inlineData.data, 'base64'),
        usage: {
          input: json.usageMetadata?.promptTokenCount || 0,
          output: json.usageMetadata?.candidatesTokenCount || 0,
        },
      };
    }
    const errText = await res.text();
    lastErr = new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
    if (res.status !== 429 && res.status < 500) throw lastErr;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw lastErr;
}
