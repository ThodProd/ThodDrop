import fs from 'node:fs'
import path from 'node:path'
import type { TransferActivityState } from './activity.js'

// Petites briques de l'app de bureau (main.cjs) qui touchent au système :
// garder le PC éveillé pendant un transfert, nouvelle version sur Mac,
// lancement au démarrage sous Linux. Écrites ici, sans Electron, pour être
// testées ; main.cjs leur passe les vraies fonctions d'Electron.

// ---------- état du système montré dans la fenêtre ----------

/** Ce que l'app de bureau signale à la page du PC (GET /state, champ host). */
export interface HostState {
  /** Mac : une version plus récente est publiée (carte « Nouvelle version »).
   *  `reveal` augmente à chaque vérification demandée à la main : la page
   *  remontre alors la carte, même après « Plus tard ». */
  macUpdate: { version: string; reveal?: number } | null
  /** Mac : « Lancer au démarrage » attend l'accord de la personne dans les
   *  réglages de macOS. */
  loginItemNeedsApproval: boolean
}

/** Changement signalé par l'app de bureau. `revealMacUpdate` : la personne
 *  vient de demander une vérification, la carte doit se remontrer. */
export type HostPatch = Partial<HostState> & { revealMacUpdate?: boolean }

/** Actions que la page peut demander à l'app de bureau (jamais d'adresse
 *  fournie par la page : l'app sait elle-même quoi ouvrir). */
export const HOST_ACTIONS = ['openLoginItems'] as const
export type HostAction = (typeof HOST_ACTIONS)[number]

// ---------- PC éveillé et progression sur l'icône ----------

/** Ce dont on se sert de powerSaveBlocker d'Electron. */
export interface PowerBlocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted?(id: number): boolean
}

export interface KeepAwakeOptions {
  blocker: PowerBlocker
  /** Progression sur l'icône (win.setProgressBar) : 0 à 1, 2 = en cours sans
   *  pourcentage connu, -1 = effacée. */
  setProgress: (value: number) => void
  /** Filet de sécurité : sans aucune nouvelle du coeur pendant ce délai, on
   *  rend la main au système même si « actif » n'est jamais retombé. Le coeur
   *  redit l'état toutes les 10 minutes tant que des octets passent. */
  maxMs?: number
}

// 30 minutes sans nouvelle : le PC peut de nouveau se mettre en veille
export const KEEP_AWAKE_MAX_MS = 30 * 60 * 1000

/**
 * Empêche la mise en veille du PC tant qu'un transfert passe (événement
 * 'transfer' de core.activity) et affiche sa progression dans la barre des
 * tâches Windows ou le Dock. Aucune erreur du système ne remonte : au pire,
 * le PC se met en veille comme avant.
 */
export class TransferKeepAwake {
  private id: number | null = null
  private cap: ReturnType<typeof setTimeout> | null = null
  private shown = false
  private readonly maxMs: number

  constructor(private readonly o: KeepAwakeOptions) {
    this.maxMs = o.maxMs ?? KEEP_AWAKE_MAX_MS
  }

  /** Écouteur de l'événement 'transfer'. */
  update(state: TransferActivityState | null | undefined): void {
    if (!state || !state.active) {
      this.stop()
      return
    }
    this.hold()
    // tout est arrivé : le PC reste éveillé encore un peu, mais la barre
    // disparaît (sinon « en cours » pendant 30 s après chaque fichier)
    if (state.running === 0) {
      if (this.shown) this.progress(-1)
      return
    }
    const p = state.progress
    this.progress(typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 2)
  }

  /** Tout rendre : fin de transfert, erreur, fermeture de l'app. */
  stop(): void {
    this.release()
    if (this.shown) this.progress(-1)
  }

  get holding(): boolean {
    return this.id !== null
  }

  private hold(): void {
    if (this.id === null) {
      try {
        this.id = this.o.blocker.start('prevent-app-suspension')
      } catch {
        this.id = null
      }
    }
    // chaque nouvelle du coeur repousse le filet de sécurité
    if (this.cap) clearTimeout(this.cap)
    this.cap = setTimeout(() => {
      this.cap = null
      // la barre part avec le verrou : jamais une progression figée à l'écran
      this.stop()
    }, this.maxMs)
    this.cap.unref?.()
  }

