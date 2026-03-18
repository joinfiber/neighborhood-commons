/**
 * Share Studio — Canvas-based social media asset generation
 *
 * Renders event data into Instagram Story (1080×1920) and Square Post
 * (1080×1080) templates using the Canvas API with Google Fonts.
 */

// =============================================================================
// Types
// =============================================================================

export interface RGB { r: number; g: number; b: number }
export type TemplateType = 'story' | 'square';

export interface ShareEventData {
  title: string;
  venue_name: string;
  event_date: string;
  start_time: string;
  end_time?: string | null;
  category: string;
  image_url?: string | null;
  image_focal_y?: number;
  description?: string | null;
  price?: string | null;
}

// =============================================================================
// Constants
// =============================================================================

export const CATEGORY_COLORS: Record<string, RGB> = {
  live_music:      { r: 139, g: 92, b: 246 },
  dj_dance:        { r: 236, g: 72, b: 153 },
  comedy:          { r: 251, g: 191, b: 36 },
  karaoke:         { r: 244, g: 114, b: 182 },
  open_mic:        { r: 168, g: 162, b: 158 },
  art_gallery:     { r: 244, g: 63, b: 94 },
  film_screening:  { r: 99, g: 102, b: 241 },
  theatre:         { r: 217, g: 70, b: 239 },
  happy_hour:      { r: 245, g: 158, b: 11 },
  food_drink:      { r: 249, g: 115, b: 22 },
  market_popup:    { r: 20, g: 184, b: 166 },
  fitness_class:   { r: 34, g: 197, b: 94 },
  sports_rec:      { r: 59, g: 130, b: 246 },
  workshop_class:  { r: 168, g: 85, b: 247 },
  trivia_games:    { r: 14, g: 165, b: 233 },
  community:       { r: 251, g: 146, b: 60 },
  spectator:       { r: 99, g: 102, b: 241 },
  other:           { r: 148, g: 163, b: 184 },
};

const CATEGORY_LABELS: Record<string, string> = {
  live_music: 'Live Music', dj_dance: 'DJ / Dance', comedy: 'Comedy',
  karaoke: 'Karaoke', open_mic: 'Open Mic', art_gallery: 'Art / Gallery',
  film_screening: 'Film & Screening', theatre: 'Theatre',
  happy_hour: 'Happy Hour', food_drink: 'Food & Drink',
  market_popup: 'Market / Pop-up', fitness_class: 'Fitness Class',
  sports_rec: 'Sports & Rec', workshop_class: 'Workshop / Class',
  trivia_games: 'Trivia & Games', community: 'Community',
  spectator: 'Spectator', other: 'Other',
};

const CATEGORY_EMOJIS: Record<string, string> = {
  live_music: '\u{1F3B6}', dj_dance: '\u{1F3A7}', comedy: '\u{1F602}',
  karaoke: '\u{1F3A4}', open_mic: '\u{1F399}\uFE0F', art_gallery: '\u{1F3A8}',
  film_screening: '\u{1F3AC}', theatre: '\u{1F3AD}',
  happy_hour: '\u{1F37B}', food_drink: '\u{1F374}', market_popup: '\u{1F6CD}\uFE0F',
  fitness_class: '\u{1F4AA}', sports_rec: '\u26BD',
  workshop_class: '\u{1F4DA}', trivia_games: '\u{1F9E0}',
  community: '\u{1F3D8}\uFE0F', spectator: '\u{1F440}', other: '\u2728',
};

// =============================================================================
// Font Loading
// =============================================================================

let fontsLoaded = false;

