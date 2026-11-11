import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT, DEFAULT_MAX_FILE_MB, QUICK_AGENT_PORT, QUICK_WORKER_PORT } from './constants.js'
import { randomToken } from './crypto.js'

export interface Config {
  deviceName: string
  port: number
  downloadDir: string
  maxFileMB: number
  requireApproval: boolean
  adminToken: string
  // identité secrète unique de CE PC. Chaque appairage y est lié : un téléphone
  // appairé à ce PC ne peut pas être utilisé avec un autre PC, même sur le même
  // wifi. « Réinitialiser ce PC » la fait tourner pour invalider tous les
  // appairages d'un coup (utile quand on prête ou revend la machine).
  instanceId: string
  // le PC surveille son presse-papiers et le met à disposition des téléphones
  // dès qu'il change (sens PC vers téléphone, seul sens automatisable côté PC).
  clipboardAutoPush: boolean
  // la personne l'a déjà coupé elle-même : un achat de Flitdrop Pro ne le
  // rallume jamais tout seul
  clipboardAutoPushOffByUser: boolean
  // historique local du presse-papiers (façon Paste) : tout ce qui est copié
  // sur le PC et reçu des téléphones, purgé automatiquement selon la rétention.
  clipHistoryEnabled: boolean
  clipHistoryMaxItems: number
  clipHistoryMaxDays: number
  // apparence de l'interface PC : suit l'OS, ou forcée claire/sombre.
  theme: 'system' | 'light' | 'dark'
  // style de l'interface : 'auto' suit l'OS réel (Apple sur Mac, Windows sur
  // Windows) ; on peut forcer l'un ou l'autre indépendamment du système.
  skin: 'auto' | 'apple' | 'windows'
  // langue de l'interface : 'auto' suit le système, sinon forcée.
  lang: 'auto' | 'ru' | 'en'
  // partage direct via le Raccourci iOS. Pratique mais NON chiffré (jeton en
  // clair sur le réseau) : à désactiver sur un wifi public non fiable.
  shortcutsEnabled: boolean
  firstPairingDone: boolean
  firstTransferDone: boolean
  // un téléphone a déjà ouvert la page Flitdrop de ce PC (statistique
  // « page ouverte », premier passage ou non)
  firstPhonePageDone: boolean
  // destinataire du dernier envoi fait depuis le PC quand plusieurs téléphones
  // sont appairés : 'all' ou l'identifiant d'un téléphone ('' = pas encore
  // choisi). Proposé par défaut au prochain envoi.
  lastSendTo: string
  // la question « Lancer Flitdrop à l'ouverture de ma session » (écran
  // d'accueil) a reçu une réponse. Faux seulement pour une installation neuve
  // (aucun config.json) : une installation existante garde son réglage.
  autostartAsked: boolean
  // Pro : photos et vidéos reçues rangées dans un dossier par mois (AAAA-MM).
  // Allumé par défaut ; sans effet en gratuit ou mode payant coupé.
  sortPhotosByMonth: boolean
  // Быстрый приём по статической ссылке: маленький агент в автозапуске
  // слушает quickPort, поднимает worker по запросу и проксирует телефонную
  // страницу. Работает только в локальной сети, пока ПК включён.
  quickEnabled: boolean
  quickPort: number
  quickWorkerPort: number
  // Открывать проводник на принятом файле/тексте (папка + выделенный файл).
  openReceived: boolean
}


export function flitdropHome(override?: string): string {
  const h = override || process.env.THODHUB_DATA_DIR || process.env.FLITDROP_HOME || path.join(os.homedir(), '.thoddrop')
  // 0700 : dossier privé (clés, presse-papiers, jetons). Sans effet sur Windows.
  fs.mkdirSync(h, { recursive: true, mode: 0o700 })
  // dossier créé par une version d'avant ce durcissement (0755, fichiers
  // 0644) : resserré à chaque démarrage, sinon un autre compte de
  // l'ordinateur pouvait lire le jeton de la page et les clés des téléphones
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(h, 0o700)
      for (const f of fs.readdirSync(h, { withFileTypes: true })) {
        if (f.isFile()) fs.chmodSync(path.join(h, f.name), 0o600)
        else if (f.isDirectory()) fs.chmodSync(path.join(h, f.name), 0o700)
      }
    } catch {
      // dossier d'un autre propriétaire (lancement avec sudo) : laissé tel quel
    }
  }
  return h
}

