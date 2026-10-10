import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { MARKETPLACE_ERRORS, withoutPaths } from "./errors.js";
import { FACEBOOK_ORIGIN, SESSION_COOKIE } from "./selectors.js";

/** La carpeta del perfil de Marketplace de un corredor (spec F5 §4.2). */
export const marketplaceProfileDir = (profilesRoot: string, brokerId: string) =>
  join(profilesRoot, brokerId, "fb_marketplace");

/** El candado del perfil: al lado de la carpeta, no adentro (Chromium la administra). */
const lockPathOf = (profileDir: string) => `${profileDir}.lock`;

export type OpenMarketplaceProfileOptions = {
  /** `marketplaceProfileDir(BROWSER_PROFILES_DIR, brokerId)`. */
  dir: string;
  /** Con ventana por defecto (el operador la ve); los tests la abren sin ventana. */
  headless?: boolean;
  /** Otro Chromium (por defecto, el que pide la versión de Playwright instalada). */
  executablePath?: string;
  /**
   * Se llama con el contexto recién abierto, antes de cualquier navegación: los tests instalan aquí
   * las rutas que responden con páginas locales y bloquean toda la red.
   */
  prepare?: (context: BrowserContext) => Promise<void>;
};

/** Un perfil abierto: su contexto (una ventana), la pestaña principal y el cierre. */
export type MarketplaceProfile = {
  readonly context: BrowserContext;
  readonly page: Page;
  /** El id de la cookie de sesión (`c_user`) si existe y es numérico; nunca otra cookie. */
  sessionUserId(): Promise<string | null>;
  /** Si el perfil sigue abierto (la ventana no se cerró). */
  isOpen(): boolean;
  /** Cierra la ventana y libera el perfil. Idempotente. */
  close(): Promise<void>;
};

/** Los perfiles que este proceso tiene abiertos: el candado de archivo no ve los propios. */
const openInProcess = new Set<string>();

/**
 * Abre el perfil persistente de Marketplace de un corredor (ADR-0017, spec F5 §4.2):
 * - Carpeta con permisos `0700` (guarda la sesión de Facebook); se crea si falta.
 * - **Un proceso a la vez:** un candado de archivo junto a la carpeta, con el pid. Si otro proceso
 *   vivo lo tiene (o este mismo), `MARKETPLACE_PROFILE_BUSY` sin abrir nada; si el dueño ya murió,
 *   se toma.
 * - Chromium de Playwright con ventana, idioma `es-CL` y zona `America/Santiago` (configuración
 *   del contexto, no un disfraz: no se cambia el user agent ni la huella; D6). Sin descargas.
 * - Cerrar la ventana (el operador o `close()`) libera el perfil.
 */
export async function openMarketplaceProfile(
  options: OpenMarketplaceProfileOptions,
): Promise<MarketplaceProfile> {
  const { dir } = options;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (openInProcess.has(dir)) throw MARKETPLACE_ERRORS.profileBusy();
  openInProcess.add(dir);
  let release: () => Promise<void> = async () => {
    openInProcess.delete(dir);
  };
  try {
    const unlock = await acquireLock(lockPathOf(dir));
    release = async () => {
      openInProcess.delete(dir);
      await unlock();
    };
    const context = await chromium
      .launchPersistentContext(dir, {
        headless: options.headless ?? false,
        locale: "es-CL",
        timezoneId: "America/Santiago",
        acceptDownloads: false,
        viewport: null,
        ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      })
      .catch((error: unknown) => {
        const message = withoutPaths(error);
        throw /doesn't exist|does not exist|ENOENT|install/i.test(message)
          ? MARKETPLACE_ERRORS.browserFailed(false)
          : /already in use|ProcessSingleton|SingletonLock/i.test(message)
            ? MARKETPLACE_ERRORS.profileBusy()
            : MARKETPLACE_ERRORS.browserFailed(true);
      });
    let open = true;
    let released: Promise<void> | null = null;
    const releaseOnce = () => {
      released ??= release();
      return released;
    };
    context.on("close", () => {
      open = false;
      void releaseOnce();
    });
    try {
      await options.prepare?.(context);
    } catch (error) {
      await context.close().catch(() => undefined);
      await releaseOnce();
      throw error;
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      async sessionUserId() {
        const cookies = await context.cookies(FACEBOOK_ORIGIN);
        const value = cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value;
        return value !== undefined && /^\d{1,30}$/.test(value) ? value : null;
      },
      isOpen: () => open,
      async close() {
        if (open) await context.close().catch(() => undefined);
        await releaseOnce();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Toma el candado de archivo (`open` con `wx`): si existe y su pid sigue vivo, el perfil está
 * ocupado; si el pid murió (un proceso que cayó sin soltarlo), se borra y se toma. Devuelve el
 * que lo suelta.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        throw MARKETPLACE_ERRORS.profileBusy();
      }
      await rm(lockPath, { force: true });
    }
  }
  throw MARKETPLACE_ERRORS.profileBusy();
}

/** Si un proceso existe (señal 0: no lo toca). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
