import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import QRCode from 'qrcode'

import {
  PRODUCT_NAME,
  VERSION,
  PROTOCOL_TAG,
  CHUNK_SIZE,
  MAX_CHUNK_BODY,
  MAX_TEXT_BYTES,
  PENDING_PAIRING_TTL_MS,
  DEVICE_MAX_IDLE_MS,
  DEFAULT_PORT,
  FIREWALL_CHECK_AFTER_MS,
} from './constants.js'
import { loadConfig, saveConfig, flitdropHome, clampInt, type Config } from './config.js'
import { DeviceStore, type Device } from './pairing.js'
import { History } from './history.js'
import { Outbox } from './outbox.js'
import { Hub } from './events.js'
import { TransferManager, ApiError } from './transfers.js'
import { NonceCache, open, seal, openFreshJSON, sealJSON, randomToken } from './crypto.js'
import { createClipboardText, type ClipboardTextBackend } from './clip.js'
import { ClipHistory } from './cliphistory.js'
import { TransferActivity } from './activity.js'
import { HOST_ACTIONS, type HostAction, type HostPatch, type HostState } from './host.js'
import { repairProfiles, type FirewallStatus, type RepairResult } from './firewall.js'
import { saveMultipartFiles } from './uploads.js'
import { markFromOutside } from './quarantine.js'
import { pcLink, type PcLink } from './wifi.js'
import { monthFolder, photoDate, isMedia, type Kind } from './media.js'
import { t as tr, tp, resolveLang, langFrom, acceptLang } from './i18n.js'
import {
  b64u,
  isLoopback,
  localIPv4s,
  moduleDir,
  parseCookies,
  reserveUniquePath,
  systemOpener,
  sanitizeFilename,
  timingSafeEqualStr,
} from './util.js'

export { t, resolveLang, langFrom } from './i18n.js'
export { ClipboardWatcher, isConcealedClipboard } from './clipwatch.js'
export { TransferActivity, type TransferActivityState } from './activity.js'
export { TransferKeepAwake } from './host.js'
export { checkWindowsFirewall, repairWindowsFirewall, type FirewallStatus, type RepairResult } from './firewall.js'

/** Ports essayés dans l'ordre : le port mémorisé, puis des ports fixes
 *  voisins du port par défaut (retrouvés d'un lancement à l'autre même si la
 *  config est perdue), puis 0 (port libre choisi par le système). Un port
 *  imposé à 0 (tests) donne directement un port libre. */
export function portCandidates(wanted: number): number[] {
  if (wanted === 0) return [0]
  const out = [wanted]
  for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + 10; p++) if (!out.includes(p)) out.push(p)
  out.push(0)
  return out
}

/** Nom du PC pour l'icône du téléphone : sans caractères de contrôle ni de
 *  mise en forme, espaces resserrés, court (l'écran d'accueil coupe vite). */
export function iconPcName(name: string): string {
  const clean = [...String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()]
  const short = clean.length > 20 ? clean.slice(0, 19).join('').trimEnd() + '…' : clean.join('')
  return short || 'PC'
}

/** Nom de l'icône et de la page : « Flitdrop · <PC> ». */
export function phoneAppTitle(pcName: string): string {
  return `${PRODUCT_NAME} · ${iconPcName(pcName)}`
}

const escapeHtml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Page du téléphone avec le nom du PC (titre et nom de l'icône iPhone). */
export function phonePageHtml(html: string, pcName: string): string {
  const title = escapeHtml(phoneAppTitle(pcName))
  // fonctions de remplacement : un « $ » dans le nom du PC reste un « $ »
  return html
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, (_m, a: string, b: string) => a + title + b)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
}

/** Manifeste du téléphone avec le nom du PC (icône Android). */
export function phoneManifest(raw: string, pcName: string): string {
  const m = JSON.parse(raw) as Record<string, unknown>
  const title = phoneAppTitle(pcName)
  m.name = title
  m.short_name = title
  return JSON.stringify(m, null, 2)
}

/** Code HTTP d'une erreur : celui d'une ApiError, sinon 500. Une erreur du
 *  disque porte un code texte (ENAMETOOLONG, EACCES…) que res.status refuse
 *  en levant une exception : la requête restait pendue, et le serveur en
 *  ligne de commande s'arrêtait. */
function httpStatus(code: unknown): number {
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : 500
}

/** Requête de la page du PC : hôte de bouclage, et ni le navigateur ni
 *  l'origine ne disent qu'elle vient d'un autre site. */
export function looksLikeFlitdropSecret(text: string): boolean {
  const t = text.trim()
  return /\/s\/#[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{40,}/.test(t) || /\/api\/shortcut\/[a-z]+\?(?:[^ ]*&)?t=[A-Za-z0-9_-]{16,}/.test(t) || /[?&]t=[A-Za-z0-9_-]{20,}/.test(t) && /:\d{2,5}\//.test(t)
}

export function sameSiteOk(h: import('node:http').IncomingHttpHeaders): boolean {
  const host = String(h.host ?? '').toLowerCase()
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false
  const site = String(h['sec-fetch-site'] ?? '')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = h.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false
    } catch {
      return false
    }
  }
  return true
}

const MAX_CONNECTIONS_PER_IP = 48
const PORT_WAIT_MS = 3000

const PUBLIC_DIR = path.join(moduleDir(import.meta.url), '..', 'public')
const ADMIN_COOKIE = 'wd_admin'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

// Вариант для страницы ПК (loopback + токен): внешние ресурсы не загружаются
// никогда; WebSocket — только к этому ПК.
const CSP_ADMIN = CSP.replace(
  "connect-src 'self' ws: wss:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*"
)

// Le Worker de chiffrement du téléphone (cw.js) compile son module
// WebAssembly : lui seul reçoit 'wasm-unsafe-eval' (compiler du WebAssembly,
// jamais évaluer du JavaScript). La page elle-même garde la règle stricte.
export const PHONE_CRYPTO_WORKER = '/s/cw.js'
const CSP_WORKER = CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")

// Fonctions de cette version que la page du téléphone peut utiliser (annoncées
// au hello) : une page plus ancienne les ignore, une page plus récente ne les
// propose pas à un PC qui ne les annonce pas.
const PHONE_FEATURES = ['speedtest']
// test de vitesse : octets aléatoires, bornés
const SPEEDTEST_DOWN_MAX = 64 * 1024 * 1024
const SPEEDTEST_UP_MAX = 8 * 1024 * 1024

export interface StartOptions {
  port?: number
  home?: string
  quiet?: boolean
  disableClipboard?: boolean
  // fourni par l'app de bureau : le presse-papiers contient-il un secret
  // marqué par un gestionnaire de mots de passe (voir isConcealedClipboard) ?
  // Un tel contenu n'est jamais envoyé aux téléphones.
  clipboardConcealed?: () => boolean
  // fourni par l'app de bureau (Electron) pour recopier une image de
  // l'historique dans le presse-papiers du système.
  writeImageToClipboard?: (png: Buffer) => void
  // fourni par l'app de bureau : lecture et écriture du texte par Electron,
  // sans lancer pbpaste ou PowerShell à chaque vérification.
  clipboardText?: ClipboardTextBackend
  // l'app de bureau fait tourner UNE seule surveillance (texte et images) et
  // appelle pollClipboard() elle-même : le coeur ne lance pas sa minuterie.
  manualClipboardPoll?: boolean
  // lecture du lien réseau du PC pour le test de vitesse (tests : sans lancer
  // system_profiler ni netsh)
  pcLink?: (localAddress: string | undefined) => Promise<PcLink>
  // prévenu après chaque enregistrement des réglages (l'app de bureau réveille
  // sa surveillance du presse-papiers quand une fonction est rallumée)
  onSettingsChanged?: () => void
  // fourni par l'app de bureau : la page demande une action du système
  // (ouvrir le .dmg d'une nouvelle version, les réglages de démarrage de macOS)
  onHostAction?: (action: HostAction) => void
  // fourni par l'app de bureau : lancement à l'ouverture de session (lu et
  // réglé dans le système). Sans lui (CLI, tests), la page ne le propose pas.
  autostart?: { get: () => boolean; set: (on: boolean) => void }
  // fourni par l'app de bureau sous Windows : vérification du pare-feu pour
  // l'adresse du QR code, et réparation (demande des droits administrateur).
  // Sans lui (Mac, Linux, CLI, tests), rien ne tourne et la page ne montre rien.
  firewall?: {
    check: (ip: string | undefined) => Promise<FirewallStatus | null>
    /** `status` : la dernière vérification (la règle suit son réseau) */
    repair: (status: FirewallStatus) => Promise<RepairResult>
    /** QR visible depuis au moins ce délai avant la vérification (45 s ; tests) */
    afterMs?: number
  }
  // fourni par l'app de bureau : ouvre une adresse dans le navigateur du
  // système (shell.openExternal). Sans lui : open, explorer ou xdg-open.
  openExternal?: (url: string) => void
  /** App de bureau : ouvre un lien http(s) copié (historique du presse-papiers)
   *  avec l'ouvreur d'Electron. Sans lui : programme du système, chemin absolu. */
  openLink?: (url: string) => void
  /** App de bureau : ouvre un dossier (shell.openPath). */
  openPath?: (dir: string) => void
}

export interface RunningServer {
  port: number
  adminToken: string
  cfg: Config
  home: string
  adminUrl: string
  /** Met des fichiers locaux à disposition des téléphones (clic-droit
   *  « Envoyer vers », glisser sur l'icône, ligne de commande). */
  addLocalFiles: (paths: string[]) => Promise<number>
  /** Enregistre une image copiée sur le PC dans l'historique du presse-papiers
   *  (appelé par l'app de bureau qui lit l'image via Electron). `fp` :
   *  empreinte de la copie, pour ne pas ajouter deux fois la même image. */
  addClipboardImage: (png: Buffer, thumb: string, w: number, h: number, fp?: string) => void
  /** Vérifie une fois le texte du presse-papiers (surveillance pilotée par
   *  l'app de bureau quand manualClipboardPoll est vrai). `true` : nouveau texte. */
  pollClipboard: () => Promise<boolean>
  /** Activité des transferts : événement 'transfer' { active, progress }.
   *  active passe à true dès que des octets passent (dans un sens ou dans
   *  l'autre), à false 30 s après le dernier octet ; progress (0 à 1) est la
   *  progression globale quand elle est connue, sinon null ; running compte
   *  les transferts encore en cours (0 : tout est arrivé). Au plus 2
   *  annonces par seconde, et une au moins toutes les 10 minutes tant que des
   *  octets passent. */
  activity: TransferActivity
  /** L'app de bureau signale un état du système à la page (nouvelle version
   *  sur Mac, démarrage automatique à autoriser) : la page se redessine. */
  setHost: (patch: HostPatch) => void
  /** Allume ou coupe le lancement à l'ouverture de session (menu de l'icône,
   *  écran d'accueil, réglages) : la question est alors considérée comme
   *  répondue. false sans opts.autostart. */
  setAutostart: (on: boolean) => boolean
  close: () => Promise<void>
}

interface PhoneContext {
  dev: Device
  key: Uint8Array
  payload: Record<string, unknown>
}

function rateLimit(max: number, windowMs: number, keyOf?: (req: Request) => string) {
  const hits = new Map<string, { n: number; reset: number }>()
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = keyOf ? keyOf(req) : (req.socket.remoteAddress ?? '?')
    const now = Date.now()
    if (hits.size > 2000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    }
    let h = hits.get(ip)
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + windowMs }
      hits.set(ip, h)
    }
    if (++h.n > max) return res.status(429).json({ code: 'rateLimited' })
    next()
  }
}

