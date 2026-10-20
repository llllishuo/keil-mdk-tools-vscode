/**
 * Keil MDK installation discovery and CMSIS-Pack helpers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export interface Toolchain {
  version: 'AC5' | 'AC6';
  bin: string;
  cc: string;
  asm: string;
  link: string;
  fromelf: string;
  armar: string;
}

export interface KeilInstall {
  root: string;
  toolsIni: string;
  uvisionExe: string;
  packsRoot: string;
  ac5?: Toolchain;
  ac6?: Toolchain;
  /** `5.36` style version read from TOOLS.INI. */
  version: string;
}

export interface PackInfo {
  id: string;
  vendor: string;
  name: string;
  version: string;
  dir: string;
  pdsc: string;
  packFile?: string;
}

export interface DevicePackInfo {
  defines: string[];
  header?: string;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function execFileText(file: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

export function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = sections.get('');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      const key = sectionMatch[1].toUpperCase();
      if (!sections.has(key)) {
        sections.set(key, new Map());
      }
      current = sections.get(key);
      continue;
    }
    if (!current) {
      current = new Map();
      sections.set('', current);
    }
    const equalIndex = line.indexOf('=');
    if (equalIndex < 0) {
      continue;
    }
    const key = line.slice(0, equalIndex).trim().toUpperCase();
    let value = line.slice(equalIndex + 1).trim();
    // Drop trailing comments that are separated by whitespace.
    const commentIndex = value.search(/\s+#/);
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim();
    }
    if (value.startsWith('"')) {
      const endQuote = value.indexOf('"', 1);
      if (endQuote > 0) {
        value = value.slice(1, endQuote);
      }
    }
    current.set(key, value);
  }
  return sections;
}

function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

function makeToolchain(bin: string, version: 'AC5' | 'AC6'): Toolchain | undefined {
  const ccName = version === 'AC6' ? 'armclang.exe' : 'armcc.exe';
  const cc = path.join(bin, ccName);
  if (!fileExists(cc)) {
    return undefined;
  }
  return {
    version,
    bin,
    cc,
    asm: firstExisting([path.join(bin, 'armasm.exe'), path.join(bin, 'armclang.exe')]),
    link: firstExisting([path.join(bin, 'armlink.exe')]),
    fromelf: firstExisting([path.join(bin, 'fromelf.exe')]),
    armar: firstExisting([path.join(bin, 'armar.exe')]),
  };
}

export function loadInstall(root: string): KeilInstall | undefined {
  const toolsIni = path.join(root, 'TOOLS.INI');
  const hasTools = fileExists(toolsIni);
  const hasArm = directoryExists(path.join(root, 'ARM'));
  if (!hasTools && !hasArm) {
    return undefined;
  }

  let ini = new Map<string, Map<string, string>>();
  if (hasTools) {
    try {
      ini = parseIni(fs.readFileSync(toolsIni, 'utf8'));
    } catch {
      ini = new Map();
    }
  }

  const armSection = ini.get('ARM');
  const uv2Section = ini.get('UV2');
  const rtePath = uv2Section?.get('RTEPATH') ?? armSection?.get('RTEPATH') ?? '';
  const packsRoot = rtePath && directoryExists(rtePath)
    ? rtePath
    : path.join(os.homedir(), 'AppData', 'Local', 'Arm', 'Packs');

  // The compiler folders can be redirected through ARMCCPATH<n> entries.
  const ac6Candidates = [
    path.join(root, 'ARM', 'ARMCLANG', 'bin'),
    ...['0', '1', '2', '3'].map((index) => {
      const raw = ini.get('ARMADS')?.get(`ARMCCPATH${index}`) ?? ini.get('ARM')?.get(`ARMCCPATH${index}`);
      if (!raw) {
        return '';
      }
      return path.resolve(root, raw);
    }).map((dir) => (dir ? path.join(dir, 'bin') : '')),
  ];
  const ac5Candidates = [
    path.join(root, 'ARM', 'ARMCC', 'bin'),
    path.join(root, 'ARM', 'ARMCC', 'Bin'),
  ];
  if (ac5Candidates[0].toLowerCase() === ac5Candidates[1].toLowerCase()) {
    ac5Candidates.pop();
  }

  let ac6: Toolchain | undefined;
  for (const candidate of ac6Candidates) {
    if (candidate && directoryExists(candidate)) {
      ac6 = makeToolchain(candidate, 'AC6');
      if (ac6) {
        break;
      }
    }
  }
  let ac5: Toolchain | undefined;
  for (const candidate of ac5Candidates) {
    if (candidate && directoryExists(candidate)) {
      ac5 = makeToolchain(candidate, 'AC5');
      if (ac5) {
        break;
      }
    }
  }

  return {
    root,
    toolsIni,
    uvisionExe: firstExisting([path.join(root, 'UV4', 'UV4.exe')]),
    packsRoot,
    ac5,
    ac6,
    version: armSection?.get('VERSION') ?? uv2Section?.get('VERSION') ?? '',
  };
}