export async function loadShareFonts(): Promise<void> {
  if (fontsLoaded) return;

  if (!document.querySelector('link[data-share-fonts]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=DM+Serif+Display&display=swap';
    link.setAttribute('data-share-fonts', 'true');
    document.head.appendChild(link);
  }

  await document.fonts.ready;

  try {
    await Promise.all([
      document.fonts.load('400 48px "DM Sans"'),
      document.fonts.load('500 48px "DM Sans"'),
      document.fonts.load('700 48px "DM Sans"'),
      document.fonts.load('400 48px "DM Serif Display"'),
    ]);
  } catch {
    // Canvas will use fallback fonts
  }

  fontsLoaded = true;
}

// =============================================================================
// Color Extraction
// =============================================================================

export function extractDominantColor(imageUrl: string): Promise<RGB> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 50;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, size, size);

      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, size, size).data;
      } catch {
        // Tainted canvas (CORS) — use fallback
        resolve({ r: 40, g: 40, b: 50 });
        return;
      }

      const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
        const brightness = (r + g + b) / 3;
        if (brightness < 30 || brightness > 230) continue;

        const key = `${Math.round(r / 32) * 32},${Math.round(g / 32) * 32},${Math.round(b / 32) * 32}`;
        const existing = buckets.get(key);
        if (existing) {
          existing.r += r; existing.g += g; existing.b += b; existing.count++;
        } else {
          buckets.set(key, { r, g, b, count: 1 });
        }
      }

      let best: RGB = { r: 40, g: 40, b: 50 };
      let bestCount = 0;
      for (const bucket of buckets.values()) {
        if (bucket.count > bestCount) {
          bestCount = bucket.count;
          best = {
            r: Math.round(bucket.r / bucket.count),
            g: Math.round(bucket.g / bucket.count),
            b: Math.round(bucket.b / bucket.count),
          };
        }
      }
      resolve(best);
    };
    img.onerror = () => resolve({ r: 40, g: 40, b: 50 });
    img.src = imageUrl;
  });
}

// =============================================================================
// Helpers
// =============================================================================

function darken(c: RGB, amount: number): RGB {
  return {
    r: Math.round(c.r * (1 - amount)),
    g: Math.round(c.g * (1 - amount)),
    b: Math.round(c.b * (1 - amount)),
  };
}

function lighten(c: RGB, amount: number): RGB {
  return {
    r: Math.round(c.r + (255 - c.r) * amount),
    g: Math.round(c.g + (255 - c.g) * amount),
    b: Math.round(c.b + (255 - c.b) * amount),
  };
}

function rgbStr(c: RGB, alpha = 1): string {
  return alpha < 1
    ? `rgba(${c.r},${c.g},${c.b},${alpha})`
    : `rgb(${c.r},${c.g},${c.b})`;
}

