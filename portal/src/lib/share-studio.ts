/**
 * Share Studio — Canvas-based social media asset generation
 *
 * Renders event data into Instagram Story (1080x1920) and Square Post
 * (1080x1080) templates. Supports configurable gradients, 20 Google Fonts,
 * custom colors, blur, text positioning, and draggable text offsets.
 *
 * The rendering is split into background (image + gradient) and text layers
 * so that text dragging can re-draw at 60fps without re-compositing the image.
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
// Design Configuration
// =============================================================================

export type GradientStyle = 'fade-up' | 'fade-down' | 'vignette' | 'diagonal-left' | 'diagonal-right' | 'wash';
export type TextPosition = 'bottom-left' | 'bottom-center' | 'center' | 'top-left';
export type ColorSchemeId = 'auto' | 'midnight' | 'warm' | 'cool' | 'emerald' | 'rose' | 'custom';

export type FontId =
  | 'dm-serif' | 'playfair' | 'lora' | 'cormorant' | 'libre-baskerville'
  | 'dm-sans' | 'space-grotesk' | 'outfit' | 'sora' | 'raleway' | 'josefin' | 'rubik'
  | 'bebas' | 'oswald' | 'anton'
  | 'abril' | 'righteous' | 'monoton'
  | 'permanent-marker' | 'caveat';

export interface CardDesign {
  gradient: GradientStyle;
  gradientOpacity: number;    // 0.3–1.0, overlay intensity
  colorScheme: ColorSchemeId;
  customColor: string | null; // hex string when colorScheme is 'custom'
  font: FontId;               // title font
  detailFont: FontId;         // venue, date, time font
  position: TextPosition;
  titleSize: number;          // canvas px, 48–140
  supportSize: number;        // venue + date size, 18–54
  blur: number;               // 0–20, background image blur
  showVenue: boolean;
  showDateTime: boolean;
  titleOffsetX: number;       // canvas px offset from default position
  titleOffsetY: number;
}

export const DEFAULT_DESIGN: CardDesign = {
  gradient: 'fade-up',
  gradientOpacity: 0.85,
  colorScheme: 'auto',
  customColor: null,
  font: 'dm-serif',
  detailFont: 'dm-sans',
  position: 'bottom-left',
  titleSize: 90,
  supportSize: 36,
  blur: 0,
  showVenue: true,
  showDateTime: true,
  titleOffsetX: 0,
  titleOffsetY: 0,
};

// Instagram minimum readable sizes on 1080px canvas
export const SIZE_LIMITS = {
  titleMin: 48,
  titleMax: 140,
  supportMin: 18,
  supportMax: 54,
  blurMax: 20,
};

// =============================================================================
// Font Options (20 diverse Google Fonts)
// =============================================================================

export interface FontOption {
  id: FontId;
  label: string;
  family: string;
  weight: number;
  category: 'serif' | 'sans' | 'display' | 'script';
}

export const FONT_OPTIONS: FontOption[] = [
  // Serif
  { id: 'dm-serif', label: 'DM Serif', family: '"DM Serif Display", serif', weight: 400, category: 'serif' },
  { id: 'playfair', label: 'Playfair', family: '"Playfair Display", serif', weight: 700, category: 'serif' },
  { id: 'lora', label: 'Lora', family: '"Lora", serif', weight: 700, category: 'serif' },
  { id: 'cormorant', label: 'Cormorant', family: '"Cormorant Garamond", serif', weight: 600, category: 'serif' },
  { id: 'libre-baskerville', label: 'Baskerville', family: '"Libre Baskerville", serif', weight: 700, category: 'serif' },
  // Sans-serif
  { id: 'dm-sans', label: 'DM Sans', family: '"DM Sans", sans-serif', weight: 700, category: 'sans' },
  { id: 'space-grotesk', label: 'Space Grotesk', family: '"Space Grotesk", sans-serif', weight: 700, category: 'sans' },
  { id: 'outfit', label: 'Outfit', family: '"Outfit", sans-serif', weight: 700, category: 'sans' },
  { id: 'sora', label: 'Sora', family: '"Sora", sans-serif', weight: 700, category: 'sans' },
  { id: 'raleway', label: 'Raleway', family: '"Raleway", sans-serif', weight: 700, category: 'sans' },
  { id: 'josefin', label: 'Josefin Sans', family: '"Josefin Sans", sans-serif', weight: 700, category: 'sans' },
  { id: 'rubik', label: 'Rubik', family: '"Rubik", sans-serif', weight: 700, category: 'sans' },
  // Condensed / Impact
  { id: 'bebas', label: 'Bebas Neue', family: '"Bebas Neue", sans-serif', weight: 400, category: 'display' },
  { id: 'oswald', label: 'Oswald', family: '"Oswald", sans-serif', weight: 700, category: 'display' },
  { id: 'anton', label: 'Anton', family: '"Anton", sans-serif', weight: 400, category: 'display' },
  // Display / Decorative
  { id: 'abril', label: 'Abril Fatface', family: '"Abril Fatface", serif', weight: 400, category: 'display' },
  { id: 'righteous', label: 'Righteous', family: '"Righteous", sans-serif', weight: 400, category: 'display' },
  { id: 'monoton', label: 'Monoton', family: '"Monoton", cursive', weight: 400, category: 'display' },
  // Handwritten / Script
  { id: 'permanent-marker', label: 'Marker', family: '"Permanent Marker", cursive', weight: 400, category: 'script' },
  { id: 'caveat', label: 'Caveat', family: '"Caveat", cursive', weight: 700, category: 'script' },
];

// =============================================================================
// Color Schemes
// =============================================================================

export const COLOR_SCHEMES: { id: ColorSchemeId; label: string; swatch: string; color?: RGB }[] = [
  { id: 'auto', label: 'Auto', swatch: 'conic-gradient(from 0deg, #8b5cf6, #ec4899, #f59e0b, #22c55e, #3b82f6, #8b5cf6)' },
  { id: 'midnight', label: 'Night', swatch: 'linear-gradient(135deg, #0f172a, #334155)', color: { r: 30, g: 35, b: 60 } },
  { id: 'warm', label: 'Warm', swatch: 'linear-gradient(135deg, #dc2626, #f59e0b)', color: { r: 200, g: 100, b: 30 } },
  { id: 'cool', label: 'Cool', swatch: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', color: { r: 60, g: 70, b: 180 } },
  { id: 'emerald', label: 'Forest', swatch: 'linear-gradient(135deg, #059669, #14b8a6)', color: { r: 20, g: 120, b: 90 } },
  { id: 'rose', label: 'Rose', swatch: 'linear-gradient(135deg, #e11d48, #f472b6)', color: { r: 190, g: 50, b: 80 } },
  { id: 'custom', label: 'Custom', swatch: 'conic-gradient(from 0deg, red, yellow, lime, cyan, blue, magenta, red)' },
];

export const GRADIENT_STYLES: { id: GradientStyle; label: string; css: string }[] = [
  { id: 'fade-up', label: 'Fade Up', css: 'linear-gradient(to top, rgba(0,0,0,0.9), transparent)' },
  { id: 'fade-down', label: 'Fade Down', css: 'linear-gradient(to bottom, rgba(0,0,0,0.9), transparent)' },
  { id: 'vignette', label: 'Vignette', css: 'radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,0.8) 100%)' },
  { id: 'diagonal-left', label: 'Corner', css: 'linear-gradient(to top right, rgba(0,0,0,0.9), transparent 70%)' },
  { id: 'diagonal-right', label: 'Corner', css: 'linear-gradient(to top left, rgba(0,0,0,0.9), transparent 70%)' },
  { id: 'wash', label: 'Wash', css: 'linear-gradient(135deg, rgba(0,0,0,0.55), rgba(0,0,0,0.45))' },
];

export const TEXT_POSITIONS: { id: TextPosition; label: string }[] = [
  { id: 'bottom-left', label: 'Bottom Left' },
  { id: 'bottom-center', label: 'Bottom Center' },
  { id: 'center', label: 'Center' },
  { id: 'top-left', label: 'Top Left' },
];

// =============================================================================
// Category Constants
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

let cssLoaded = false;

export async function loadShareFonts(): Promise<void> {
  if (!cssLoaded) {
    if (!document.querySelector('link[data-share-fonts]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Anton&family=Bebas+Neue&family=Caveat:wght@700&family=Cormorant+Garamond:wght@600&family=DM+Sans:wght@400;500;700&family=DM+Serif+Display&family=Josefin+Sans:wght@700&family=Libre+Baskerville:wght@700&family=Lora:wght@700&family=Monoton&family=Oswald:wght@700&family=Outfit:wght@700&family=Permanent+Marker&family=Playfair+Display:wght@700&family=Raleway:wght@700&family=Righteous&family=Rubik:wght@700&family=Sora:wght@700&family=Space+Grotesk:wght@700&display=swap';
      link.setAttribute('data-share-fonts', 'true');
      document.head.appendChild(link);
    }
    cssLoaded = true;
  }

  await document.fonts.ready;

  // Always load DM Sans (used for supporting text)
  try {
    await Promise.all([
      document.fonts.load('400 48px "DM Sans"'),
      document.fonts.load('500 48px "DM Sans"'),
      document.fonts.load('700 48px "DM Sans"'),
    ]);
  } catch { /* fallback */ }
}