export function defaultDeviceName(): string {
  const raw = (os.hostname().split('.')[0] ?? '').replace(/[-_]+/g, ' ').trim()
  return raw.slice(0, 32) || 'Mon PC'
}

export function loadConfig(home: string): Config {
  const p = path.join(home, 'config.json')
  let stored: Partial<Config> = {}
  let existed = false
  try {
    stored = JSON.parse(fs.readFileSync(p, 'utf8'))
    existed = true
  } catch {
    // premier lancement
  }
  const legacyHistory = { paired: false, transferred: false }
  const cfg: Config = {
    deviceName: stored.deviceName || defaultDeviceName(),
    port: validPort(stored.port) ?? DEFAULT_PORT,
    downloadDir:
      stored.downloadDir || process.env.FLITDROP_DOWNLOADS || path.join(os.homedir(), 'Downloads', 'ThodDrop'),
    maxFileMB: clampInt(stored.maxFileMB, 1, 128 * 1024, DEFAULT_MAX_FILE_MB),
    requireApproval: stored.requireApproval === true,
    adminToken: typeof stored.adminToken === 'string' && stored.adminToken.length >= 20 ? stored.adminToken : randomToken(24),
    instanceId: typeof stored.instanceId === 'string' && stored.instanceId.length >= 12 ? stored.instanceId : randomToken(12),
    clipboardAutoPush: stored.clipboardAutoPush === true,
    clipboardAutoPushOffByUser: stored.clipboardAutoPushOffByUser === true,
    clipHistoryEnabled: stored.clipHistoryEnabled !== false,
    clipHistoryMaxItems: clampInt(stored.clipHistoryMaxItems, 10, 1000, 200),
    clipHistoryMaxDays: clampInt(stored.clipHistoryMaxDays, 1, 90, 7),
    theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
    skin: stored.skin === 'apple' || stored.skin === 'windows' ? stored.skin : 'auto',
    lang: stored.lang === 'ru' || stored.lang === 'en' ? stored.lang : 'auto',
    shortcutsEnabled: stored.shortcutsEnabled !== false,
    firstPairingDone: stored.firstPairingDone === true || legacyHistory.paired,
    firstTransferDone: stored.firstTransferDone === true || legacyHistory.transferred,
    firstPhonePageDone: false,
    lastSendTo: typeof stored.lastSendTo === 'string' && /^(all|[A-Za-z0-9_-]{1,40})$/.test(stored.lastSendTo) ? stored.lastSendTo : '',
    // absent d'un config.json existant : installation d'avant cette question,
    // son réglage de démarrage reste tel quel (jamais changé en silence)
    autostartAsked: typeof stored.autostartAsked === 'boolean' ? stored.autostartAsked : existed,
    sortPhotosByMonth: stored.sortPhotosByMonth === true,
    quickEnabled: stored.quickEnabled === true,
    quickPort: validPort(stored.quickPort) ?? QUICK_AGENT_PORT,
    quickWorkerPort: validPort(stored.quickWorkerPort) ?? QUICK_WORKER_PORT,
    openReceived: stored.openReceived !== false,
  }
  // migration : absent d'un config.json plus ancien. Une installation qui a
  // déjà appairé un téléphone ou transféré quelque chose a forcément vu la page
  // s'ouvrir sur un téléphone : ce ne sera pas une « première fois ».
  cfg.firstPhonePageDone = stored.firstPhonePageDone === true || cfg.firstPairingDone || cfg.firstTransferDone
  saveConfig(home, cfg)
  return cfg
}

export function saveConfig(home: string, cfg: Config): void {
  // 0600 : contient le jeton admin et l'instanceId.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

function validPort(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536 ? v : undefined
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