// budget des requêtes de transfert d'un téléphone appairé, par minute : environ
// 100 par seconde, bien au-delà de ce que le wifi permet (morceaux de 8 Mo),
// et assez pour 2 000 petites photos par minute.
const TRANSFER_RATE_PER_MIN = 6000
// chemins (sous /api/phone) comptés dans ce budget. Le statut n'en fait pas
// partie : sans authentification, il reste à la limite stricte par adresse
// (le téléphone ne le demande qu'après une coupure).
const PHONE_TRANSFER_ROUTE = /^\/(?:transfer\/(?:init|[^/]+\/(?:chunk\/\d+|finish))|outbox\/[^/]+\/download)$/

// au-delà, un texte envoyé compte comme un transfert (activité, PC éveillé)
const LARGE_TEXT_BYTES = 64 * 1024

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  if (opts.disableClipboard) process.env.FLITDROP_NO_CLIP = '1'
  const home = flitdropHome(opts.home)
  const cfg = loadConfig(home)
  // port imposé (tests, ligne de commande) : utilisé pour ce lancement
  // seulement, sans toucher au port mémorisé
  const wantedPort = opts.port ?? cfg.port

  // lancement à l'ouverture de session, tel que le système le rapporte
  // (null : inconnu, hors app de bureau). Relu à chaque /state et après un
  // changement ; la statistique du jour lit cette valeur.
  const readAutostart = (): boolean | null => {
    if (!opts.autostart) return null
    try {
      return opts.autostart.get() === true
    } catch {
      return null
    }
  }
  let autostartOn = readAutostart()

  const devices = new DeviceStore(home)
  // hygiène au démarrage : on oublie les appairages inactifs de longue date
  devices.pruneIdle(DEVICE_MAX_IDLE_MS)
  const history = new History(home)
  const outbox = new Outbox(home)
  const hub = new Hub()
  const nonces = new NonceCache()
  const activity = new TransferActivity()
  const transfers = new TransferManager(() => cfg, history, hub, activity)
  const clipHistory = new ClipHistory(home)
  // réglages et état qui changent le contenu des listes du téléphone (nom du
  // PC, historique activé, plan Flitdrop Pro) : voir outboxTag et clipTag
  let settingsGen = 0

  // Adresse ouverte dans le navigateur du système (page d'achat de Flitdrop
  // Pro) : seulement http(s), ou l'adresse fixe du support, jamais
  // interprétée par un shell.
  const openExternal = (url: string): void => {
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) return
    if (opts.openExternal) {
      opts.openExternal(url)
      return
    }
    const child = spawn(systemOpener(), [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }

  const clipView = () => clipHistory.list()
  const clipVisible = (_id: string): boolean => true
  // photos et vidéos rangées par mois (Pro) : date du fichier sur le
  // téléphone, sinon date d'arrivée
  transfers.folderFor = (t) =>
    cfg.sortPhotosByMonth && isMedia(t.mime, t.name) ? path.join(cfg.downloadDir, monthFolder(photoDate(t.lastModified, Date.now()))) : cfg.downloadDir

  // même règle pour un fichier reçu par le Raccourci iOS (pas de date du
  // téléphone : celle d'arrivée)
  const placeByMonth = <F extends { name: string; path: string; mime?: string }>(f: F): F => {
    if (!cfg.sortPhotosByMonth || !isMedia(f.mime, f.name)) return f
    try {
      const dir = path.join(cfg.downloadDir, monthFolder(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      const reserved = reserveUniquePath(dir, f.name)
      fs.closeSync(reserved.fd)
      fs.renameSync(f.path, reserved.path)
      return { ...f, path: reserved.path, name: path.basename(reserved.path) }
    } catch {
      return f
    }
  }

  // un transfert téléphone -> PC qui échoue (refus, disque, expiration…) est
  // compté une seule fois, avec son code d'erreur, jamais son nom de fichier.
  // textes de la file d'envoi déjà comptés comme reçus par tel téléphone
  const textDelivered = new Set<string>()
  // Transfert réussi, dans un sens ou dans l'autre : statistique, premier
  // transfert (fin du premier envoi guidé) et compteur de la demande de note.
  // La page du PC est prévenue quand l'un des deux change ce qu'elle montre.
  const transferOk = (..._args: unknown[]): void => {
    const first = !cfg.firstTransferDone
    cfg.firstTransferDone = true
    if (first) {
      try {
        saveConfig(home, cfg)
      } catch {
        // non critique : recompté au prochain transfert
      }
    }
    if (first) hub.broadcast('milestone', {})
  }

  // ---------- surveillance du presse-papiers du PC ----------
  // Le seul sens réellement automatisable côté PC : on lit notre propre presse-
  // papiers (aucune restriction OS pour ça). Quand il change : on l'enregistre
  // dans l'historique local (si activé) et on le met à disposition des
  // téléphones (si la synchro est activée). `lastClip` sert d'anti-boucle : le
  // texte reçu d'un téléphone ne doit pas être renvoyé.
  let lastClip = ''
  // pour les images : l'app de bureau pousse les images copiées via
  // addClipboardImage. `lastImageHash` évite de ré-enregistrer une image qu'on
  // vient de recopier soi-même depuis l'historique.
  let lastImageHash = ''
  const imageHash = (png: Buffer): string => `${png.length}:${png.length > 64 ? png.subarray(0, 64).toString('hex') : png.toString('hex')}`
  // ---------- destinataires (plusieurs téléphones) ----------
  const activePhones = () => devices.listPublic().filter((d) => d.status === 'active')
  // Téléphone proposé par défaut pour un envoi du PC : le dernier choisi,
  // sinon le dernier téléphone vu. 'all' seulement si on l'a choisi.
  const defaultSendTo = (): string => {
    const active = activePhones()
    if (cfg.lastSendTo === 'all') return 'all'
    if (active.some((d) => d.id === cfg.lastSendTo)) return cfg.lastSendTo
    const recent = [...active].sort(
      (a, b) => (Date.parse(b.lastSeenAt ?? b.createdAt) || 0) - (Date.parse(a.lastSeenAt ?? a.createdAt) || 0) || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    )[0]
    return recent?.id ?? 'all'
  }
  // Destinataires d'un envoi du PC. `undefined` : tous, quand un seul
  // téléphone (ou aucun) est appairé, comme avant. `null` : choix invalide
  // (téléphone retiré entre-temps). Un choix explicite devient le défaut.
  const sendTargets = (to: unknown): string[] | undefined | null => {
    const active = activePhones()
    const ids = new Set(active.map((d) => d.id))
    if (to === undefined || to === null || to === '') {
      if (active.length <= 1) return undefined
      to = defaultSendTo()
    } else if (typeof to === 'string') {
      if (to !== 'all' && !ids.has(to)) return null
      if (to !== cfg.lastSendTo) {
        cfg.lastSendTo = to
        try {
          saveConfig(home, cfg)
        } catch {
          // non critique : le choix reste en mémoire pour ce lancement
        }
      }
    }
    if (to === 'all') return active.length <= 1 ? undefined : [...ids]
    if (typeof to === 'string') return active.length <= 1 ? undefined : [to]
    if (!Array.isArray(to) || to.length === 0 || !to.every((x) => typeof x === 'string' && ids.has(x))) return null
    return active.length <= 1 ? undefined : [...new Set(to as string[])]
  }
  // Envoi automatique du presse-papiers : seulement aux téléphones qui le
  // voient. `null` : aucun téléphone autorisé, rien ne part.
  const clipTargets = (): string[] | undefined | null => {
    const active = activePhones()
    if (active.length === 0) return undefined
    const allowed = active.filter((d) => d.clipShare).map((d) => d.id)
    if (allowed.length === 0) return null
    return active.length === 1 ? undefined : allowed
  }
  const concealed = (): boolean => {
    try {
      return opts.clipboardConcealed?.() === true
    } catch {
      return false
    }
  }

  const clip = createClipboardText(opts.clipboardText)
  clip.read().then((t) => (lastClip = t)).catch(() => {})
  // une lecture à la fois : un PowerShell lent (antivirus, disque) ne doit pas
  // empiler les processus d'une vérification à l'autre. clip.read() rend
  // toujours la main (délai max, programme tué) : `polling` ne reste pas coincé.
  let polling = false
  const pollClipboard = async (): Promise<boolean> => {
    if (polling || (!cfg.clipboardAutoPush && !cfg.clipHistoryEnabled)) return false
    polling = true
    let text = ''
    try {
      text = await clip.read().catch(() => '')
    } finally {
      polling = false
    }
    if (!text || text === lastClip || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return false
    lastClip = text
    // lien d'appairage ou adresse du Raccourci copiés depuis Flitdrop : ils
    // portent une clé, jamais gardés dans l'historique ni envoyés aux téléphones
    if (looksLikeFlitdropSecret(text)) return false
    if (cfg.clipHistoryEnabled && clipHistory.add(text, 'pc', cfg)) {
      hub.broadcast('cliphistory-changed', {})
    }
    // synchro automatique : réservée à Pro quand le mode payant est actif
    const to = cfg.clipboardAutoPush ? clipTargets() : null
    if (to !== null) {
      outbox.addText(text, 'clipboard', to)
      hub.broadcast('outbox-changed', {})
      hub.broadcast('clip-autopushed', { preview: text.slice(0, 120) })
    }
    return true
  }
  const clipTimer = opts.manualClipboardPoll ? undefined : setInterval(() => void pollClipboard(), 1500)
  clipTimer?.unref?.()
  // purge périodique de l'historique (rétention par âge). La même minuterie
  // fait le point quotidien de Flitdrop Pro (configuration une fois par jour,
  // renouvellement, minuit) : aucune minuterie de plus.
  const clipPurgeTimer = setInterval(() => {
    if (clipHistory.size() > 0) clipHistory.purge(cfg)
  }, 10 * 60 * 1000)
  clipPurgeTimer.unref?.()
  // expire les QR d'appairage non scannés (fenêtre d'exploitation d'une photo
  // du QR minimale, indépendamment des clics sur « Appairer »). Les codes
  // expirés sont gardés en mémoire une heure (identifiant seul, jamais sur le
  // disque) : un téléphone qui en scanne un apprend que le code a expiré.
  const expiredPairings = new Map<string, { ts: number; reported: boolean }>()
  const prunePending = () => {
    const now = Date.now()
    for (const id of devices.prunePending(PENDING_PAIRING_TTL_MS)) expiredPairings.set(id, { ts: now, reported: false })
    for (const [id, v] of expiredPairings) if (now - v.ts > 60 * 60 * 1000 || expiredPairings.size > 200) expiredPairings.delete(id)
  }
  const pendingTimer = setInterval(prunePending, 60 * 1000)
  pendingTimer.unref?.()

  // Fenêtre d'appairage ouverte sur le PC, pour les statistiques du chemin de
  // connexion : les codes montrés depuis son ouverture (renouvelés compris),
  // qr_shown déjà compté ou non, un téléphone l'a-t-il scannée. En mémoire.
  let pairView: { ids: Set<string>; qrSent: boolean; scanned: boolean; openedAt: number; fwAsked: boolean } | null = null
  // une fois par ouverture : au premier renouvellement (renewed vrai), sinon
  // au scan réussi ou à la fermeture (renewed faux)
  const reportQrShown = (renewed: boolean) => {
    if (!pairView || pairView.qrSent) return
    pairView.qrSent = true
  }
  const closePairView = () => {
    if (!pairView) return
    reportQrShown(false)
    pairView = null
  }

  // Pare-feu de Windows (app de bureau sous Windows seulement, voir
  // firewall.ts). Vérifié UNE fois quand le QR est resté visible 45 s sans
  // qu'aucun téléphone ouvre la page, jamais en boucle ; réparé seulement
  // quand la personne clique « Réparer ». En mémoire, jamais sur le disque.
  const fw = {
    status: null as FirewallStatus | null,
    checking: false,
    repairing: false,
    // résultat de la dernière réparation (montré dans la carte)
    repair: null as RepairResult | null,
    // un problème vu a disparu à la vérification suivante
    fixed: false,
    // dernière vérification automatique, et dernier téléphone arrivé
    lastAutoAt: 0,
    reachedAt: 0,
  }
  // au plus une vérification automatique toutes les 10 minutes (la fenêtre
  // d'appairage rouverte plusieurs fois de suite garde le dernier résultat)
  const FIREWALL_AUTO_GAP_MS = 10 * 60 * 1000
  // `kind` : automatique (compté), « Vérifier à nouveau », ou juste après une
  // réparation (seule celle-ci garde le résultat de la réparation affiché)
  const runFirewallCheck = async (kind: 'auto' | 'again' | 'afterRepair'): Promise<void> => {
    if (!opts.firewall) return
    const startedAt = Date.now()
    if (kind !== 'afterRepair') fw.repair = null
    fw.checking = true
    hub.broadcast('host-changed', {})
    let st: FirewallStatus | null = null
    try {
      st = await opts.firewall.check(bestIp())
    } catch {
      st = null
    }
    fw.checking = false
    if (st) {
      // un téléphone est arrivé pendant la vérification : rien à montrer
      const reached = fw.reachedAt >= startedAt
      const had = !!fw.status?.problem
      fw.status = reached ? null : st
      fw.fixed = had && !fw.status?.problem
    }
    hub.broadcast('host-changed', {})
  }
  const runFirewallRepair = async (status: FirewallStatus): Promise<void> => {
    if (!opts.firewall) return
    fw.repairing = true
    fw.repair = null
    fw.fixed = false
    hub.broadcast('host-changed', {})
    let result: RepairResult = 'failed'
    try {
      result = await opts.firewall.repair(status)
    } catch {
      result = 'failed'
    }
    if (result !== 'ok' && result !== 'cancelled') result = 'failed'
    fw.repairing = false
    fw.repair = result
    // règle posée : on revérifie tout de suite ; refus ou échec : la carte
    // reste, avec les étapes à faire soi-même
    if (result === 'ok') await runFirewallCheck('afterRepair')
    else hub.broadcast('host-changed', {})
  }
  const firewallReached = () => {
    fw.reachedAt = Date.now()
    if (fw.status || fw.fixed || fw.repair) {
      fw.status = null
      fw.fixed = false
      fw.repair = null
      hub.broadcast('host-changed', {})
    }
  }

  const pendingApprovals = new Map<string, (ok: boolean) => void>()
  transfers.approvalHook = (info) =>
    new Promise<boolean>((resolve) => {
      const id = randomToken(6)
      pendingApprovals.set(id, (ok) => {
        pendingApprovals.delete(id)
        resolve(ok)
      })
      hub.broadcast('approval-request', { id, ...info })
      setTimeout(() => {
        const cb = pendingApprovals.get(id)
        if (cb) {
          pendingApprovals.delete(id)
          hub.broadcast('approval-expired', { id })
          resolve(false)
        }
      }, 60_000).unref?.()
    })

  const aad = (deviceId: string, purpose: string, extra = '') =>
    `${PROTOCOL_TAG}|${deviceId}|${purpose}${extra ? '|' + extra : ''}`

  // Langue des réponses en clair (Raccourci iOS, garde admin) : le réglage du PC,
  // sinon la langue de l'appareil/navigateur qui appelle. Les erreurs de l'API
  // JSON, elles, sont renvoyées en CODES et traduites côté client.
  const reqLang = (req: Request) => resolveLang(cfg.lang, acceptLang(req.headers['accept-language']))
  const st = (req: Request, key: string, params?: Record<string, string | number>) => tr(reqLang(req), key, params)

  const app = express()
  app.disable('x-powered-by')

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // La page du PC (loopback + jeton) affiche des miniatures d'aperçu de liens
    // (YouTube, images) dans l'historique du presse-papiers : on autorise donc
    // les images https, mais seulement là. La page téléphone reste stricte.
    res.setHeader(
      'Content-Security-Policy',
      req.path.startsWith('/app') ? CSP_ADMIN : req.path === PHONE_CRYPTO_WORKER ? CSP_WORKER : CSP
    )
    next()
  })

  // ---------- authentification ----------

  const adminOk = (req: Request): boolean => {
    const cookie = parseCookies(req.headers.cookie)[ADMIN_COOKIE]
    const q = typeof req.query.k === 'string' ? req.query.k : ''
    const h = typeof req.headers['x-admin-token'] === 'string' ? (req.headers['x-admin-token'] as string) : ''
    const tok = q || h || cookie || ''
    return tok.length > 0 && timingSafeEqualStr(tok, cfg.adminToken)
  }

  const phoneAuth = (purpose: string) => (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    const dev = id ? devices.get(id) : undefined
    if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
    const envelope = (req.body as { p?: unknown })?.p
    if (typeof envelope !== 'string') return res.status(403).json({ code: 'authRefused' })
    // essaie la clé courante puis la clé de session en attente (fenêtre de
    // rotation) ; si c'est celle en attente qui ouvre, on la promeut (preuve
    // que le téléphone l'a bien adoptée) et on abandonne l'ancienne.
    for (const cand of devices.candidateKeys(dev.id)) {
      try {
        const payload = openFreshJSON<Record<string, unknown>>(cand.key, envelope, aad(dev.id, purpose), nonces)
        if (cand.pending) devices.promoteKey(dev.id)
        ;(req as Request & { wd: PhoneContext }).wd = { dev, key: cand.key, payload }
        return next()
      } catch {
        // clé suivante
      }
    }
    res.status(403).json({ code: 'authRefused' })
  }

  const wd = (req: Request): PhoneContext => (req as Request & { wd: PhoneContext }).wd

  // ---------- activité des transferts ----------

  // Compte les octets d'un corps de requête au fil de l'eau. L'écouteur ne se
  // branche qu'au moment où le vrai lecteur (analyseur, busboy) se branche :
  // brancher « data » plus tôt ferait couler le flux dans le vide.
  const watchBody = (req: Request, onBytes: (n: number) => void) => {
    const onNew = (ev: string | symbol) => {
      if (ev !== 'data') return
      req.off('newListener', onNew)
      req.on('data', (c: Buffer) => onBytes(c.length))
    }
    req.on('newListener', onNew)
  }
  // Corps d'au moins `minBytes` (envoi par Raccourci) : compté comme un
  // transfert, avec sa progression quand la taille est annoncée. `allow` :
  // seulement pour un expéditeur reconnu, sinon n'importe qui sur le wifi
  // garderait le PC éveillé avec de faux envois.
  const trackBody = (prefix: string, minBytes: number, allow: (req: Request) => boolean) => (req: Request, _res: Response, next: NextFunction) => {
    const total = Number(req.headers['content-length']) || 0
    if (total < minBytes || !allow(req)) return next()
    const key = `${prefix}:${randomToken(6)}`
    let got = 0
    watchBody(req, (n) => {
      got += n
      activity.update(key, got, total)
    })
    const done = () => activity.end(key)
    req.once('end', done)
    req.once('close', done)
    next()
  }

  // ---------- pages ----------

  app.get('/', (_req, res) => res.redirect('/s/'))

  // Chemin de connexion : un téléphone a ouvert la page (QR scanné). Compté
  // ici, par le PC, jamais par le téléphone ; la page elle-même, pas ses
  // fichiers. Une page ouverte sur le PC lui-même n'est pas un téléphone.
  // Seulement quand un QR attend d'être scanné : un téléphone déjà appairé qui
  // rouvre son icône ou recharge la page n'est pas compté.
  const pairingShown = () => {
    const now = Date.now()
    return devices.listPublic().some((d) => d.status === 'pending' && now - Date.parse(d.createdAt) <= PENDING_PAIRING_TTL_MS)
  }
  app.use('/s', (req, _res, next) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html') && !isLoopback(req.socket.remoteAddress)) {
      // un téléphone joint le PC : le pare-feu ne le bloque pas sur ce réseau
      firewallReached()
      if (pairingShown()) {
        const ua = req.headers['user-agent']
        if (pairView) pairView.scanned = true
      }
    }
    next()
  })

  // Page et manifeste du téléphone portent le nom du PC : « Flitdrop · TOUR ».
  // Deux PC donnent deux icônes distinctes sur l'écran d'accueil (le nom est
  // lu au moment où on ajoute l'icône). Fichiers lus une fois, nom inséré à
  // chaque demande (il peut changer dans les réglages).
  const phoneFiles = new Map<string, string>()
  const phoneFile = (name: string): string | undefined => {
    let v = phoneFiles.get(name)
    if (v === undefined) {
      try {
        v = fs.readFileSync(path.join(PUBLIC_DIR, 'phone', name), 'utf8')
      } catch {
        return undefined
      }
      phoneFiles.set(name, v)
    }
    return v
  }
  app.get(['/s/', '/s/index.html'], (req, res, next) => {
    // « /s » sans barre finale : laissé au serveur de fichiers, qui redirige
    // vers « /s/ » (sinon les adresses relatives de la page seraient fausses)
    if (!req.path.endsWith('/') && !req.path.endsWith('/index.html')) return next()
    const html = phoneFile('index.html')
    if (!html) return next()
    res.setHeader('Cache-Control', 'no-store')
    res.type('html').send(phonePageHtml(html, cfg.deviceName))
  })
  app.get('/s/manifest.webmanifest', (_req, res, next) => {
    const raw = phoneFile('manifest.webmanifest')
    if (!raw) return next()
    let body: string
    try {
      body = phoneManifest(raw, cfg.deviceName)
    } catch {
      return next()
    }
    res.setHeader('Cache-Control', 'no-store')
    res.type('application/manifest+json').send(body)
  })

  app.use(
    '/s',
    express.static(path.join(PUBLIC_DIR, 'phone'), {
      index: 'index.html',
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  )

  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '7d' }))

  const desktopGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).send(st(req, 'srv.loopbackOnly'))
    if (!adminOk(req)) return res.status(401).send(st(req, 'srv.adminBadLink'))
    if (typeof req.query.k === 'string' && req.query.k.length > 0) {
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(cfg.adminToken)}; HttpOnly; SameSite=Strict; Path=/`)
    }
    next()
  }
  app.use(
    '/app',
    desktopGuard,
    express.static(path.join(PUBLIC_DIR, 'desktop'), {
      index: 'index.html',
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  )

  // ---------- API téléphone (enveloppes chiffrées) ----------

  const jsonSmall = express.json({ limit: '256kb' })
  // texte en clair borné à MAX_TEXT_BYTES (1 Mo) ; +chiffrement +base64 +JSON => ~2 Mo
  const jsonText = express.json({ limit: '2mb' })

  // Garde montée AVANT tout body-parser : on refuse un appareil inconnu et on
  // limite le débit sans jamais bufferiser le corps d'un attaquant non appairé.
  const phoneRate = rateLimit(240, 60_000)
  // Les requêtes de transfert d'un téléphone appairé (début, morceaux, statut,
  // fin, téléchargement) ont leur propre budget, par appareil et bien plus
  // large : une vidéo à pleine vitesse du wifi ou un lot de 100 photos en font
  // des centaines par minute. Chaque morceau est de toute façon authentifié
  // (déchiffrement refusé s'il est forgé). Tout le reste, et surtout les
  // appareils inconnus, garde la limite stricte par adresse.
  // Clé = appareil ET adresse : l'identifiant circule en clair sur le wifi,
  // quelqu'un qui l'a vu passer ne remplit que son propre compteur, jamais
  // celui du vrai téléphone.
  const transferRate = rateLimit(
    TRANSFER_RATE_PER_MIN,
    60_000,
    (req) => `dev:${String(req.headers['x-wd-device'] ?? '')}|${req.socket.remoteAddress ?? '?'}`
  )
  app.use('/api/phone', (req, res, next) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    const dev = id ? devices.get(id) : undefined
    if (dev && dev.status === 'active' && PHONE_TRANSFER_ROUTE.test(req.path)) return transferRate(req, res, next)
    return phoneRate(req, res, next)
  })
  app.use('/api/phone', (req, res, next) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    const dev = id ? devices.get(id) : undefined
    if (!dev) {
      // QR scanné après son expiration : le téléphone dit « code expiré,
      // rescanne le nouveau code » au lieu de « téléphone retiré »
      const gone = id ? expiredPairings.get(id) : undefined
      if (gone) {
        if (!gone.reported) {
          gone.reported = true
        }
        return res.status(403).json({ code: 'pairingExpired' })
      }
      return res.status(403).json({ code: 'deviceUnknown' })
    }
    // liaison au PC : un appairage créé sur une autre machine (instanceId
    // différent) est refusé, même s'il se présente sur le même wifi.
    if (dev.instanceId && dev.instanceId !== cfg.instanceId)
      return res.status(409).json({ code: 'wrongPc' })
    // QR scanné mais pas encore de hello : rien d'autre que le hello. Sans
    // cela, une photo du QR (ou une page modifiée qui saute le hello) lirait
    // ce qui attend le premier téléphone. La page du téléphone, anciennes
    // versions comprises, commence toujours par le hello.
    if (dev.status !== 'active' && req.path !== '/hello') return res.status(403).json({ code: 'authRefused' })
    next()
  })

  app.post('/api/phone/hello', jsonSmall, phoneAuth('hello'), (req, res) => {
    const { dev, key, payload } = wd(req)
    const wasPending = devices.activate(dev.id, {
      name: typeof payload.deviceLabel === 'string' ? payload.deviceLabel : undefined,
      platform: typeof payload.platform === 'string' ? payload.platform : undefined,
    })
    // Au TOUT PREMIER hello on démarre une rotation « make-before-break » : une
    // clé de session est générée EN ATTENTE (l'ancienne reste valide) et renvoyée
    // chiffrée sous l'ancienne (`key`, que le téléphone possède). On la re-renvoie
    // à chaque hello tant qu'elle n'est pas confirmée : ainsi une réponse perdue
    // ne bloque jamais le téléphone, et une photo du QR cesse de valoir dès que le
    // vrai téléphone confirme (1re requête sous la nouvelle clé -> promotion).
    if (wasPending) devices.beginRotation(dev.id)
    // un téléphone de plus : ce qui attendait « tous » reste aux téléphones
    // déjà appairés, le nouveau ne voit pas ce qui a été envoyé avant lui.
    // Le même téléphone rescanné, lui, retrouve ce qui attendait son ancien
    // appairage (même système, même nom).
    if (wasPending) {
      const twins = devices.twinIds(dev.id)
      if (twins.length > 0) outbox.shareTargets(twins, dev.id)
      else {
        const others = activePhones().filter((d) => d.id !== dev.id).map((d) => d.id)
        if (others.length > 0) outbox.restrictUntargeted(others)
      }
    }
    const rotatedKey = devices.pendingKey(dev.id)
    const fresh = devices.get(dev.id)
    if (wasPending) hub.broadcast('device-paired', { id: dev.id, name: fresh?.name, platform: fresh?.platform })
    else hub.broadcast('device-online', { id: dev.id, name: fresh?.name })
    // compté côté serveur : une seule fois par appairage, même avec plusieurs onglets
    // scanné depuis la fenêtre d'appairage ouverte (premier code ou renouvelé)
    if (wasPending && pairView?.ids.has(dev.id)) {
      pairView.scanned = true
      reportQrShown(false)
    }
    res.json({
      p: sealJSON(
        key,
        {
          desktopName: cfg.deviceName,
          maxFileMB: cfg.maxFileMB,
          chunkSize: CHUNK_SIZE,
          requireApproval: cfg.requireApproval,
          product: PRODUCT_NAME,
          version: VERSION,
          // identité de CE PC : le téléphone l'épingle et refuse de dialoguer
          // avec un autre PC qui répondrait à la même adresse (wifi partagé).
          instanceId: cfg.instanceId,
          // clé de session (présente seulement au 1er hello) : le téléphone
          // remplace la clé du QR par celle-ci pour la suite.
          newKey: rotatedKey,
          // adresses de secours : si l'IP du PC change, la page sait où le
          // retrouver sans re-scanner le QR code.
          hosts: [
            ...localIPv4s().map((ip) => `${ip}:${actualPort}`),
            `${os.hostname().split('.')[0]}.local:${actualPort}`,
          ],
          features: PHONE_FEATURES,
        },
        aad(dev.id, 'hello:res')
      ),
    })
  })

  app.post('/api/phone/transfer/init', jsonSmall, phoneAuth('init'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    try {
      const t = await transfers.init(dev, payload.meta as never)
      res.json({ p: sealJSON(key, { transferId: t.id }, aad(dev.id, 'init:res')) })
    } catch (e) {
      const err = e as ApiError
      const meta = payload.meta as { mime?: unknown } | undefined
      res.status(httpStatus(err.code)).json({ code: err.key ?? 'internal' })
    }
  })

  app.post(
    '/api/phone/transfer/:tid/chunk/:n',
    // l'appareil est déjà vérifié par la garde montée sur /api/phone (avant tout
    // buffering) : on ne lit pas 8 Mo pour un inconnu. On vérifie aussi le
    // transfert et l'indice AVANT de lire le corps : un morceau pour un
    // transfert qui n'existe pas ne coûte rien.
    (req, res, next) => {
      const dev = devices.get(String(req.headers['x-wd-device'] ?? ''))
      const t = transfers.get(String(req.params.tid))
      if (!dev || !t || t.deviceId !== dev.id) return res.status(404).json({ code: 'transferNotFound' })
      const n = Number(req.params.n)
      if (!Number.isInteger(n) || n < 0 || n >= t.chunks) return res.status(400).json({ code: 'badIndex' })
      // un morceau de 8 Mo peut mettre longtemps sur un wifi lent : chaque
      // paquet reçu prolonge l'activité, pas seulement le morceau complet.
      // Seulement une fois un premier morceau accepté (déchiffré) : un corps
      // forgé avec l'identifiant vu passer en clair ne réveille pas le PC.
      // Les octets en route font aussi avancer la barre et la vitesse du PC
      // (sinon elles ne bougeaient qu'à chaque morceau de 8 Mo complet), avec
      // la même règle : seulement depuis une adresse dont un morceau de ce
      // transfert a déjà été déchiffré, et jamais pour un morceau déjà reçu.
      // Un corps forgé par un autre appareil du wifi ne fait rien bouger.
      const from = req.socket.remoteAddress ?? ''
      const counts = !t.have.has(n) && !!t.trustedFrom?.has(from)
      let inflight = 0
      watchBody(req, (bytes) => {
        activity.keep(`up:${t.id}`)
        if (counts) inflight += transfers.noteInflight(t, bytes)
      })
      const release = () => {
        if (inflight > 0) transfers.noteInflight(t, -inflight)
        inflight = 0
      }
      ;(req as Request & { wdRelease?: () => void }).wdRelease = release
      res.once('close', release)
      next()
    },
    express.raw({ type: () => true, limit: MAX_CHUNK_BODY }),
    async (req, res) => {
      const id = String(req.headers['x-wd-device'] ?? '')
      const dev = id ? devices.get(id) : undefined
      if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
      const t = transfers.get(String(req.params.tid))
      if (!t || t.deviceId !== dev.id) return res.status(404).json({ code: 'transferNotFound' })
      const n = Number(req.params.n)
      if (!Number.isInteger(n) || n < 0 || n >= t.chunks) return res.status(400).json({ code: 'badIndex' })
      // ré-émission d'un chunk déjà écrit (reprise / envoi parallèle) : ack idempotent
      if (t.have.has(n)) return res.json({ received: t.received })
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ code: 'missingBody' })
      // même déchiffrement double-clé que phoneAuth (fenêtre de rotation).
      // req.body (Buffer) EST déjà un Uint8Array : pas de copie inutile de 8 Mo.
      let plain: Uint8Array | undefined
      for (const cand of devices.candidateKeys(dev.id)) {
        try {
          plain = open(cand.key, req.body, aad(dev.id, 'chunk', `${t.id}|${n}`))
          if (cand.pending) devices.promoteKey(dev.id)
          break
        } catch {
          // clé suivante
        }
      }
      const release = (req as Request & { wdRelease?: () => void }).wdRelease ?? (() => {})
      if (!plain) {
        release()
        // le téléphone abandonnera : si le transfert expire ensuite, c'est la raison
        t.lastErrorKey = 'badChunk'
        t.lastErrorStatus = 403
        return res.status(403).json({ code: 'badChunk' })
      }
      // morceau authentique : les octets en route depuis cette adresse
      // comptent désormais dans la progression du PC
      ;(t.trustedFrom ??= new Set()).add(req.socket.remoteAddress ?? '')
      try {
        // octets en route retirés au moment même où le morceau compte dans
        // t.bytes : la barre du PC ne recule pas entre les deux
        await transfers.writeChunk(t, n, plain, release)
        release()
        res.json({ received: t.received })
      } catch (e) {
        release()
        const err = e as ApiError
        t.lastErrorKey = err.key ?? 'internal'
        t.lastErrorStatus = httpStatus(err.code)
        res.status(httpStatus(err.code)).json({ error: err.message })
      }
    }
  )

  // Statut d'un transfert : le téléphone interroge « combien de morceaux
  // as-tu reçus ? » pour reprendre exactement là où la coupure a eu lieu,
  // au lieu de renvoyer tout le fichier.
  app.get('/api/phone/transfer/:tid/status', (req, res) => {
    const id = String(req.headers['x-wd-device'] ?? '')
    const dev = id ? devices.get(id) : undefined
    if (!dev) return res.status(403).json({ code: 'deviceUnknown' })
    const t = transfers.get(String(req.params.tid))
    if (!t || t.deviceId !== dev.id) return res.status(404).json({ code: 'transferNotFound' })
    // `have` = indices déjà reçus : le téléphone reprend en ne renvoyant QUE ce
    // qui manque (envoi parallèle, reprise après coupure), à l'octet près.
    res.json({ received: t.received, chunks: t.chunks, bytes: t.bytes, size: t.size, have: [...t.have] })
  })

  app.post('/api/phone/transfer/:tid/finish', jsonSmall, phoneAuth('finish'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const t = transfers.get(String(req.params.tid))
    if (!t || t.deviceId !== dev.id || payload.transferId !== t.id)
      return res.status(404).json({ code: 'transferNotFound' })
    try {
      const finalPath = await transfers.finish(t)
      devices.touch(dev.id)
      transferOk()
      res.json({ p: sealJSON(key, { ok: true, name: path.basename(finalPath) }, aad(dev.id, 'finish:res')) })
    } catch (e) {
      const err = e as ApiError
      transfers.reportFailure(t, httpStatus(err.code), err.key ?? 'internal')
      res.status(httpStatus(err.code)).json({ code: err.key ?? 'internal' })
    }
  })

  app.post('/api/phone/text', jsonText, phoneAuth('text'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    // texte long : compté comme un transfert, une fois l'envoi vérifié
    // (le corps est déjà arrivé, un seul signe suffit)
    const bodyBytes = Number(req.headers['content-length']) || 0
    if (bodyBytes >= LARGE_TEXT_BYTES) {
      const actKey = `txt:${randomToken(6)}`
      activity.update(actKey, bodyBytes, bodyBytes)
      activity.end(actKey)
    }
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
      return res.status(400).json({ code: 'textEmpty' })
    const mode = payload.mode === 'message' ? 'message' : 'clip'
    let copied = false
    if (mode === 'clip') {
      copied = await clip.write(text).then(
        () => true,
        () => false
      )
      // anti-écho : ce texte vient du téléphone, le surveilleur ne doit pas le renvoyer
      if (copied) lastClip = text
    }
    if (cfg.clipHistoryEnabled && clipHistory.add(text, dev.name, cfg)) {
      hub.broadcast('cliphistory-changed', {})
    }
    history.add({
      dir: 'in',
      kind: mode === 'clip' ? 'clip' : 'text',
      preview: text.slice(0, 160),
      deviceId: dev.id,
      deviceName: dev.name,
      status: 'ok',
    })
    hub.broadcast('text-received', {
      deviceName: dev.name,
      mode,
      copied,
      text: text.length <= 32_000 ? text : text.slice(0, 32_000),
    })
    devices.touch(dev.id)
    transferOk()
    res.json({ p: sealJSON(key, { ok: true, copied }, aad(dev.id, 'text:res')) })
  })

  // Listes que le téléphone relit toutes les 5 à 6 s : une étiquette de
  // version (propre à ce lancement du serveur, pour qu'un redémarrage ne soit
  // jamais pris pour « rien de neuf »). Le téléphone renvoie celle qu'il a
  // (`since`) ; si rien n'a changé, la réponse tient en quelques octets et le
  // téléphone garde sa liste. Une ancienne page sans `since` reçoit toujours
  // la liste complète.
  const bootTag = randomToken(4)
  // réglages qui changent le contenu de ces listes (nom du PC, historique
  // activé ou non, plan) : settingsGen, déclaré plus haut ; on ne suit pas
  // le détail, tout enregistrement compte
  const outboxTag = () => `${bootTag}.${outbox.version}.${settingsGen}`
  const clipTag = () => `${bootTag}.${clipHistory.version}.${settingsGen}`

  app.post('/api/phone/outbox', jsonSmall, phoneAuth('outbox'), (req, res) => {
    const { dev, key, payload } = wd(req)
    devices.touch(dev.id)
    // un texte de la file est « reçu » dès que ce téléphone l'a en main (il
    // s'affiche tel quel) : compté une fois par texte et par téléphone.
    for (const item of outbox.listRaw()) {
      if (item.kind !== 'text' || !outbox.visibleTo(item, dev.id) || textDelivered.has(`${item.id}|${dev.id}`)) continue
      if (textDelivered.size > 2000) textDelivered.clear()
      textDelivered.add(`${item.id}|${dev.id}`)
      transferOk()
    }
    const v = outboxTag()
    const body: Record<string, unknown> =
      payload.since === v ? { unchanged: true, v } : { desktopName: cfg.deviceName, items: outbox.listForPhone(dev.id), v }
    // limite du jour (gratuit seulement) : le téléphone reprend tout seul ce
    // qui attend dès qu'elle se rouvre (Pro débloqué, lendemain)
    res.json({ p: sealJSON(key, body, aad(dev.id, 'outbox:res')) })
  })

  // Historique du presse-papiers du PC, servi (chiffré) au téléphone appairé :
  // c'est ce qui fait la vraie synchro. La liaison instanceId garantit que seuls
  // TES appareils voient TON presse-papiers, et seulement ceux pour lesquels
  // le partage est activé sur le PC (`shared`). Les miniatures suffisent à
  // l'aperçu ; le chemin disque n'est jamais exposé (clipHistory.list le retire).
  app.post('/api/phone/cliphistory', jsonSmall, phoneAuth('cliphistory'), (req, res) => {
    const { dev, key, payload } = wd(req)
    devices.touch(dev.id)
    const v = clipTag()
    const shared = devices.clipShared(dev.id)
    const on = cfg.clipHistoryEnabled && shared
    // `enabled` faux pour un téléphone sans partage : une page plus ancienne
    // affiche alors une liste vide, jamais l'historique
    const body = payload.since === v ? { unchanged: true, v } : { enabled: on, shared, items: on ? clipView().slice(0, 200) : [], v }
    res.json({ p: sealJSON(key, body, aad(dev.id, 'cliphistory:res')) })
  })

  // Envoie une entrée d'historique vers le téléphone (texte -> presse-papiers du
  // téléphone côté client ; image -> file d'attente pour la récupérer en fichier).
  app.post('/api/phone/cliphistory/:id/tophone', jsonSmall, phoneAuth('clip-tophone'), (req, res) => {
    const { dev, key, payload } = wd(req)
    if (!devices.clipShared(dev.id) || !cfg.clipHistoryEnabled) return res.status(403).json({ code: 'clipNotShared' })
    const entry = clipHistory.get(String(req.params.id))
    if (!entry || payload.entryId !== entry.id || !clipVisible(entry.id)) return res.status(404).json({ code: 'entryNotFound' })
    if (entry.kind === 'image' && entry.image) {
      const reserved = reserveUniquePath(outbox.dir, `image-${entry.id}.png`)
      fs.closeSync(reserved.fd)
      try {
        fs.copyFileSync(entry.image.path, reserved.path)
      } catch {
        return res.status(410).json({ code: 'imageGone' })
      }
      const st = fs.statSync(reserved.path)
      // demandée par CE téléphone : lui seul la voit
      outbox.addFile(path.basename(reserved.path), reserved.path, st.size, 'image/png', [dev.id])
      hub.broadcast('outbox-changed', {})
    } else {
      // le texte part dans la réponse et le téléphone le copie aussitôt
      transferOk()
    }
    res.json({ p: sealJSON(key, { ok: true, kind: entry.kind }, aad(dev.id, 'clip-tophone:res')) })
  })

  app.post('/api/phone/outbox/:id/download', jsonSmall, phoneAuth('download'), async (req, res) => {
    const { dev, key, payload } = wd(req)
    const item = outbox.get(String(req.params.id))
    const dlFail = (status: number, code: string) => {
      return res.status(status).json({ code })
    }
    // un élément destiné à un autre téléphone répond comme un élément absent
    if (!item || payload.itemId !== item.id || !outbox.visibleTo(item, dev.id)) return dlFail(404, 'itemNotFound')
    if (item.kind !== 'file' || !item.filePath) return dlFail(400, 'notAFile')
    // createReadStream ne lève rien pour un fichier absent (l'erreur arrive
    // pendant la lecture) : on vérifie avant d'envoyer le moindre octet
    try {
      if (!(await fs.promises.stat(item.filePath)).isFile()) return dlFail(410, 'fileGone')
    } catch {
      return dlFail(410, 'fileGone')
    }
    const dlKey = `${item.id}|${dev.id}`
    const stream = fs.createReadStream(item.filePath, { highWaterMark: 4 * 1024 * 1024 })
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    // si le client se déconnecte (téléphone qui quitte le wifi, onglet fermé),
    // on détruit le flux disque immédiatement : sinon fuite de descripteur.
    let aborted = false
    const onClose = () => {
      aborted = true
      stream.destroy()
    }
    res.once('close', onClose)
    let index = 0
    // clé propre à CE téléchargement : deux téléphones (ou deux essais) du même
    // fichier ont chacun leur progression
    const actKey = `dl:${randomToken(6)}`
    let sentBytes = 0
    let lastPush = 0
    let completed = false
    try {
      for await (const chunk of stream) {
        if (aborted || res.writableEnded) break
        sentBytes += (chunk as Buffer).length
        activity.update(actKey, sentBytes, item.size ?? 0)
        // progression et vitesse sur la page du PC, 2 fois par seconde au plus
        const now = Date.now()
        if (now - lastPush > 500) {
          lastPush = now
          hub.broadcast('outbox-progress', { itemId: item.id, bytes: sentBytes, size: item.size ?? 0, deviceName: dev.name })
        }
        const sealed = seal(key, chunk as Buffer, aad(dev.id, 'dl', `${item.id}|${index}`))
        const len = Buffer.alloc(4)
        len.writeUInt32BE(sealed.length, 0)
        // deux écritures (entête + charge) : évite un Buffer.concat/copie par frame
        res.write(len)
        const okWrite = res.write(sealed)
        if (!okWrite) {
          // attendre le drain, mais débloquer si la connexion se ferme
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done)
              res.off('close', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
          })
        }
        index++
      }
      if (aborted) return
      res.end()
      outbox.markDownloaded(item.id, dev.id)
      history.add({
        dir: 'out',
        kind: 'file',
        name: item.name,
        size: item.size,
        deviceId: dev.id,
        deviceName: dev.name,
        status: 'ok',
      })
      completed = true
      hub.broadcast('outbox-downloaded', { itemId: item.id, name: item.name, deviceName: dev.name })
    } catch {
      // lecture du disque impossible en cours de route
      if (!res.writableEnded) res.destroy()
    } finally {
      res.off('close', onClose)
      stream.destroy()
      activity.end(actKey)
      // téléchargement interrompu (téléphone parti, page fermée, morceau
      // refusé) : la page du PC retire sa ligne « Vers iPhone : 42 % »
      if (!completed && lastPush > 0) hub.broadcast('outbox-progress', { itemId: item.id, ended: true })
    }
  })

  // ---------- test de vitesse (« Tester la vitesse » sur le téléphone) ----------
  // Le réseau seul, sans disque ni fichier : des octets aléatoires (rien à
  // cacher, donc envoyés tels quels) vers et depuis un téléphone appairé, dont
  // chaque requête porte une enveloppe authentifiée. Tailles bornées.
  let noise: Buffer | null = null
  app.post('/api/phone/speedtest/down', jsonSmall, phoneAuth('speedtest-down'), (req, res) => {
    const want = Math.floor(Number(wd(req).payload.bytes))
    const total = Number.isFinite(want) ? Math.min(SPEEDTEST_DOWN_MAX, Math.max(1024 * 1024, want)) : 16 * 1024 * 1024
    noise ??= randomBytes(1024 * 1024)
    const block = noise
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', String(total))
    let sent = 0
    let closed = false
    res.once('close', () => (closed = true))
    const pump = () => {
      while (!closed && sent < total) {
        const n = Math.min(block.length, total - sent)
        sent += n
        if (!res.write(n === block.length ? block : block.subarray(0, n))) return void res.once('drain', pump)
      }
      if (!closed) res.end()
    }
    pump()
  })

  // envoi : l'enveloppe voyage dans l'en-tête x-wd-auth, vérifiée AVANT de
  // lire le corps ; le corps est compté puis jeté
  app.post('/api/phone/speedtest/up', (req, res) => {
    const dev = devices.get(String(req.headers['x-wd-device'] ?? ''))
    const envelope = String(req.headers['x-wd-auth'] ?? '')
    if (!dev || !envelope) return res.status(403).json({ code: 'authRefused' })
    let payload: Record<string, unknown> | undefined
    for (const cand of devices.candidateKeys(dev.id)) {
      try {
        payload = openFreshJSON<Record<string, unknown>>(cand.key, envelope, aad(dev.id, 'speedtest-up'), nonces)
        break
      } catch {
        // clé suivante
      }
    }
    if (!payload) return res.status(403).json({ code: 'authRefused' })
    const len = Number(req.headers['content-length'])
    if (!Number.isInteger(len) || len <= 0 || len > SPEEDTEST_UP_MAX || payload.bytes !== len)
      return res.status(400).json({ code: 'badRequest' })
    let got = 0
    req.on('data', (c: Buffer) => {
      got += c.length
      if (got > len) req.destroy()
    })
    req.on('end', () => res.json({ received: got }))
  })

  // comment le PC est relié (wifi 2,4/5/6 GHz, débit, signal, ou câble) : lu
  // une fois, à la demande, pour les conseils du test de vitesse
  app.post('/api/phone/speedtest/pc', jsonSmall, phoneAuth('speedtest-pc'), async (req, res) => {
    const { dev, key } = wd(req)
    const read = opts.pcLink ?? pcLink
    const link = await read(req.socket.localAddress).catch((): PcLink => ({ via: 'unknown' }))
    res.json({ p: sealJSON(key, { link }, aad(dev.id, 'speedtest-pc:res')) })
  })

  // Совместимость со страницей телефона: отчёты принимаются и отбрасываются.
  // Ничего не сохраняется и никуда не отправляется.
  app.post('/api/phone/report', jsonSmall, phoneAuth('report'), (req, res) => {
    const { dev, key } = wd(req)
    res.json({ p: sealJSON(key, { ok: true }, aad(dev.id, 'report:res')) })
  })

  // ---------- API Raccourci iOS (jeton simple, voir docs/raccourci-ios.md) ----------

  const rlShortcut = rateLimit(60, 60_000)

  // Le partage par Raccourci est pratique mais NON chiffré (jeton et contenu en
  // clair sur le réseau). On peut le couper : sur un wifi public non fiable, ou
  // si on n'utilise pas cette fonctionnalité.
  app.use('/api/shortcut', (req, res, next) => {
    if (!cfg.shortcutsEnabled)
      return res.status(403).type('text/plain; charset=utf-8').send(st(req, 'srv.shortcutOff'))
    next()
  })

  const shortcutDevice = (req: Request): Device | undefined => {
    const token = String(req.query.t ?? '')
    if (token.length < 10) return undefined
    const dev = devices.byShortcutToken(token)
    // même liaison que l'API téléphone : un token lié à un autre PC est ignoré.
    if (dev && dev.instanceId && dev.instanceId !== cfg.instanceId) return undefined
    return dev
  }

  app.post('/api/shortcut/upload', rlShortcut, trackBody('sc', 0, (req) => !!shortcutDevice(req)), async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    // limite du jour (gratuit) : rien de possible, refusé avant de lire le
    // moindre octet
    // « Valider chaque fichier » allumé : le Raccourci ne peut pas attendre
    // une validation, il ne contourne donc pas ce réglage
    if (cfg.requireApproval) return res.status(403).type('text/plain; charset=utf-8').send(st(req, 'srv.scApproval', { pc: cfg.deviceName }))
    fs.mkdirSync(cfg.downloadDir, { recursive: true })
    try {
      const all = await saveMultipartFiles(req, cfg.downloadDir, cfg.maxFileMB * 1024 * 1024)
      if (all.length === 0) {
        return res.status(400).type('text/plain; charset=utf-8').send(st(req, 'srv.scNoFile'))
      }
      const saved = all.map(placeByMonth)
      await Promise.all(saved.map((f) => markFromOutside(f.path)))
      for (const f of saved) {
        transferOk()
        history.add({
          dir: 'in',
          kind: 'file',
          name: f.name,
          size: f.size,
          deviceId: dev.id,
          deviceName: dev.name,
          status: 'ok',
          path: f.path,
        })
        hub.broadcast('transfer-done', { id: randomToken(6), name: f.name, size: f.size, path: f.path, deviceName: dev.name })
      }
      devices.touch(dev.id)
      const total = saved.length
      const arrived = total === 1 ? st(req, 'srv.scArrivedOne', { name: saved[0]?.name ?? '', pc: cfg.deviceName }) : st(req, 'srv.scArrivedMany', { n: total, pc: cfg.deviceName })
      res.setHeader('x-flitdrop-kept', String(total))
      res.type('text/plain; charset=utf-8').send(arrived)
    } catch (e) {
      const err = e as Error & { code?: number }
      res.status(err.code === 413 ? 413 : 400).type('text/plain; charset=utf-8').send(
        err.code === 413 ? st(req, 'srv.scTooBig', { mb: cfg.maxFileMB }) : st(req, 'srv.scFailed')
      )
    }
  })

  // jeton vérifié AVANT de lire le corps : sans lui, n'importe qui sur le
  // réseau faisait garder 1 Mo en mémoire par requête
  const shortcutAuthFirst = (req: Request, res: Response, next: NextFunction) => {
    if (!shortcutDevice(req)) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    next()
  }
  app.post('/api/shortcut/text', rlShortcut, shortcutAuthFirst, trackBody('sctxt', LARGE_TEXT_BYTES, (req) => !!shortcutDevice(req)), express.text({ limit: '1mb', type: () => true }), async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text) return res.status(400).type('text/plain; charset=utf-8').send(st(req, 'srv.scNothing'))
    const copied = await clip.write(text).then(
      () => true,
      () => false
    )
    // comme depuis la page du téléphone : pas renvoyé aux téléphones comme une
    // copie faite sur le PC, et noté au nom de l'iPhone
    if (copied) lastClip = text
    if (cfg.clipHistoryEnabled && clipHistory.add(text, dev.name, cfg)) hub.broadcast('cliphistory-changed', {})
    history.add({ dir: 'in', kind: 'clip', preview: text.slice(0, 160), deviceId: dev.id, deviceName: dev.name, status: 'ok' })
    hub.broadcast('text-received', { deviceName: dev.name, mode: 'clip', copied, text: text.slice(0, 32_000) })
    devices.touch(dev.id)
    transferOk()
    res.type('text/plain; charset=utf-8').send(st(req, 'srv.scCopied', { pc: cfg.deviceName }))
  })

  app.get('/api/shortcut/clipboard', rlShortcut, async (req, res) => {
    const dev = shortcutDevice(req)
    if (!dev) return res.status(401).type('text/plain; charset=utf-8').send(st(req, 'srv.scBadToken'))
    // même règle que l'historique : seulement un téléphone qui voit le
    // presse-papiers du PC
    if (!devices.clipShared(dev.id)) return res.status(403).type('text/plain; charset=utf-8').send(st(req, 'srv.scClipOff', { pc: cfg.deviceName }))
    // mot de passe marqué par un gestionnaire : rien ne part, rien n'est noté
    if (concealed()) return res.type('text/plain; charset=utf-8').send('')
    const text = await clip.read().catch(() => '')
    history.add({ dir: 'out', kind: 'clip', preview: text.slice(0, 160), deviceId: dev.id, deviceName: dev.name, status: 'ok' })
    devices.touch(dev.id)
    if (text) transferOk()
    res.type('text/plain; charset=utf-8').send(text)
  })

  // ---------- API admin (interface du PC, loopback uniquement) ----------

  const admin = express.Router()
  admin.use((req, res, next) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ code: 'localOnly' })
    // une page d'un autre site local (127.0.0.1 sur un autre port, ou un nom
    // qui pointe ici) ne peut rien demander : seule la page de Flitdrop
    if (!sameSiteOk(req.headers)) return res.status(403).json({ code: 'localOnly' })
    if (!adminOk(req)) return res.status(401).json({ code: 'unauthorized' })
    next()
  })

  let actualPort = wantedPort
  const bestIp = () => localIPv4s()[0]
  // la clé et l'instanceId voyagent dans le FRAGMENT (#), jamais envoyé au réseau
  const pairUrl = (d: Device) => `http://${bestIp() ?? '127.0.0.1'}:${actualPort}/s/#${d.id}.${d.keyB64}.${cfg.instanceId}`

  // état du système signalé par l'app de bureau (vide en CLI et en tests)
  const host: HostState = { macUpdate: null, loginItemNeedsApproval: false }
  const setAutostart = (on: boolean): boolean => {
    if (!opts.autostart) return false
    cfg.autostartAsked = true
    try {
      saveConfig(home, cfg)
    } catch {
      // non critique : la question reviendrait au prochain lancement
    }
    try {
      opts.autostart.set(on)
    } catch {
      // l'état réel est relu juste après
    }
    autostartOn = readAutostart()
    hub.broadcast('host-changed', {})
    return true
  }

  const setHost = (patch: HostPatch): void => {
    let changed = false
    if (patch.macUpdate !== undefined || patch.revealMacUpdate) {
      const src = patch.macUpdate !== undefined ? patch.macUpdate : host.macUpdate
      let v: HostState['macUpdate'] = src && typeof src.version === 'string' ? { version: src.version.slice(0, 40) } : null
      if (v) {
        // même version : on garde le compteur ; vérification à la main : +1
        const reveal = host.macUpdate?.version === v.version ? (host.macUpdate.reveal ?? 0) : 0
        const next = patch.revealMacUpdate ? reveal + 1 : reveal
        if (next > 0) v = { ...v, reveal: next }
      }
      if (JSON.stringify(v) !== JSON.stringify(host.macUpdate)) {
        host.macUpdate = v
        changed = true
      }
    }
    if (typeof patch.loginItemNeedsApproval === 'boolean' && patch.loginItemNeedsApproval !== host.loginItemNeedsApproval) {
      host.loginItemNeedsApproval = patch.loginItemNeedsApproval
      changed = true
    }
    if (changed) hub.broadcast('host-changed', {})
  }

  admin.post('/host/action', jsonSmall, (req, res) => {
    const action = (req.body as { action?: unknown })?.action
    if (typeof action !== 'string' || !(HOST_ACTIONS as readonly string[]).includes(action)) return res.status(400).json({ code: 'internal' })
    if (!opts.onHostAction) return res.status(400).json({ code: 'internal' })
    try {
      opts.onHostAction(action as HostAction)
    } catch {
      return res.status(500).json({ code: 'internal' })
    }
    res.json({ ok: true })
  })

  admin.get('/state', (_req, res) => {
    res.json({
      product: PRODUCT_NAME,
      version: VERSION,
      config: {
        deviceName: cfg.deviceName,
        downloadDir: cfg.downloadDir,
        maxFileMB: cfg.maxFileMB,
        requireApproval: cfg.requireApproval,
        clipboardAutoPush: cfg.clipboardAutoPush,
        clipHistoryEnabled: cfg.clipHistoryEnabled,
        clipHistoryMaxItems: cfg.clipHistoryMaxItems,
        clipHistoryMaxDays: cfg.clipHistoryMaxDays,
        theme: cfg.theme,
        skin: cfg.skin,
        lang: cfg.lang,
        shortcutsEnabled: cfg.shortcutsEnabled,
        autostartAsked: cfg.autostartAsked,
        firstTransferDone: cfg.firstTransferDone,
        sortPhotosByMonth: cfg.sortPhotosByMonth,
        port: actualPort,
      },
      // destinataire proposé par défaut quand plusieurs téléphones sont appairés
      sendTo: defaultSendTo(),
      // lancement à l'ouverture de session : null hors app de bureau
      autostart: (autostartOn = readAutostart()),
      // pare-feu de Windows : null hors app de bureau sous Windows
      firewall: opts.firewall
        ? {
            checking: fw.checking,
            repairing: fw.repairing,
            problem: fw.status?.problem ?? null,
            network: fw.status?.network ?? null,
            // « Réparer » est-il utile, et la règle couvrira-t-elle aussi les
            // réseaux publics (la carte le dit avant le clic)
            blocker: fw.status?.blocker ?? null,
            noRule: fw.status?.noRule === true,
            publicToo: !!fw.status?.problem && (repairProfiles(fw.status) & 4) !== 0,
            repair: fw.repair,
            fixed: fw.fixed,
          }
        : null,
      hostname: os.hostname(),
      host,
      ips: localIPv4s(),
      devices: devices.listPublic(),
      history: history.list(),
      outbox: outbox.listAdmin(),
      clipHistory: clipView(),
      clipHidden: 0,
    })
  })

  // ---------- historique du presse-papiers ----------

  admin.post('/cliphistory/:id/copy', async (req, res) => {
    const entry = clipHistory.get(String(req.params.id))
    if (!entry || !clipVisible(entry.id)) return res.status(404).json({ code: 'entryNotFound' })
    if (entry.kind === 'image' && entry.image) {
      if (!opts.writeImageToClipboard) return res.status(400).json({ code: 'imgCopyUnavailable' })
      try {
        const png = fs.readFileSync(entry.image.path)
        opts.writeImageToClipboard(png)
        lastImageHash = imageHash(png)
      } catch {
        return res.status(410).json({ code: 'imageGone' })
      }
    } else {
      const ok = await clip.write(entry.text).then(
        () => true,
        () => false
      )
      if (!ok) return res.status(500).json({ code: 'clipWriteFailed' })
      lastClip = entry.text
    }
    clipHistory.bump(entry.id)
    hub.broadcast('cliphistory-changed', {})
    res.json({ ok: true })
  })

  admin.post('/cliphistory/:id/tophone', jsonSmall, (req, res) => {
    const entry = clipHistory.get(String(req.params.id))
    if (!entry || !clipVisible(entry.id)) return res.status(404).json({ code: 'entryNotFound' })
    const to = sendTargets((req.body as { to?: unknown } | undefined)?.to)
    if (to === null) return res.status(400).json({ code: 'deviceNotFound' })
    if (entry.kind === 'image' && entry.image) {
      const reserved = reserveUniquePath(outbox.dir, `image-${entry.id}.png`)
      fs.closeSync(reserved.fd)
      try {
        fs.copyFileSync(entry.image.path, reserved.path)
      } catch {
        return res.status(410).json({ code: 'imageGone' })
      }
      const st = fs.statSync(reserved.path)
      outbox.addFile(path.basename(reserved.path), reserved.path, st.size, 'image/png', to)
    } else {
      outbox.addText(entry.text, 'clipboard', to)
    }
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true })
  })

  admin.post('/cliphistory/:id/remove', (req, res) => {
    if (!clipVisible(String(req.params.id)) || !clipHistory.remove(String(req.params.id))) return res.status(404).json({ code: 'entryNotFound' })
    hub.broadcast('cliphistory-changed', {})
    res.json({ ok: true })
  })

  admin.post('/cliphistory/clear', (_req, res) => {
    clipHistory.clear()
    hub.broadcast('cliphistory-changed', {})
    res.json({ ok: true })
  })

  // « Réinitialiser ce PC » : oublie tous les appareils appairés, vide
  // l'historique du presse-papiers, la file d'envoi et l'historique des
  // transferts, puis fait tourner l'instanceId (invalide définitivement tout
  // appairage restant). Pratique quand on prête / revend la machine.
  admin.post('/reset', (_req, res) => {
    const removed = devices.clear()
    clipHistory.clear()
    outbox.clearAll()
    history.clear()
    cfg.instanceId = randomToken(12)
    saveConfig(home, cfg)
    hub.broadcast('device-revoked', { id: 'all' })
    hub.broadcast('cliphistory-changed', {})
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true, removed })
  })

  // Nouveau code d'appairage. `renew` : la fenêtre d'appairage, restée
  // ouverte et visible, remplace son code avant qu'il expire (l'ancien reste
  // valable jusqu'au bout de ses 3 minutes). `ttlMs` : durée de validité.
  admin.post('/pair/new', jsonSmall, (req, res) => {
    const renew = (req.body as { renew?: unknown } | undefined)?.renew === true
    prunePending()
    // un téléphone de plus va peut-être arriver : dès maintenant, ce qui
    // attend « tous » est réservé aux téléphones déjà appairés (le hello le
    // refait pour ce qui arrivera d'ici là)
    const already = activePhones().map((p) => p.id)
    if (already.length > 0) outbox.restrictUntargeted(already)
    const d = devices.create(cfg.instanceId)
    if (renew) {
      // renouvellement arrivé après la fermeture : un code de plus, sans
      // rouvrir de fenêtre dans les statistiques
      if (pairView) {
        pairView.ids.add(d.id)
        reportQrShown(true)
      }
    } else {
      // fenêtre précédente jamais refermée (page rechargée) : terminée ici
      closePairView()
      pairView = { ids: new Set([d.id]), qrSent: false, scanned: false, openedAt: Date.now(), fwAsked: false }
    }
    res.json({ deviceId: d.id, url: pairUrl(d), ttlMs: PENDING_PAIRING_TTL_MS })
  })

  // La fenêtre d'appairage est refermée (Fermer, Terminer).
  admin.post('/pair/close', (_req, res) => {
    closePairView()
    res.json({ ok: true })
  })

  // Lancement à l'ouverture de session : réponse de l'écran d'accueil ou
  // interrupteur des réglages.
  admin.post('/autostart', jsonSmall, (req, res) => {
    const on = (req.body as { enabled?: unknown } | undefined)?.enabled
    if (typeof on !== 'boolean' || !setAutostart(on)) return res.status(400).json({ code: 'internal' })
    res.json({ ok: true, enabled: autostartOn })
  })

  // Pare-feu de Windows. `auto` : demandé par la fenêtre d'appairage après
  // 45 s de QR visible ; accepté seulement si cette fenêtre est bien ouverte
  // depuis ce délai, qu'aucun téléphone n'a ouvert la page, une fois par
  // ouverture. Sans `auto` : « Vérifier à nouveau » dans la carte.
  admin.post('/firewall/check', jsonSmall, (req, res) => {
    if (!opts.firewall) return res.status(400).json({ code: 'internal' })
    const auto = (req.body as { auto?: unknown } | undefined)?.auto === true
    if (fw.checking || fw.repairing) return res.json({ ok: true, started: false })
    if (auto) {
      const now = Date.now()
      const after = opts.firewall.afterMs ?? FIREWALL_CHECK_AFTER_MS
      if (!pairView || pairView.scanned || pairView.fwAsked || now - pairView.openedAt < after) {
        return res.json({ ok: true, started: false })
      }
      pairView.fwAsked = true
      if (fw.lastAutoAt > 0 && now - fw.lastAutoAt < FIREWALL_AUTO_GAP_MS) return res.json({ ok: true, started: false })
      fw.lastAutoAt = now
    }
    void runFirewallCheck(auto ? 'auto' : 'again')
    res.json({ ok: true, started: true })
  })

  // « Réparer » : seulement sur un clic de la personne, et seulement quand la
  // dernière vérification a trouvé un blocage. Windows demande son accord.
  admin.post('/firewall/repair', (_req, res) => {
    // rien à réparer, ou rien qu'une règle puisse réparer (tout bloquer,
    // pare-feu géré par l'entreprise) : pas de demande des droits pour rien
    const status = fw.status
    if (!opts.firewall || !status?.problem || status.blocker) return res.status(400).json({ code: 'internal' })
    if (fw.checking || fw.repairing) return res.json({ ok: true, started: false })
    void runFirewallRepair(status)
    res.json({ ok: true, started: true })
  })


  admin.get('/pair/:id/qr.svg', async (req, res) => {
    const d = devices.get(String(req.params.id))
    if (!d || d.status !== 'pending') return res.status(404).json({ code: 'pairingNotFound' })
    const svg = await QRCode.toString(pairUrl(d), {
      type: 'svg',
      margin: 1,
      width: 560,
      errorCorrectionLevel: 'M',
      color: { dark: '#0d1220ff', light: '#ffffffff' },
    })
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-store')
    res.send(svg)
  })

  admin.post('/device/:id/rename', jsonSmall, (req, res) => {
    const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name : ''
    if (!name.trim()) return res.status(400).json({ code: 'emptyName' })
    if (!devices.rename(String(req.params.id), name.trim())) return res.status(404).json({ code: 'deviceNotFound' })
    res.json({ ok: true })
  })

  // Partage du presse-papiers du PC avec UN téléphone (historique, envoi
  // automatique, Raccourci). Appliqué par le serveur à chaque requête.
  admin.post('/device/:id/clipshare', jsonSmall, (req, res) => {
    const on = (req.body as { enabled?: unknown } | undefined)?.enabled
    if (typeof on !== 'boolean') return res.status(400).json({ code: 'internal' })
    if (!devices.setClipShare(String(req.params.id), on)) return res.status(404).json({ code: 'deviceNotFound' })
    // la liste du presse-papiers de ce téléphone est à relire
    settingsGen++
    hub.broadcast('settings-changed', {})
    res.json({ ok: true })
  })

  admin.post('/device/:id/revoke', (req, res) => {
    if (!devices.revoke(String(req.params.id))) return res.status(404).json({ code: 'deviceNotFound' })
    hub.broadcast('device-revoked', { id: String(req.params.id) })
    res.json({ ok: true })
  })

  admin.post('/outbox/text', jsonText, (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return res.status(400).json({ code: 'textEmpty' })
    const to = sendTargets((req.body as { to?: unknown }).to)
    if (to === null) return res.status(400).json({ code: 'deviceNotFound' })
    const item = outbox.addText(text, 'text', to)
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true, id: item.id })
  })

  admin.post('/outbox/file', async (req, res) => {
    // destinataire dans l'adresse (?to=) : le corps est le fichier lui-même
    const to = sendTargets(typeof req.query.to === 'string' ? req.query.to : undefined)
    if (to === null) return res.status(400).json({ code: 'deviceNotFound' })
    try {
      const saved = await saveMultipartFiles(req, outbox.dir, cfg.maxFileMB * 1024 * 1024)
      const items = saved.map((f) => outbox.addFile(f.name, f.path, f.size, f.mime, to))
      if (items.length > 0) hub.broadcast('outbox-changed', {})
      res.json({ ok: true, ids: items.map((i) => i.id) })
    } catch (e) {
      const err = e as Error & { code?: number }
      res.status(err.code === 413 ? 413 : 400).json({ code: err.code === 413 ? 'tooBig' : 'internal' })
    }
  })

  admin.post('/outbox/:id/remove', (req, res) => {
    if (!outbox.remove(String(req.params.id))) return res.status(404).json({ code: 'itemNotFound' })
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true })
  })

  admin.post('/clipboard/push', jsonSmall, async (req, res) => {
    const to = sendTargets((req.body as { to?: unknown } | undefined)?.to)
    if (to === null) return res.status(400).json({ code: 'deviceNotFound' })
    // un mot de passe marqué par un gestionnaire ne part jamais d'office : on
    // peut toujours le coller dans « Envoyer un texte » si on le veut vraiment
    if (concealed()) return res.status(400).json({ code: 'clipboardConcealed' })
    const text = await clip.read().catch(() => '')
    if (!text) return res.status(400).json({ code: 'clipboardEmpty' })
    const item = outbox.addText(text.slice(0, MAX_TEXT_BYTES), 'clipboard', to)
    hub.broadcast('outbox-changed', {})
    res.json({ ok: true, id: item.id, preview: text.slice(0, 120) })
  })

  admin.post('/open-folder', (_req, res) => {
    fs.mkdirSync(cfg.downloadDir, { recursive: true })
    if (opts.openPath) opts.openPath(cfg.downloadDir)
    else {
      const child = spawn(systemOpener(), [cfg.downloadDir], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    }
    res.json({ ok: true })
  })

  admin.post('/open-url', jsonSmall, (req, res) => {
    const url = typeof (req.body as { url?: unknown })?.url === 'string' ? (req.body as { url: string }).url.trim() : ''
    // uniquement http(s) : on n'ouvre pas file:, javascript:, etc.
    // ni virgule, guillemet, barre oblique inverse ou accent circonflexe :
    // explorer.exe (Windows) a sa propre syntaxe d'arguments
    if (!/^https?:\/\/[^\s,"\\^<>|]+$/i.test(url) || url.length > 2048) return res.status(400).json({ code: 'badLink' })
    let href = url
    try {
      href = new URL(url).href
    } catch {
      return res.status(400).json({ code: 'badLink' })
    }
    if (opts.openLink) opts.openLink(href)
    else {
      // le lien est passé en argument unique, jamais interprété par un shell
      const child = spawn(systemOpener(), [href], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    }
    res.json({ ok: true })
  })

  admin.post('/approve', jsonSmall, (req, res) => {
    const body = req.body as { id?: unknown; accept?: unknown }
    const cb = typeof body.id === 'string' ? pendingApprovals.get(body.id) : undefined
    if (!cb) return res.status(404).json({ code: 'requestExpired' })
    cb(body.accept === true)
    res.json({ ok: true })
  })

  admin.post('/settings', jsonSmall, (req, res) => {
    const body = req.body as Partial<Config>
    // les listes du téléphone (nom du PC, historique activé) sont à relire,
    // même si la requête échoue plus bas après un premier changement
    settingsGen++
    if (typeof body.deviceName === 'string' && body.deviceName.trim()) cfg.deviceName = body.deviceName.trim().slice(0, 40)
    if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
      const dir = body.downloadDir.trim()
      if (!path.isAbsolute(dir)) return res.status(400).json({ code: 'badFolderPath' })
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        return res.status(400).json({ code: 'cannotCreateFolder' })
      }
      cfg.downloadDir = dir
    }
    if (body.maxFileMB !== undefined) cfg.maxFileMB = clampInt(body.maxFileMB, 1, 128 * 1024, cfg.maxFileMB)
    if (typeof body.requireApproval === 'boolean') cfg.requireApproval = body.requireApproval
    if (typeof body.clipboardAutoPush === 'boolean') {
      // coupé par la personne elle-même : un achat ne le rallumera pas
      if (cfg.clipboardAutoPush && !body.clipboardAutoPush) cfg.clipboardAutoPushOffByUser = true
      cfg.clipboardAutoPush = body.clipboardAutoPush
      // en (ré)activant, on prend l'état courant comme référence pour ne pas
      // pousser d'un coup le contenu déjà présent dans le presse-papiers.
      if (cfg.clipboardAutoPush) clip.read().then((t) => (lastClip = t)).catch(() => {})
    }
    if (typeof body.clipHistoryEnabled === 'boolean') {
      cfg.clipHistoryEnabled = body.clipHistoryEnabled
      if (cfg.clipHistoryEnabled) clip.read().then((t) => (lastClip = t)).catch(() => {})
    }
    if (body.clipHistoryMaxItems !== undefined) {
      cfg.clipHistoryMaxItems = clampInt(body.clipHistoryMaxItems, 10, 1000, cfg.clipHistoryMaxItems)
      clipHistory.purge(cfg)
    }
    if (body.clipHistoryMaxDays !== undefined) {
      cfg.clipHistoryMaxDays = clampInt(body.clipHistoryMaxDays, 1, 90, cfg.clipHistoryMaxDays)
      clipHistory.purge(cfg)
    }
    if (body.theme === 'system' || body.theme === 'light' || body.theme === 'dark') cfg.theme = body.theme
    if (body.skin === 'auto' || body.skin === 'apple' || body.skin === 'windows') cfg.skin = body.skin
    if (body.lang === 'auto' || body.lang === 'ru' || body.lang === 'en') cfg.lang = body.lang
    if (typeof body.shortcutsEnabled === 'boolean') cfg.shortcutsEnabled = body.shortcutsEnabled
    if (typeof body.sortPhotosByMonth === 'boolean') cfg.sortPhotosByMonth = body.sortPhotosByMonth
    saveConfig(home, cfg)
    hub.broadcast('settings-changed', {})
    try {
      opts.onSettingsChanged?.()
    } catch {
      // non critique
    }
    res.json({ ok: true })
  })

  app.use('/api/admin', admin)

  // ---------- erreurs ----------

  app.use((_req, res) => res.status(404).json({ code: 'notFound' }))
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.destroy()
    res.status(err.status ?? 500).json({ code: 'internal' })
  })

  // ---------- HTTP + WebSocket ----------

  const server = http.createServer(app)
  server.maxRequestsPerSocket = 0
  // Connexions gardées ouvertes plus longtemps que les relances du téléphone
  // (toutes les 5 à 6 s) : Safari ne renvoie pas de lui-même un POST parti sur
  // une connexion que le PC venait juste de fermer (morceau de 8 Mo perdu).
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  // Un morceau de 8 Mo sur un wifi très lent dépassait les 5 min par défaut
  // de Node : refusé puis renvoyé depuis le début, sans fin (4 morceaux à la
  // fois sous 110 Ko/s). La page envoie maintenant moins de morceaux à la fois
  // quand le lien lâche, et le corps a 10 min, pour les anciennes pages aussi
  // (les en-têtes restent bornés à 66 s ci-dessus).
  server.requestTimeout = 10 * 60_000
  // au plus 48 connexions ouvertes par adresse : un téléphone en utilise une
  // dizaine (envois en parallèle, suivi) ; sans plafond, quelqu'un sur le wifi
  // gardait des centaines de requêtes lentes ouvertes, chacune avec sa mémoire.
  // La boucle locale (la page du PC) n'est pas limitée.
  const perIp = new Map<string, number>()
  server.on('connection', (socket) => {
    const ip = socket.remoteAddress ?? ''
    if (isLoopback(ip)) return
    const n = (perIp.get(ip) ?? 0) + 1
    if (n > MAX_CONNECTIONS_PER_IP) {
      socket.destroy()
      return
    }
    perIp.set(ip, n)
    socket.once('close', () => {
      const left = (perIp.get(ip) ?? 1) - 1
      if (left <= 0) perIp.delete(ip)
      else perIp.set(ip, left)
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    let ok = false
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      const cookieTok = parseCookies(req.headers.cookie)[ADMIN_COOKIE] ?? ''
      const qTok = url.searchParams.get('k') ?? ''
      ok =
        isLoopback((socket as import('node:net').Socket).remoteAddress) &&
        sameSiteOk(req.headers) &&
        url.pathname === '/ws/ui' &&
        [qTok, cookieTok].some((t) => t.length > 0 && timingSafeEqualStr(t, cfg.adminToken))
    } catch {
      ok = false
    }
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.add(ws))
  })

  // Écoute sur le port voulu, mais si un autre logiciel l'occupe déjà, on bascule
  // sur un autre port plutôt que de planter : d'abord quelques ports fixes
  // voisins de 47777, puis un port libre choisi par le système. Le port
  // obtenu est mémorisé (config.json) et repris aux lancements suivants :
  // l'icône posée sur l'écran d'accueil du téléphone garde la bonne adresse.
  const listenOn = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })

  // Le port de toujours d'abord, et on l'attend : relancé juste après avoir
  // été quitté, l'ancien Flitdrop le tient encore un instant. Basculer tout
  // de suite (et mémoriser l'autre port) cassait l'appairage des téléphones
  // et leur icône d'écran d'accueil, qui visent l'adresse et le port d'avant.
  const candidates = portCandidates(wantedPort)
  const waitWanted = opts.port === undefined ? PORT_WAIT_MS : 0
  const firstTry = Date.now()
  let portWasBusy = false
  for (let i = 0; ; ) {
    const port = candidates[i] ?? 0
    try {
      await listenOn(port)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (port === 0 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw e
      portWasBusy = true
      if (i === 0 && code === 'EADDRINUSE' && Date.now() - firstTry < waitWanted) {
        await new Promise((r) => setTimeout(r, 400))
        continue
      }
      if (i === 0 && !opts.quiet) console.warn(`Port ${port} occupé, bascule sur un autre port pour ce lancement.`)
      i++
    }
  }
  actualPort = (server.address() as AddressInfo).port
  // compté sans rien d'identifiant : savoir si des PC changent de port (les
  // téléphones ne le retrouvent alors plus) aide à régler ce cas
  // un port de secours ne sert que pour ce lancement : la config garde le
  // port habituel, retenté au prochain démarrage

  const adminUrl = `http://127.0.0.1:${actualPort}/app/?k=${encodeURIComponent(cfg.adminToken)}`
  const addLocalFiles = async (paths: string[]): Promise<number> => {
    // clic droit « Envoyer vers », glisser sur l'icône : pas de choix à
    // l'écran, le téléphone choisi la dernière fois (ou tous s'il n'y en a qu'un)
    const to = sendTargets(undefined) ?? undefined
    let added = 0
    for (const p of paths) {
      try {
        const st = await fs.promises.stat(p)
        if (!st.isFile()) continue
        if (st.size > cfg.maxFileMB * 1024 * 1024) continue
        const safe = sanitizeFilename(path.basename(p))
        const reserved = reserveUniquePath(outbox.dir, safe)
        fs.closeSync(reserved.fd)
        await fs.promises.copyFile(p, reserved.path)
        outbox.addFile(path.basename(reserved.path), reserved.path, st.size, undefined, to)
        added++
      } catch {
        // fichier illisible : on passe au suivant
      }
    }
    if (added > 0) hub.broadcast('outbox-changed', {})
    return added
  }

  const addClipboardImage = (png: Buffer, thumb: string, w: number, h: number, fp?: string): void => {
    if (!cfg.clipHistoryEnabled || !png || png.length === 0) return
    const hash = imageHash(png)
    if (hash === lastImageHash) {
      // image qu'on vient de recopier soi-même : l'entrée remontée en tête
      // retient son empreinte de presse-papiers
      if (typeof fp === 'string') clipHistory.adoptFingerprint(fp)
      return
    }
    lastImageHash = hash
    const entry = clipHistory.addImage(png, thumb, w, h, 'pc', cfg, typeof fp === 'string' && fp.length > 0 ? fp.slice(0, 200) : undefined)
    if (entry) hub.broadcast('cliphistory-changed', {})
  }

  return {
    port: actualPort,
    adminToken: cfg.adminToken,
    cfg,
    home,
    adminUrl,
    addLocalFiles,
    addClipboardImage,
    pollClipboard,
    activity,
    setHost,
    setAutostart,
    close: async () => {
      activity.close()
      clearInterval(clipTimer)
      clearInterval(clipPurgeTimer)
      clearInterval(pendingTimer)
      await transfers.closeAll()
      wss.close()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      // connexions gardées ouvertes (65 s) mais inactives : fermées tout de suite
      server.closeIdleConnections?.()
      await closed
    },
  }
}
