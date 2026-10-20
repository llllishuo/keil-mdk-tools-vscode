/**
 * Engine selection: decide between the native toolchain build and the UV4.exe
 * bridge for a given target, then execute it and normalise the result.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BuildSummary, NativeBuildOptions, buildNative } from './nativeBuild';
import { uvisionVersionDefine } from './commands';
import { runUV4, uv4ExitDescription } from './uv4';

export type BuildEngineSetting = 'auto' | 'uv4' | 'native';

export interface EngineBuildOptions extends NativeBuildOptions {
  engine: BuildEngineSetting;
  uv4Path: string;
  action: 'build' | 'rebuild';
}

export interface EngineDecision {
  mode: 'native' | 'uv4';
  reason: string;
}

export function hasNativeToolchain(options: Pick<NativeBuildOptions, 'install' | 'target'>): boolean {
  const toolchain = options.target.uAC6 ? options.install.ac6 : options.install.ac5;
  return Boolean(toolchain);
}

export function decideEngine(
  engine: BuildEngineSetting,
  options: Pick<NativeBuildOptions, 'install' | 'target' | 'project'>,
  uv4Path: string
): EngineDecision {
  const nativeAvailable = hasNativeToolchain(options);
  const uv4Available = Boolean(uv4Path) && fs.existsSync(uv4Path);
  const toolName = options.target.uAC6 ? 'ARMCLANG 6' : 'ARMCC 5';
  const toolchainRoot = options.target.uAC6 ? options.install.ac6?.bin : options.install.ac5?.bin;

  if (engine === 'uv4') {
    if (!uv4Available) {
      throw new Error('uVision (UV4.exe) was not found. Configure "keil.root" or "keil.uv4.path".');
    }
    return { mode: 'uv4', reason: 'keil.build.engine = uv4' };
  }
  if (engine === 'native') {
    if (!nativeAvailable) {
      throw new Error(
        `${toolName} was not found under ${options.install.root}\\ARM. ` +
          'Install the compiler or switch "keil.build.engine" to "uv4".'
      );
    }
    return { mode: 'native', reason: 'keil.build.engine = native' };
  }

  // auto
  if (options.project.usesRte) {
    if (uv4Available) {
      return {
        mode: 'uv4',
        reason: 'the target uses CMSIS-Pack (RTE) components; uVision is required to resolve them',
      };
    }
    return { mode: 'native', reason: 'RTE components detected but uVision is unavailable; trying the native toolchain' };
  }
  if (nativeAvailable) {
    return { mode: 'native', reason: `${toolName} found in ${toolchainRoot}` };
  }
  if (uv4Available) {
    return { mode: 'uv4', reason: 'native toolchain not found; falling back to uVision' };
  }
  throw new Error(
    'No build engine available: neither a matching ARM compiler nor UV4.exe could be found. ' +
      'Set "keil.root" to the Keil MDK installation folder.'
  );
}

function uv4CommandLine(uv4Path: string, projectFile: string, action: 'build' | 'rebuild', target: string): string {
  const switchValue = action === 'rebuild' ? '-r' : '-b';
  return `"${uv4Path}" ${switchValue} "${projectFile}" -t "${target}" -j0 -o build.log`;
}

export async function buildWithEngine(options: EngineBuildOptions): Promise<BuildSummary> {
  const started = Date.now();
  const decision = decideEngine(options.engine, options, options.uv4Path);

  if (decision.mode === 'native') {
    options.log(`Engine: native toolchain (${decision.reason})`);
    if (options.action === 'rebuild') {
      options.log('Rebuild requested: cleaning output folder first.');
    }
    return buildNative({
      ...options,
      cleanFirst: options.cleanFirst || options.action === 'rebuild',
    });
  }

  options.log(`Engine: uVision (${decision.reason})`);
  const commandLine = uv4CommandLine(options.uv4Path, options.project.filePath, options.action, options.target.name);
  options.log(commandLine);
  const result = await runUV4({
    uv4Path: options.uv4Path,
    projectFile: options.project.filePath,
    action: options.action,
    target: options.target.name,
    token: options.token,
    log: options.log,
  });
  if (result.output.trim()) {
    for (const line of result.output.trim().split(/\r?\n/)) {
      options.log(`  ${line}`);
    }
  }

  const success = result.exitCode === 0 || result.exitCode === 1;
  const axf = path.join(options.target.outputDir, `${options.target.outputName}.axf`);
  const artifacts: BuildSummary['artifacts'] = { axf };
  if (options.target.createHex) {
    const hex = path.join(options.target.outputDir, `${options.target.outputName}.hex`);
    if (fs.existsSync(hex)) {
      artifacts.hex = hex;
    }
  }
  if (!success && result.parsed.errors === 0) {
    result.parsed.diagnostics.unshift({
      severity: 'error',
      message: `uVision build failed: ${uv4ExitDescription(result.exitCode)}`,
    });
    result.parsed.errors = 1;
  }

  options.log(
    `Build ${success ? 'succeeded' : 'failed'} (uVision): ${result.parsed.errors} error(s), ${result.parsed.warnings} warning(s).`
  );

  return {
    success,
    engine: 'uv4',
    errors: success ? 0 : Math.max(1, result.parsed.errors),
    warnings: result.parsed.warnings,
    diagnostics: result.parsed.diagnostics,
    artifacts,
    compiled: 0,
    skipped: 0,
    durationMs: Date.now() - started,
    commands: [commandLine],
    cancelled: result.timedOut,
  };
}

/** Format the UV4 version macro once, used in the "show commands" view. */
export function versionMacroFor(install: NativeBuildOptions['install']): string {
  return uvisionVersionDefine(install) ?? '(unknown uVision version)';
}