function formatDateLong(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  const date = new Date(parts[0]!, parts[1]! - 1, parts[2]);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime12(time: string): string {
  const parts = time.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${ampm}` : `${hour} ${ampm}`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  W: number, H: number,
  focalY = 0.5,
) {
  const imgAspect = img.width / img.height;
  const canvasAspect = W / H;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;

  if (imgAspect > canvasAspect) {
    sw = img.height * canvasAspect;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / canvasAspect;
    sy = (img.height - sh) * focalY;
  }

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// =============================================================================
// Template Rendering
// =============================================================================

export async function renderTemplate(
  event: ShareEventData,
  type: TemplateType,
  dominantColor: RGB,
): Promise<HTMLCanvasElement> {
  await loadShareFonts();

  const W = 1080;
  const H = type === 'story' ? 1920 : 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Dark base fill
  ctx.fillStyle = rgbStr(darken(dominantColor, 0.8));
  ctx.fillRect(0, 0, W, H);

  // Draw event image or gradient background
  if (event.image_url) {
    try {
      const img = await loadImage(event.image_url);
      drawCoverImage(ctx, img, W, H, event.image_focal_y ?? 0.5);
    } catch {
      drawGradientBg(ctx, W, H, dominantColor);
    }
  } else {
    drawGradientBg(ctx, W, H, dominantColor);
  }

  // Gradient overlay for text readability
  const gradTop = type === 'story' ? 0.30 : 0.15;
  const grad = ctx.createLinearGradient(0, H * gradTop, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.3)');
  grad.addColorStop(0.65, 'rgba(0,0,0,0.7)');
  grad.addColorStop(1, 'rgba(0,0,0,0.92)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle color tint at the bottom
  const tint = ctx.createLinearGradient(0, H * 0.7, 0, H);
  tint.addColorStop(0, 'rgba(0,0,0,0)');
  tint.addColorStop(1, rgbStr(darken(dominantColor, 0.5), 0.25));
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);

  // ---- Text layout (bottom up) ----
  const isStory = type === 'story';
  const pad = isStory ? 64 : 56;
  const maxTextW = W - pad * 2;
  let y = H - (isStory ? 100 : 72);

  // Branding
  ctx.font = `500 ${isStory ? 18 : 16}px "DM Sans", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.textAlign = 'left';
  ctx.fillText('neighborhood commons', pad, y);
  y -= isStory ? 48 : 36;

  // Date + Time (two lines)
  const dateStr = formatDateLong(event.event_date);
  const timeStr = formatTime12(event.start_time);
  const endStr = event.end_time ? ` \u2013 ${formatTime12(event.end_time)}` : '';
  const dateSize = isStory ? 28 : 24;
  ctx.font = `500 ${dateSize}px "DM Sans", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`${timeStr}${endStr}`, pad, y);
  y -= dateSize + 6;
  ctx.fillText(dateStr, pad, y);
  y -= dateSize + 14;

  // Venue
  const venueSize = isStory ? 30 : 26;
  ctx.font = `400 ${venueSize}px "DM Sans", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  let venueLine = event.venue_name;
  if (ctx.measureText(venueLine).width > maxTextW) {
    while (ctx.measureText(venueLine + '\u2026').width > maxTextW && venueLine.length > 1) {
      venueLine = venueLine.slice(0, -1);
    }
    venueLine += '\u2026';
  }
  ctx.fillText(venueLine, pad, y);
  y -= venueSize + 24;

  // Title with text shadow
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  const titleSize = isStory ? 60 : 48;
  ctx.font = `400 ${titleSize}px "DM Serif Display", serif`;
  ctx.fillStyle = '#ffffff';
  const titleLines = wrapText(ctx, event.title, maxTextW);
  const maxLines = isStory ? 3 : 2;
  const display = titleLines.slice(0, maxLines);
  if (titleLines.length > maxLines) {
    let last = display[maxLines - 1] || '';
    while (ctx.measureText(last + '\u2026').width > maxTextW && last.length > 1) {
      last = last.replace(/\s?\S*$/, '');
    }
    display[maxLines - 1] = last + '\u2026';
  }
  const lineH = titleSize * 1.18;
  for (let i = display.length - 1; i >= 0; i--) {
    ctx.fillText(display[i]!, pad, y);
    y -= lineH;
  }

  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  y -= 20;

  // Category pill
  const catLabel = CATEGORY_LABELS[event.category] || event.category;
  const pillFontSize = isStory ? 22 : 20;
  ctx.font = `500 ${pillFontSize}px "DM Sans", sans-serif`;
  const pillTextW = ctx.measureText(catLabel).width;
  const pillPadH = 18;
  const pillPadV = 10;
  const pillW = pillTextW + pillPadH * 2;
  const pillH = pillFontSize + pillPadV * 2;
  const pillY = y - pillH;
  const pillR = pillH / 2;

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundedRect(ctx, pad, pillY, pillW, pillH, pillR);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(catLabel, pad + pillPadH, pillY + pillPadV + pillFontSize * 0.82);

  return canvas;
}

function drawGradientBg(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  color: RGB,
) {
  const top = lighten(color, 0.2);
  const bot = darken(color, 0.85);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, rgbStr(top));
  bg.addColorStop(1, rgbStr(bot));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
}

// =============================================================================
// Export Utilities
// =============================================================================

export function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Failed to create blob'));
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

// =============================================================================
// Caption Generation
// =============================================================================

export function generateCaption(event: ShareEventData): string {
  const emoji = CATEGORY_EMOJIS[event.category] || '\u2728';
  const dateStr = formatDateLong(event.event_date);
  const timeStr = formatTime12(event.start_time);
  const endStr = event.end_time ? ` \u2013 ${formatTime12(event.end_time)}` : '';

  const lines: string[] = [];
  lines.push(`${emoji} ${event.title}`);
  lines.push('');
  lines.push(`\u{1F4C5} ${dateStr} at ${timeStr}${endStr}`);
  lines.push(`\u{1F4CD} ${event.venue_name}`);
  if (event.price) lines.push(`\u{1F39F}\uFE0F ${event.price}`);

  if (event.description) {
    lines.push('');
    const desc = event.description.length > 200
      ? event.description.slice(0, 197) + '...'
      : event.description;
    lines.push(desc);
  }

  return lines.join('\n');
}