  private release(): void {
    if (this.cap) clearTimeout(this.cap)
    this.cap = null
    if (this.id === null) return
    const id = this.id
    this.id = null
    try {
      if (!this.o.blocker.isStarted || this.o.blocker.isStarted(id)) this.o.blocker.stop(id)
    } catch {
      // déjà rendu par le système
    }
  }

  private progress(value: number): void {
    try {
      this.o.setProgress(value)
      this.shown = value >= 0
    } catch {
      // fenêtre fermée ou système sans barre de progression
    }
  }
}

// ---------- lancement au démarrage sous Linux ----------

// app.setLoginItemSettings ne fait rien sous Linux : on pose nous-mêmes le
// fichier de démarrage automatique (norme freedesktop, reconnue par GNOME,
// KDE, Xfce, Cinnamon…).

/** ~/.config/autostart/flitdrop.desktop (ou $XDG_CONFIG_HOME/autostart). */
export function linuxAutostartFile(env: NodeJS.ProcessEnv, homeDir: string): string {
  // chemins POSIX : ce fichier n'existe que sous Linux (et les tests tournent aussi sous Windows)
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(homeDir, '.config')
  return path.posix.join(base, 'autostart', 'flitdrop.desktop')
}

/** Programme à lancer : l'AppImage quand l'app tourne depuis une AppImage
 *  (son chemin change à chaque mise à jour), sinon l'exécutable installé,
 *  en passant par le lanceur posé à côté (build/afterPack.cjs) s'il existe. */
export function linuxExecTarget(appImage: string | undefined, execPath: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (appImage && path.isAbsolute(appImage)) return appImage
  if (execPath.endsWith('-bin')) {
    const launcher = execPath.slice(0, -'-bin'.length)
    try {
      if (exists(launcher)) return launcher
    } catch {
      // lanceur illisible : l'exécutable lui-même
    }
  }
  return execPath
}

/** Guillemets de la norme Desktop Entry : \, ", ` et $ échappés, % doublé. */
export function desktopExecQuote(arg: string): string {
  return `"${arg.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`
}

/** Contenu du fichier de démarrage : Flitdrop démarre caché (--hidden). */
export function linuxAutostartEntry(execTarget: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Flitdrop',
    'Comment=Flitdrop',
    `Exec=${desktopExecQuote(execTarget)} --hidden`,
    'Icon=flitdrop',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export function isLinuxAutostart(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Pose ou retire le fichier. Rend l'état réel après coup. */
export function setLinuxAutostart(file: string, enabled: boolean, execTarget: string): boolean {
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, linuxAutostartEntry(execTarget), { mode: 0o644 })
    } else {
      fs.rmSync(file, { force: true })
    }
  } catch {
    // dossier en lecture seule : l'état réel est relu ci-dessous
  }
  return isLinuxAutostart(file)
}

/** Mise à jour installée à la fermeture (bouton « Plus tard ») : l'ancienne
 *  AppImage est effacée et la nouvelle porte un autre nom, sans relance. Le
 *  fichier de démarrage suit tout de suite (événement
 *  'appimage-filename-updated' d'electron-updater), sinon Flitdrop ne
 *  démarrerait plus à la connexion suivante. `true` : le fichier a été corrigé. */
export function followRenamedAppImage(file: string, newPath: unknown): boolean {
  if (typeof newPath !== 'string' || !path.isAbsolute(newPath) || newPath.includes('\0')) return false
  return refreshLinuxAutostart(file, newPath)
}

/** Au lancement : si le démarrage automatique est posé, on corrige la seule
 *  ligne Exec quand le programme a changé de place (AppImage mise à jour sous
 *  un autre nom). Le reste du fichier, peut-être retouché à la main, est gardé.
 *  `true` : le fichier a été corrigé. */
export function refreshLinuxAutostart(file: string, execTarget: string): boolean {
  try {
    if (!isLinuxAutostart(file)) return false
    const text = fs.readFileSync(file, 'utf8')
    const want = `Exec=${desktopExecQuote(execTarget)} --hidden`
    const lines = text.split('\n')
    const i = lines.findIndex((l) => l.startsWith('Exec='))
    if (i === -1 || lines[i] === want) return false
    lines[i] = want
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o644 })
    return true
  } catch {
    return false
  }
}