async function registryRoots(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }
  const outputs: string[] = [];
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Keil\\Products\\MDK',
    'HKLM\\SOFTWARE\\Keil\\Products\\MDK',
    'HKCU\\SOFTWARE\\Keil\\Products\\MDK',
  ];
  for (const key of keys) {
    const text = await execFileText('reg', ['query', key, '/v', 'Path']);
    const match = /Path\s+REG_SZ\s+(.+)/i.exec(text);
    if (match) {
      outputs.push(match[1].trim());
    }
  }
  return outputs;
}

export async function discoverInstall(preferredRoot?: string): Promise<KeilInstall | undefined> {
  const candidates: string[] = [];
  if (preferredRoot) {
    candidates.push(preferredRoot);
  }
  if (process.env.KEIL_ROOT) {
    candidates.push(process.env.KEIL_ROOT);
  }
  candidates.push(
    'C:\\Keil_v5',
    'C:\\Keil',
    'D:\\Keil_v5',
    'D:\\Keil',
    'C:\\Program Files\\Keil_v5',
    'C:\\Program Files (x86)\\Keil_v5'
  );

  for (const candidate of candidates) {
    if (candidate && directoryExists(candidate)) {
      const install = loadInstall(path.resolve(candidate));
      if (install && (install.ac5 || install.ac6)) {
        return install;
      }
    }
  }

  // Fall back to the location of UV4.exe on PATH and to the registry.
  const whereText = await execFileText('where', ['UV4.exe']);
  const whereRoots = whereText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((exe) => path.dirname(path.dirname(exe)));
  const allRoots = [...whereRoots, ...(await registryRoots())];
  for (const root of allRoots) {
    const install = loadInstall(root);
    if (install && (install.ac5 || install.ac6)) {
      return install;
    }
  }
  return undefined;
}

export function toolchainFor(install: KeilInstall, useAC6: boolean): Toolchain | undefined {
  return useAC6 ? install.ac6 : install.ac5;
}

/** Resolve a PackID such as `Keil.STM32F1xx_DFP.2.3.0` to an installed pack. */
export function resolvePack(packsRoot: string, packId: string): PackInfo | undefined {
  if (!packId || !directoryExists(packsRoot)) {
    return undefined;
  }
  const versionMatch = /^(.*)\.(\d+\.\d+\.\d+)$/.exec(packId);
  if (!versionMatch) {
    return undefined;
  }
  const namePart = versionMatch[1];
  const version = versionMatch[2];
  const dotIndex = namePart.indexOf('.');
  if (dotIndex <= 0) {
    return undefined;
  }
  const vendor = namePart.slice(0, dotIndex);
  const name = namePart.slice(dotIndex + 1);
  const dir = path.join(packsRoot, vendor, name, version);
  if (!directoryExists(dir)) {
    return undefined;
  }
  const pdsc = firstExisting([
    path.join(dir, `${name}.pdsc`),
    path.join(dir, `${vendor}.${name}.pdsc`),
  ]);
  const packFile = findPackFile(dir);
  return { id: packId, vendor, name, version, dir, pdsc, packFile };
}

function findPackFile(dir: string): string | undefined {
  try {
    const entry = fs.readdirSync(dir).find((name) => name.toLowerCase().endsWith('.pack'));
    return entry ? path.join(dir, entry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read `define="..."` / `header="..."` from the device entry of a CMSIS-Pack
 * description.  This mirrors the extra defines µVision injects for a device.
 */
export function devicePackInfo(pack: PackInfo | undefined, deviceName: string): DevicePackInfo {
  if (!pack || !pack.pdsc || !deviceName) {
    return { defines: [] };
  }
  try {
    const text = fs.readFileSync(pack.pdsc, 'utf8');
    const deviceNeedle = `<device Dname="${deviceName}"`;
    let searchFrom = 0;
    while (true) {
      const index = text.indexOf(deviceNeedle, searchFrom);
      if (index < 0) {
        return { defines: [] };
      }
      const windowEnd = Math.min(text.length, index + 8000);
      const window = text.slice(index, windowEnd);
      const nextDevice = window.indexOf('<device ', 10);
      const scope = nextDevice > 0 ? window.slice(0, nextDevice) : window;
      const compile = /<compile\b[^>]*>/i.exec(scope);
      if (compile) {
        const defineMatch = /define\s*=\s*"([^"]*)"/i.exec(compile[0]);
        const headerMatch = /header\s*=\s*"([^"]*)"/i.exec(compile[0]);
        const defines = defineMatch ? defineMatch[1].split(',').map((value) => value.trim()).filter(Boolean) : [];
        if (defines.length > 0 || headerMatch) {
          return { defines, header: headerMatch ? headerMatch[1] : undefined };
        }
      }
      searchFrom = index + deviceNeedle.length;
    }
  } catch {
    return { defines: [] };
  }
}

/**
 * Expand a µVision device path such as
 * `$$Device:STM32F103ZE$SVD\STM32F103xx.svd` to an absolute path.
 */
export function resolveDevicePath(pack: PackInfo | undefined, template: string): string {
  if (!template) {
    return '';
  }
  const match = /^\$\$Device:[^$]*\$(.*)$/.exec(template.trim());
  if (!match) {
    return template;
  }
  if (!pack) {
    return '';
  }
  return path.join(pack.dir, match[1].replace(/[\\/]+/g, path.sep));
}
