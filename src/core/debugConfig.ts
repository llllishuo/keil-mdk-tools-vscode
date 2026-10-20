/**
 * Generation of Cortex-Debug launch configurations from the uVision debugger
 * selection stored in the .uvoptx file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { KeilInstall, PackInfo, resolveDevicePath } from './tools';
import { UVOpt, UVProject, UVTarget, findUVOptPath, parseUVOpt } from './uvprojx';

export type ServerType = 'openocd' | 'jlink' | 'stlink' | 'pyocd';

export interface GeneratedDebugConfig {
  configuration: Record<string, unknown>;
  serverType: ServerType;
  notes: string[];
  name: string;
}

const OPENOCD_TARGET_FILES: Array<{ pattern: RegExp; file: string }> = [
  { pattern: /^STM32F0/i, file: 'target/stm32f0x.cfg' },
  { pattern: /^STM32F1/i, file: 'target/stm32f1x.cfg' },
  { pattern: /^STM32F2/i, file: 'target/stm32f2x.cfg' },
  { pattern: /^STM32F3/i, file: 'target/stm32f3x.cfg' },
  { pattern: /^STM32F4/i, file: 'target/stm32f4x.cfg' },
  { pattern: /^STM32F7/i, file: 'target/stm32f7x.cfg' },
  { pattern: /^STM32G0/i, file: 'target/stm32g0x.cfg' },
  { pattern: /^STM32G4/i, file: 'target/stm32g4x.cfg' },
  { pattern: /^STM32H7/i, file: 'target/stm32h7x.cfg' },
  { pattern: /^STM32L0/i, file: 'target/stm32l0.cfg' },
  { pattern: /^STM32L1/i, file: 'target/stm32l1.cfg' },
  { pattern: /^STM32L4/i, file: 'target/stm32l4x.cfg' },
  { pattern: /^STM32L5/i, file: 'target/stm32l5x.cfg' },
  { pattern: /^STM32U5/i, file: 'target/stm32u5x.cfg' },
  { pattern: /^STM32WB/i, file: 'target/stm32wbx.cfg' },
  { pattern: /^STM32WL/i, file: 'target/stm32wlx.cfg' },
  { pattern: /^GD32F1|^GD32F3/i, file: 'target/stm32f1x.cfg' },
  { pattern: /^GD32F4/i, file: 'target/stm32f4x.cfg' },
  { pattern: /^N32/i, file: 'target/stm32f1x.cfg' },
];

export function openocdTargetFile(deviceName: string): string {
  const match = OPENOCD_TARGET_FILES.find((entry) => entry.pattern.test(deviceName));
  return match ? match.file : 'target/stm32f1x.cfg';
}

export function interfaceFileFor(driver: string, serverType: ServerType): string {
  if (serverType === 'jlink') {
    return 'interface/jlink.cfg';
  }
  if (/ST-LINK|STLINK/i.test(driver)) {
    return 'interface/stlink.cfg';
  }
  return 'interface/cmsis-dap.cfg';
}

export function detectServerType(driver: string, override: string, deviceName: string): ServerType {
  if (override && override !== 'auto') {
    return override as ServerType;
  }
  if (/JL2CM3|JLTAgdi|jlink/i.test(driver)) {
    return 'jlink';
  }
  if (/ST-LINK|STLINK/i.test(driver)) {
    return 'stlink';
  }
  if (/CMSIS_AGDI/i.test(driver)) {
    return 'openocd';
  }
  // ULINK and unknown drivers: OpenOCD is the most widely available option.
  return 'openocd';
}

export function loadUVOpt(projectFile: string): UVOpt {
  return parseUVOpt(findUVOptPath(projectFile));
}

export function debuggerDriverForTarget(projectFile: string, targetName: string): string {
  const opt = loadUVOpt(projectFile);
  const entry = opt.targets.find((candidate) => candidate.name === targetName);
  return entry?.driver ?? '';
}

export function generateDebugConfiguration(
  install: KeilInstall,
  project: UVProject,
  target: UVTarget,
  pack: PackInfo | undefined,
  serverOverride: string
): GeneratedDebugConfig {
  const driver = debuggerDriverForTarget(project.filePath, target.name);
  const serverType = detectServerType(driver, serverOverride, target.device.name);
  const axfPath = path.join(target.outputDir, `${target.outputName}.axf`);
  const svdFile = resolveDevicePath(pack, target.device.svdFile);
  const notes: string[] = [];
  const name = `Keil: ${target.name}`;
  const configuration: Record<string, unknown> = {
    type: 'cortex-debug',
    request: 'launch',
    name,
    cwd: project.dir,
    executable: axfPath,
    servertype: serverType,
    device: target.device.name,
    runToEntryPoint: 'main',
    showDevDebugOutput: 'none',
  };
  if (serverType === 'openocd') {
    configuration.configFiles = [interfaceFileFor(driver, serverType), openocdTargetFile(target.device.name)];
    notes.push(
      'OpenOCD is used as the GDB server. Make sure OpenOCD is installed and available on PATH ' +
        '(or set "cortex-debug.openocdPath").'
    );
    configuration.serverpath = 'openocd';
  }
  if (serverType === 'jlink') {
    configuration.interface = 'swd';
    notes.push(
      'J-Link is used as the GDB server. Point "serverpath" at JLinkGDBServerCL.exe if it is not on PATH.'
    );
    configuration.serverpath = 'JLinkGDBServerCL.exe';
  }
  if (serverType === 'stlink') {
    configuration.interface = 'swd';
    configuration.serverpath = 'ST-LINK_gdbserver.exe';
    notes.push(
      'The ST-Link GDB server from STM32CubeCLT is used. Adjust "serverpath" to your ST-LINK_gdbserver.exe.'
    );
  }
  if (serverType === 'pyocd') {
    configuration.targetId = target.device.name.toLowerCase();
    if (pack?.packFile) {
      configuration.cmsisPack = pack.packFile;
    }
    notes.push('pyOCD is used as the GDB server. Install it with "pip install pyocd".');
  }
  if (svdFile && fs.existsSync(svdFile)) {
    configuration.svdFile = svdFile;
  } else if (target.device.svdFile) {
    notes.push(`The SVD file could not be resolved (${target.device.svdFile}); set "svdFile" manually for peripheral views.`);
  }
  if (!fs.existsSync(axfPath)) {
    notes.push('The .axf file does not exist yet - build the target before starting a debug session.');
  }
  if (!install.uvisionExe) {
    notes.push('uVision was not found; only toolchain based features are available.');
  }
  notes.push(`Cortex-Debug debugger mapping: uVision driver "${driver || 'not configured'}" -> ${serverType}.`);
  return { configuration, serverType, notes, name };
}

/**
 * Merge a generated launch configuration into an existing launch.json object.
 */
export function mergeLaunchConfiguration(
  existing: any,
  generated: Record<string, unknown>
): { document: any; changed: boolean } {
  const document = existing && typeof existing === 'object' ? existing : {};
  const configurations: any[] = Array.isArray(document.configurations) ? document.configurations : [];
  const index = configurations.findIndex(
    (entry) => entry && typeof entry.name === 'string' && entry.name === generated.name
  );
  let changed = false;
  if (index >= 0) {
    if (JSON.stringify(configurations[index]) !== JSON.stringify(generated)) {
      configurations[index] = generated;
      changed = true;
    }
  } else {
    configurations.push(generated);
    changed = true;
  }
  document.configurations = configurations;
  document.version = document.version ?? '0.2.0';
  return { document, changed };
}
