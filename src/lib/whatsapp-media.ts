import { getSetting, SETTING_KEYS } from "./settings";

const GRAPH_API_VERSION = "v17.0";

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Download a WhatsApp media object by its Meta media ID using the two-hop
 * Graph API flow: (1) GET /{mediaId} → temporary signed URL, (2) GET that URL
 * with the same bearer token → binary. Works for both the main and support
 * WhatsApp accounts — pass the matching access token.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<DownloadedMedia> {
  const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`;
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaResp.ok) {
    const body = await metaResp.text();
    throw new Error(
      `Meta media metadata error (${metaResp.status}): ${body.slice(0, 200)}`
    );
  }
  const meta = (await metaResp.json()) as { url?: string; mime_type?: string };
  if (!meta.url) {
    throw new Error("Meta media metadata response missing url");
  }

  const binResp = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!binResp.ok) {
    throw new Error(`Meta media binary fetch failed (${binResp.status})`);
  }
  const arrayBuffer = await binResp.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType:
      binResp.headers.get("content-type") ||
      meta.mime_type ||
      "application/octet-stream",
  };
}

/** Map a WhatsApp audio MIME type to a filename extension for the OpenAI upload. */
function extensionForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("amr")) return "amr";
  return "ogg";
}

/**
 * Transcribe an audio buffer to text via the OpenAI transcription API
 * (`whisper-1`). Uses the same `OPENAI_API_KEY` already configured for the AI
 * auto-reply, so no new credential is required. Returns the transcript text
 * or throws on API error.
 */
export async function transcribeAudio(
  audio: DownloadedMedia,
  opts: { apiKey?: string; model?: string } = {}
): Promise<string> {
  const apiKey =
    opts.apiKey || (await getSetting(SETTING_KEYS.OPENAI_API_KEY)) || undefined;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for transcription");
  }
  const model = opts.model || "whisper-1";

  const ext = extensionForMime(audio.mimeType);
  const file = new File([new Uint8Array(audio.buffer)], `voice.${ext}`, {
    type: audio.mimeType.split(";")[0] || "audio/ogg",
  });

  const form = new FormData();
  form.append("file", file);
  form.append("model", model);

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `OpenAI transcription error (${resp.status}): ${body.slice(0, 200)}`
    );
  }
  const data = (await resp.json()) as { text?: string };
  return (data.text ?? "").trim();
}
