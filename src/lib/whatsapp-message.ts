/**
 * Parsing helpers that turn a raw Meta WhatsApp inbound message into the
 * structured fields persisted on `InboundMessage` plus a human/AI-readable
 * text representation. Shared by the main and support webhooks so both
 * inboxes behave "like regular WhatsApp" — every message type is captured,
 * the raw payload is always preserved, and a useful summary is shown even for
 * types with no natural text (location, reaction, contacts, interactive…).
 */

export interface MetaTextMessage {
  body?: string;
}

export interface MetaMediaMessage {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface MetaLocationMessage {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
}

export interface MetaReactionMessage {
  message_id?: string;
  emoji?: string;
}

export interface MetaContactMessage {
  name?: { formatted_name?: string };
  phones?: Array<{ phone?: string }>;
}

export interface MetaInteractiveMessage {
  type?: string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
}

export interface MetaButtonMessage {
  text?: string;
  payload?: string;
}

export interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: MetaTextMessage;
  image?: MetaMediaMessage;
  video?: MetaMediaMessage;
  audio?: MetaMediaMessage;
  document?: MetaMediaMessage;
  sticker?: MetaMediaMessage;
  location?: MetaLocationMessage;
  reaction?: MetaReactionMessage;
  contacts?: MetaContactMessage[];
  interactive?: MetaInteractiveMessage;
  button?: MetaButtonMessage;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

export interface ParsedInboundMessage {
  type: string;
  /** Display/AI-context text (caption, transcription placeholder, or summary). */
  text: string | null;
  mediaId: string | null;
  mediaMimeType: string | null;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  locationAddress: string | null;
  reactionEmoji: string | null;
  reactionToId: string | null;
  /** True for voice/audio notes that should be downloaded + transcribed. */
  isAudio: boolean;
}

function mediaOf(msg: MetaMessage): MetaMediaMessage | null {
  return (
    msg.image ||
    msg.video ||
    msg.audio ||
    msg.document ||
    msg.sticker ||
    null
  );
}

/**
 * Build the display/AI text for a message. For text/caption types this is the
 * literal body; for structured types it's a readable one-liner so the inbox
 * and the AI both "see" the message instead of a blank bubble.
 */
export function buildDisplayText(msg: MetaMessage): string | null {
  const type = msg.type ?? "text";

  if (msg.text?.body) return msg.text.body;
  if (msg.image?.caption) return msg.image.caption;
  if (msg.video?.caption) return msg.video.caption;
  if (msg.document?.caption) return msg.document.caption;

  switch (type) {
    case "location": {
      const loc = msg.location;
      if (!loc) return "[location]";
      const label = loc.name || loc.address;
      const coords =
        loc.latitude !== undefined && loc.longitude !== undefined
          ? `${loc.latitude}, ${loc.longitude}`
          : "";
      return `[location] ${label ? `${label} ` : ""}${coords}`.trim();
    }
    case "reaction": {
      const emoji = msg.reaction?.emoji;
      return emoji ? `[reacted ${emoji}]` : "[reaction removed]";
    }
    case "contacts": {
      const names = (msg.contacts ?? [])
        .map((c) => c.name?.formatted_name || c.phones?.[0]?.phone)
        .filter(Boolean);
      return `[contact${names.length > 1 ? "s" : ""}] ${names.join(", ")}`.trim();
    }
    case "interactive": {
      const i = msg.interactive;
      const picked =
        i?.button_reply?.title ||
        i?.list_reply?.title ||
        i?.button_reply?.id ||
        i?.list_reply?.id;
      return picked ? `[reply] ${picked}` : "[interactive]";
    }
    case "button": {
      return msg.button?.text ? `[button] ${msg.button.text}` : "[button]";
    }
    case "image":
      return "[image]";
    case "video":
      return "[video]";
    case "audio":
      return msg.audio?.voice ? "[voice message]" : "[audio]";
    case "document":
      return msg.document?.filename
        ? `[document] ${msg.document.filename}`
        : "[document]";
    case "sticker":
      return "[sticker]";
    default:
      return null;
  }
}

/** Parse a Meta inbound message into the structured fields we persist. */
export function parseInboundMessage(msg: MetaMessage): ParsedInboundMessage {
  const type = msg.type ?? "text";
  const media = mediaOf(msg);
  const loc = msg.location;
  const reaction = msg.reaction;

  return {
    type,
    text: buildDisplayText(msg),
    mediaId: media?.id ?? null,
    mediaMimeType: media?.mime_type ?? null,
    latitude: loc?.latitude ?? null,
    longitude: loc?.longitude ?? null,
    locationName: loc?.name ?? null,
    locationAddress: loc?.address ?? null,
    reactionEmoji: reaction?.emoji ?? null,
    reactionToId: reaction?.message_id ?? null,
    isAudio: type === "audio" && !!msg.audio?.id,
  };
}
