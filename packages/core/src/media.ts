// Фото и видео: раскладка по месяцам (бывшая платная функция, теперь свободная).
const DAY_MS = 24 * 60 * 60 * 1000

/** Папка месяца по местному времени: «2026-10». */
export function monthFolder(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|dng|raw|cr2|nef|arw|mov|mp4|m4v|avi|3gp|mkv|webm|hevc)$/i

/** Фото или видео: по заявленному типу, иначе по расширению. */
export function isMedia(mime: string | undefined, name: string | undefined): boolean {
  if (typeof mime === 'string' && /^(image|video)\//i.test(mime)) return true
  return typeof name === 'string' && MEDIA_EXT.test(name)
}

/** Дата файла с телефона (lastModified, мс), если правдоподобна; иначе дата прихода. */
export function photoDate(lastModified: unknown, arrivalMs: number): number {
  const n = typeof lastModified === 'number' ? lastModified : NaN
  if (Number.isFinite(n) && n >= Date.UTC(2000, 0, 1) && n <= arrivalMs + DAY_MS) return n
  return arrivalMs
}

export type Kind = 'file' | 'photo' | 'text' | 'clipboard'