// Load a specific title font on demand (called before rendering)
async function ensureFontLoaded(fontOpt: FontOption, size: number): Promise<void> {
  try {
    await document.fonts.load(`${fontOpt.weight} ${size}px ${fontOpt.family}`);
  } catch { /* fallback */ }
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
        if (existing) { existing.r += r; existing.g += g; existing.b += b; existing.count++; }
        else { buckets.set(key, { r, g, b, count: 1 }); }
      }

      let best: RGB = { r: 40, g: 40, b: 50 };
      let bestCount = 0;
      for (const bucket of buckets.values()) {
        if (bucket.count > bestCount) {
          bestCount = bucket.count;
          best = { r: Math.round(bucket.r / bucket.count), g: Math.round(bucket.g / bucket.count), b: Math.round(bucket.b / bucket.count) };
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
  return { r: Math.round(c.r * (1 - amount)), g: Math.round(c.g * (1 - amount)), b: Math.round(c.b * (1 - amount)) };
}

function lighten(c: RGB, amount: number): RGB {
  return { r: Math.round(c.r + (255 - c.r) * amount), g: Math.round(c.g + (255 - c.g) * amount), b: Math.round(c.b + (255 - c.b) * amount) };
}

function rgbStr(c: RGB, alpha = 1): string {
  return alpha < 1 ? `rgba(${c.r},${c.g},${c.b},${alpha})` : `rgb(${c.r},${c.g},${c.b})`;
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) } : { r: 128, g: 128, b: 128 };
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
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
    else { line = test; }
  }
  if (line) lines.push(line);
  return lines;
}

const imageCache = new Map<string, HTMLImageElement>();

function loadImageCached(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imageCache.set(url, img); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function drawCoverImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, W: number, H: number, focalY = 0.5) {
  const imgAspect = img.width / img.height;
  const canvasAspect = W / H;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (imgAspect > canvasAspect) { sw = img.height * canvasAspect; sx = (img.width - sw) / 2; }
  else { sh = img.width / canvasAspect; sy = (img.height - sh) * focalY; }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// =============================================================================
// Color Resolution
// =============================================================================

function resolveColor(design: CardDesign, dominantColor: RGB, category: string): RGB {
  if (design.colorScheme === 'auto') return dominantColor;
  if (design.colorScheme === 'custom' && design.customColor) return hexToRgb(design.customColor);
  const scheme = COLOR_SCHEMES.find(s => s.id === design.colorScheme);
  return scheme?.color || CATEGORY_COLORS[category] || dominantColor;
}

// =============================================================================
// Gradient Overlay
// =============================================================================

function drawGradientOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, color: RGB, style: GradientStyle, opacity: number) {
  // Scale black alpha values by the opacity parameter
  const a = (base: number) => base * opacity;

  switch (style) {
    case 'fade-up': {
      const grad = ctx.createLinearGradient(0, H * 0.25, 0, H);
      grad.addColorStop(0, `rgba(0,0,0,0)`);
      grad.addColorStop(0.3, `rgba(0,0,0,${a(0.25)})`);
      grad.addColorStop(0.6, `rgba(0,0,0,${a(0.65)})`);
      grad.addColorStop(1, `rgba(0,0,0,${a(0.92)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      const tint = ctx.createLinearGradient(0, H * 0.65, 0, H);
      tint.addColorStop(0, 'rgba(0,0,0,0)');
      tint.addColorStop(1, rgbStr(darken(color, 0.4), 0.25 * opacity));
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'fade-down': {
      const grad = ctx.createLinearGradient(0, 0, 0, H * 0.75);
      grad.addColorStop(0, `rgba(0,0,0,${a(0.92)})`);
      grad.addColorStop(0.4, `rgba(0,0,0,${a(0.65)})`);
      grad.addColorStop(0.7, `rgba(0,0,0,${a(0.25)})`);
      grad.addColorStop(1, `rgba(0,0,0,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      const tint = ctx.createLinearGradient(0, 0, 0, H * 0.35);
      tint.addColorStop(0, rgbStr(darken(color, 0.4), 0.25 * opacity));
      tint.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'vignette': {
      const cx = W / 2, cy = H / 2;
      const r = Math.max(W, H) * 0.65;
      const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
      grad.addColorStop(0, `rgba(0,0,0,${a(0.05)})`);
      grad.addColorStop(0.4, `rgba(0,0,0,${a(0.2)})`);
      grad.addColorStop(0.7, `rgba(0,0,0,${a(0.55)})`);
      grad.addColorStop(1, `rgba(0,0,0,${a(0.88)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = rgbStr(darken(color, 0.3), 0.1 * opacity);
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'diagonal-left': {
      const grad = ctx.createLinearGradient(0, H, W, 0);
      grad.addColorStop(0, `rgba(0,0,0,${a(0.92)})`);
      grad.addColorStop(0.35, `rgba(0,0,0,${a(0.55)})`);
      grad.addColorStop(0.65, `rgba(0,0,0,${a(0.15)})`);
      grad.addColorStop(1, `rgba(0,0,0,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = rgbStr(darken(color, 0.3), 0.12 * opacity);
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'diagonal-right': {
      const grad = ctx.createLinearGradient(W, H, 0, 0);
      grad.addColorStop(0, `rgba(0,0,0,${a(0.92)})`);
      grad.addColorStop(0.35, `rgba(0,0,0,${a(0.55)})`);
      grad.addColorStop(0.65, `rgba(0,0,0,${a(0.15)})`);
      grad.addColorStop(1, `rgba(0,0,0,0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = rgbStr(darken(color, 0.3), 0.12 * opacity);
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'wash': {
      ctx.fillStyle = `rgba(0,0,0,${a(0.58)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = rgbStr(darken(color, 0.3), 0.15 * opacity);
      ctx.fillRect(0, 0, W, H);
      break;
    }
  }
}

// =============================================================================
// Text Content Rendering (synchronous — used for both full render and drag)
// =============================================================================

export function drawTextContent(
  ctx: CanvasRenderingContext2D,
  event: ShareEventData,
  type: TemplateType,
  design: CardDesign,
  W: number, H: number,
) {
  const isStory = type === 'story';
  const pad = isStory ? 64 : 56;
  const maxTextW = W - pad * 2;

  const fontOpt = FONT_OPTIONS.find(f => f.id === design.font) || FONT_OPTIONS[0]!;
  const detailFontOpt = FONT_OPTIONS.find(f => f.id === design.detailFont) || FONT_OPTIONS.find(f => f.id === 'dm-sans') || FONT_OPTIONS[0]!;
  const titleSize = design.titleSize;
  const venueSize = design.supportSize;
  const dateSize = Math.round(design.supportSize * 0.92);

  const centered = design.position === 'bottom-center' || design.position === 'center';
  ctx.textAlign = centered ? 'center' : 'left';
  const textX = centered ? W / 2 : pad;

  // Apply title offset
  const ox = design.titleOffsetX;
  const oy = design.titleOffsetY;

  // Prepare title
  ctx.font = `${fontOpt.weight} ${titleSize}px ${fontOpt.family}`;
  const titleLines = wrapText(ctx, event.title, maxTextW);
  const maxLines = isStory ? 4 : 3;
  const displayTitle = titleLines.slice(0, maxLines);
  if (titleLines.length > maxLines) {
    let last = displayTitle[maxLines - 1] || '';
    while (ctx.measureText(last + '\u2026').width > maxTextW && last.length > 1) {
      last = last.replace(/\s?\S*$/, '');
    }
    displayTitle[maxLines - 1] = last + '\u2026';
  }
  const titleLineH = titleSize * 1.18;

  // Prepare date/time
  const dateStr = formatDateLong(event.event_date);
  const timeStr = formatTime12(event.start_time);
  const endStr = event.end_time ? ` \u2013 ${formatTime12(event.end_time)}` : '';

  // Prepare venue (truncate if needed)
  ctx.font = `${detailFontOpt.weight} ${venueSize}px ${detailFontOpt.family}`;
  let venueLine = event.venue_name;
  if (ctx.measureText(venueLine).width > maxTextW) {
    while (ctx.measureText(venueLine + '\u2026').width > maxTextW && venueLine.length > 1) {
      venueLine = venueLine.slice(0, -1);
    }
    venueLine += '\u2026';
  }

  const enableShadow = () => {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
  };
  const disableShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  };

  // ---- Bottom positions ----
  if (design.position === 'bottom-left' || design.position === 'bottom-center') {
    let y = H - (isStory ? 80 : 56);

    if (design.showDateTime) {
      ctx.font = `${detailFontOpt.weight} ${dateSize}px ${detailFontOpt.family}`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(`${timeStr}${endStr}`, textX + ox, y + oy);
      y -= dateSize + 6;
      ctx.fillText(dateStr, textX + ox, y + oy);
      y -= dateSize + 16;
    }

    if (design.showVenue) {
      ctx.font = `${detailFontOpt.weight} ${venueSize}px ${detailFontOpt.family}`;
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(venueLine, textX + ox, y + oy);
      y -= venueSize + 28;
    }

    enableShadow();
    ctx.font = `${fontOpt.weight} ${titleSize}px ${fontOpt.family}`;
    ctx.fillStyle = '#ffffff';
    for (let i = displayTitle.length - 1; i >= 0; i--) {
      ctx.fillText(displayTitle[i]!, textX + ox, y + oy);
      y -= titleLineH;
    }
    disableShadow();
    return;
  }

  // ---- Top-left ----
  if (design.position === 'top-left') {
    let y = isStory ? 160 : 100;

    enableShadow();
    ctx.font = `${fontOpt.weight} ${titleSize}px ${fontOpt.family}`;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    for (const line of displayTitle) {
      ctx.fillText(line, textX + ox, y + oy);
      y += titleLineH;
    }
    disableShadow();
    ctx.textBaseline = 'alphabetic';
    y += 16;

    if (design.showVenue) {
      ctx.font = `${detailFontOpt.weight} ${venueSize}px ${detailFontOpt.family}`;
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(venueLine, textX + ox, y + venueSize * 0.8 + oy);
      y += venueSize + 16;
    }

    if (design.showDateTime) {
      ctx.font = `${detailFontOpt.weight} ${dateSize}px ${detailFontOpt.family}`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(dateStr, textX + ox, y + dateSize * 0.8 + oy);
      y += dateSize + 6;
      ctx.fillText(`${timeStr}${endStr}`, textX + ox, y + dateSize * 0.8 + oy);
    }
    return;
  }

  // ---- Center ----
  const titleBlockH = displayTitle.length * titleLineH;
  const venueBlockH = design.showVenue ? venueSize + 16 : 0;
  const dateBlockH = design.showDateTime ? dateSize * 2 + 6 : 0;
  const gaps = 16 + (design.showVenue ? 16 : 0);
  const totalH = titleBlockH + venueBlockH + dateBlockH + gaps;

  let y = (H - totalH) / 2;

  enableShadow();
  ctx.font = `${fontOpt.weight} ${titleSize}px ${fontOpt.family}`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  for (const line of displayTitle) {
    ctx.fillText(line, textX + ox, y + oy);
    y += titleLineH;
  }
  disableShadow();
  ctx.textBaseline = 'alphabetic';
  y += 16;

  if (design.showVenue) {
    ctx.font = `${detailFontOpt.weight} ${venueSize}px ${detailFontOpt.family}`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(venueLine, textX + ox, y + venueSize * 0.8 + oy);
    y += venueSize + 16;
  }

  if (design.showDateTime) {
    ctx.font = `${detailFontOpt.weight} ${dateSize}px ${detailFontOpt.family}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(dateStr, textX + ox, y + dateSize * 0.8 + oy);
    y += dateSize + 6;
    ctx.fillText(`${timeStr}${endStr}`, textX + ox, y + dateSize * 0.8 + oy);
  }
}

// =============================================================================
// Background Rendering (image + gradient, no text)
// =============================================================================

function drawGradientBg(ctx: CanvasRenderingContext2D, W: number, H: number, color: RGB) {
  const top = lighten(color, 0.2);
  const bot = darken(color, 0.85);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, rgbStr(top));
  bg.addColorStop(1, rgbStr(bot));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
}

export async function renderBackground(
  event: ShareEventData,
  type: TemplateType,
  dominantColor: RGB,
  design: CardDesign,
): Promise<HTMLCanvasElement> {
  const W = 1080;
  const H = type === 'story' ? 1920 : 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const color = resolveColor(design, dominantColor, event.category);

  ctx.fillStyle = rgbStr(darken(color, 0.8));
  ctx.fillRect(0, 0, W, H);

  if (event.image_url) {
    try {
      const img = await loadImageCached(event.image_url);
      if (design.blur > 0) {
        ctx.filter = `blur(${design.blur}px)`;
      }
      drawCoverImage(ctx, img, W, H, event.image_focal_y ?? 0.5);
      ctx.filter = 'none';
    } catch {
      drawGradientBg(ctx, W, H, color);
    }
  } else {
    drawGradientBg(ctx, W, H, color);
  }

  drawGradientOverlay(ctx, W, H, color, design.gradient, design.gradientOpacity);

  return canvas;
}

// =============================================================================
// Full Template Rendering
// =============================================================================

export async function renderTemplate(
  event: ShareEventData,
  type: TemplateType,
  dominantColor: RGB,
  design: CardDesign = DEFAULT_DESIGN,
): Promise<HTMLCanvasElement> {
  await loadShareFonts();

  const fontOpt = FONT_OPTIONS.find(f => f.id === design.font) || FONT_OPTIONS[0]!;
  const detailFontOpt = FONT_OPTIONS.find(f => f.id === design.detailFont) || FONT_OPTIONS.find(f => f.id === 'dm-sans') || FONT_OPTIONS[0]!;
  await Promise.all([
    ensureFontLoaded(fontOpt, design.titleSize),
    ensureFontLoaded(detailFontOpt, design.supportSize),
  ]);

  const bg = await renderBackground(event, type, dominantColor, design);
  const W = bg.width;
  const H = bg.height;

  // Clone bg and draw text on top
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bg, 0, 0);

  drawTextContent(ctx, event, type, design, W, H);

  return canvas;
}

// Synchronous redraw: composites bg + text without async (for drag)
export function redrawText(
  canvas: HTMLCanvasElement,
  bgCanvas: HTMLCanvasElement,
  event: ShareEventData,
  type: TemplateType,
  design: CardDesign,
): void {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bgCanvas, 0, 0);
  drawTextContent(ctx, event, type, design, canvas.width, canvas.height);
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
