/**
 * Native build engine: compiles and links a µVision target by invoking the ARM
 * toolchain directly, without starting uVision.
 *
 * This is the "port" of the µVision build pipeline.  It reproduces the command
 * lines µVision itself generates (see commands.ts) and implements incremental
 * builds through the dependency files armcc/armclang emit.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  BuildContext,
  CommandSpec,
  archiveCommand,
  compileCommand,
  describeCommand,
  fromelfCommand,
  linkCommand,
} from './commands';
import { DiagnosticEntry, parseOutput } from './diagnostics';
import { KeilInstall, PackInfo } from './tools';
import { UVFile, UVGroup, UVProject, UVTarget, buildableFiles, targetFiles } from './uvprojx';

export interface BuildLogger {
  (line: string): void;
}

export interface CancellationToken {
  isCancellationRequested: boolean;
}

export interface BuildArtifacts {
  axf?: string;
  hex?: string;
  lib?: string;
  map?: string;
}

export interface BuildSummary {
  success: boolean;
  engine: 'native' | 'uv4';
  errors: number;
  warnings: number;
  diagnostics: DiagnosticEntry[];
  artifacts: BuildArtifacts;
  compiled: number;
  skipped: number;
  durationMs: number;
  commands: string[];
  programSize?: string;
  cancelled?: boolean;
}

export interface NativeBuildOptions {
  install: KeilInstall;
  project: UVProject;
  target: UVTarget;
  pack?: PackInfo;
  jobs: number;
  cleanFirst: boolean;
  extraDefines: string[];
  extraIncludes: string[];
  log: BuildLogger;
  token?: CancellationToken;
}

interface RunResult {
  code: number;
  output: string;
}

const COMPILE_TIMEOUT_MS = 10 * 60 * 1000;
const LINK_TIMEOUT_MS = 10 * 60 * 1000;

function runCommand(spec: CommandSpec, timeoutMs: number, token?: CancellationToken): Promise<RunResult> {
  return new Promise((resolve) => {
    if (token?.isCancellationRequested) {
      resolve({ code: -1, output: 'Cancelled' });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (code: number): void => {
      if (!settled) {
        settled = true;
        resolve({ code, output });
      }
    };
    let child;
    try {
      child = spawn(spec.tool, spec.args, {
        cwd: spec.cwd,
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      finish(-1);
      resolve({ code: -1, output: `Failed to start ${spec.tool}: ${String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      output += `\nError: command timed out after ${Math.round(timeoutMs / 1000)}s\n`;
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(-1);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      output += `\nFailed to start ${spec.tool}: ${error.message}\n`;
      finish(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function fileMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readDependencies(depFile: string): string[] {
  try {
    const text = fs.readFileSync(depFile, 'utf8');
    const joined = text.replace(/\\\r?\n/g, ' ');
    const colonIndex = joined.indexOf(':');
    if (colonIndex < 0) {
      return [];
    }
    return joined
      .slice(colonIndex + 1)
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

/** Extract the "Program Size" summary uVision prints after a successful link. */
export function readProgramSize(mapFile: string): string | undefined {
  try {
    const text = fs.readFileSync(mapFile, 'utf8');
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+Grand Totals/m.exec(text);
    if (!match) {
      return undefined;
    }
    return `Program Size: Code=${match[1]} RO-data=${match[3]} RW-data=${match[4]} ZI-data=${match[5]}`;
  } catch {
    return undefined;
  }
}

export interface ObjectTarget {
  file: UVFile;
  group: UVGroup;
  objectRel: string;
  depRel: string;
}

/** Assign a unique object file name (µVision flattens the folder structure). */
export function objectTargets(target: UVTarget): ObjectTarget[] {
  const used = new Map<string, number>();
  const result: ObjectTarget[] = [];
  const outputRel = path.relative(target.project.dir, target.outputDir) || '.';
  const files: Array<{ file: UVFile; group: UVGroup }> = [];
  for (const group of target.groups) {
    for (const file of group.files) {
      files.push({ file, group });
    }
  }
  files.sort((left, right) => left.file.path.localeCompare(right.file.path));
  for (const entry of files) {
    if (!entry.file.includeInBuild || !['c', 'cpp', 'asm'].includes(entry.file.kind)) {
      continue;
    }
    const base = path.basename(entry.file.path, path.extname(entry.file.path)).replace(/[^\w.\-]/g, '_');
    const count = used.get(base.toLowerCase()) ?? 0;
    used.set(base.toLowerCase(), count + 1);
    const name = `${base}${count > 0 ? `_${count + 1}` : ''}.o`;
    result.push({
      file: entry.file,
      group: entry.group,
      objectRel: path.join(outputRel, name),
      depRel: path.join(outputRel, `${path.basename(name, '.o')}.d`),
    });
  }
  return result;
}

/** Object/library files referenced by the project that are linked as-is. */
export function prebuiltLinkInputs(target: UVTarget): string[] {
  const inputs: string[] = [];
  for (const file of targetFiles(target)) {
    if (!file.includeInBuild || (file.kind !== 'object' && file.kind !== 'library')) {
      continue;
    }
    if (!fs.existsSync(file.path)) {
      continue;
    }
    inputs.push(path.relative(target.project.dir, file.path));
  }
  return inputs;
}

function scatterContent(target: UVTarget): string | undefined {
  const rom = target.device.irom.find((range) => range.size > 0);
  const ram = target.device.iram.find((range) => range.size > 0);
  if (!rom || !ram) {
    return undefined;
  }
  const hex = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
  return [
    `; Generated by Keil MDK Tools for target "${target.name}"`,
    `LR_IROM1 ${hex(rom.start)} ${hex(rom.size)}  {`,
    `  ER_IROM1 ${hex(rom.start)} ${hex(rom.size)}  {`,
    '   *.o (RESET, +First)',
    '   *(InRoot$$Sections)',
    '   .ANY (+RO)',
    '   .ANY (+XO)',
    '  }',
    `  RW_IRAM1 ${hex(ram.start)} ${hex(ram.size)}  {`,
    '   .ANY (+RW +ZI)',
    '  }',
    '}',
    '',
  ].join('\r\n');
}

export function effectiveScatterFile(target: UVTarget): string | undefined {
  if (target.linker.useFile && target.linker.scatterFile) {
    const resolved = path.isAbsolute(target.linker.scatterFile)
      ? target.linker.scatterFile
      : path.resolve(target.project.dir, target.linker.scatterFile);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

export function outputPaths(target: UVTarget): {
  axf: string;
  hex: string;
  lib: string;
  map: string;
  scatter: string;
  lnp: string;
} {
  const outputDir = target.outputDir;
  return {
    axf: path.join(outputDir, `${target.outputName}.axf`),
    hex: path.join(outputDir, `${target.outputName}.hex`),
    lib: path.join(outputDir, `${target.outputName}.lib`),
    map: path.join(target.listingDir, `${target.outputName}.map`),
    scatter: path.join(outputDir, `${target.outputName}.sct`),
    lnp: path.join(outputDir, `${target.outputName}.lnp`),
  };
}

function makeContext(options: NativeBuildOptions): BuildContext {
  return {
    install: options.install,
    target: options.target,
    pack: options.pack,
    extraDefines: options.extraDefines,
    extraIncludes: options.extraIncludes,
  };
}

/** Produce the full command list without running anything (for diagnostics). */
export function planNativeCommands(options: NativeBuildOptions): { commands: CommandSpec[]; scatter?: string } {
  const context = makeContext(options);
  const target = options.target;
  const outputs = outputPaths(target);
  const commands: CommandSpec[] = [];
  const objects = objectTargets(target);
  const scatter = target.linker.useFile ? effectiveScatterFile(target) : undefined;
  const generatedScatter = scatter ? undefined : scatterContent(target);

  for (const entry of objects) {
    commands.push(compileCommand(context, entry.file, entry.objectRel, entry.depRel));
  }
  if (target.createExecutable) {
    commands.push(
      linkCommand(context, {
        objects: [...objects.map((entry) => entry.objectRel), ...prebuiltLinkInputs(target)],
        scatterFile: scatter ?? (generatedScatter ? outputs.scatter : undefined),
        mapFile: path.relative(target.project.dir, outputs.map),
        outputFile: path.relative(target.project.dir, outputs.axf),
        responseFile: outputs.lnp,
      })
    );
  }
  if (target.createLib) {
    commands.push(archiveCommand(context, path.relative(target.project.dir, outputs.lib), objects.map((entry) => entry.objectRel)));
  }
  if (target.createHex && target.createExecutable) {
    commands.push(fromelfCommand(context, 'hex', path.relative(target.project.dir, outputs.hex), path.relative(target.project.dir, outputs.axf)));
  }
  return { commands, scatter: generatedScatter };
}

async function runUserPrograms(
  target: UVTarget,
  programs: Array<{ enabled: boolean; command: string }>,
  log: BuildLogger
): Promise<void> {
  for (const program of programs) {
    if (!program.enabled || !program.command.trim()) {
      continue;
    }
    log(`User command: ${program.command}`);
    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn('cmd.exe', ['/d', '/c', program.command], {
        cwd: target.project.dir,
        windowsHide: true,
        env: process.env,
      });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
      child.on('close', (code) => resolve({ code: code ?? -1, output }));
    });
    if (result.output.trim()) {
      for (const line of result.output.trim().split(/\r?\n/)) {
        log(`  ${line}`);
      }
    }
    if (result.code !== 0) {
      log(`  (exit code ${result.code})`);
    }
  }
}

export function cleanNative(target: UVTarget, log: BuildLogger): void {
  log(`Cleaning target '${target.name}' (${target.outputDir})`);
  rmDir(target.outputDir);
  rmDir(target.listingDir);
}

export async function buildNative(options: NativeBuildOptions): Promise<BuildSummary> {
  const started = Date.now();
  const target = options.target;
  const context = makeContext(options);
  const outputs = outputPaths(target);
  const commands: string[] = [];
  const diagnostics: DiagnosticEntry[] = [];
  let errors = 0;
  let warnings = 0;
  let compiled = 0;
  let skipped = 0;
  let cancelled = false;

  const log = options.log;

  if (options.cleanFirst) {
    cleanNative(target, log);
  }
  ensureDir(target.outputDir);
  ensureDir(target.listingDir);

  const entries = objectTargets(target);
  log(`Native build: ${entries.length} source file(s), target '${target.name}' (${target.uAC6 ? 'AC6' : 'AC5'})`);

  await runUserPrograms(target, target.programs.beforeCompile, log);

  const queue: ObjectTarget[] = [];
  for (const entry of entries) {
    const sourceTime = fileMtime(entry.file.path);
    const objectTime = fileMtime(path.join(target.project.dir, entry.objectRel));
    let upToDate = false;
    if (sourceTime > 0 && objectTime >= sourceTime) {
      const deps = readDependencies(path.join(target.project.dir, entry.depRel));
      upToDate = deps.length === 0 ? true : deps.every((dep) => fileMtime(path.resolve(target.project.dir, dep)) <= objectTime);
    }
    if (upToDate) {
      skipped++;
      continue;
    }
    queue.push(entry);
  }

  const jobs = Math.max(1, Math.min(options.jobs || 1, 16));
  let active = 0;
  let index = 0;

  await new Promise<void>((resolve) => {
    const next = (): void => {
      if (options.token?.isCancellationRequested) {
        cancelled = true;
        if (active === 0) {
          resolve();
        }
        return;
      }
      if (index >= queue.length && active === 0) {
        resolve();
        return;
      }
      while (active < jobs && index < queue.length) {
        const entry = queue[index++];
        active++;
        const spec = compileCommand(context, entry.file, entry.objectRel, entry.depRel);
        const commandText = describeCommand(spec);
        commands.push(commandText);
        log(`${entry.group.name}: ${spec.label} ...`);
        runCommand(spec, COMPILE_TIMEOUT_MS, options.token)
          .then((result) => {
            if (result.code !== 0) {
              log(`  ${spec.label} failed (exit code ${result.code})`);
            }
            const parsed = parseOutput(result.output, { projectDir: target.project.dir });
            diagnostics.push(...parsed.diagnostics);
            errors += parsed.errors;
            warnings += parsed.warnings;
            if (result.output.trim()) {
              for (const line of result.output.trim().split(/\r?\n/)) {
                if (line.trim()) {
                  log(`  ${line}`);
                }
              }
            }
            if (result.code !== 0 && parsed.errors === 0) {
              diagnostics.push({
                severity: 'error',
                message: `${spec.label} failed (exit code ${result.code}). ${result.output.split(/\r?\n/).find((line) => line.trim()) ?? ''}`.trim(),
              });
              errors++;
            }
            compiled++;
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });

  if (cancelled) {
    return {
      success: false,
      engine: 'native',
      errors,
      warnings,
      diagnostics,
      artifacts: {},
      compiled,
      skipped,
      durationMs: Date.now() - started,
      commands,
      cancelled: true,
    };
  }

  if (errors > 0) {
    log(`Build failed: ${errors} error(s), ${warnings} warning(s).`);
    return {
      success: false,
      engine: 'native',
      errors,
      warnings,
      diagnostics,
      artifacts: {},
      compiled,
      skipped,
      durationMs: Date.now() - started,
      commands,
    };
  }

  const artifacts: BuildArtifacts = { axf: outputs.axf, map: outputs.map };
  const objects = entries.map((entry) => entry.objectRel);
  const linkObjects = [...objects, ...prebuiltLinkInputs(target)];
  let programSize: string | undefined;

  if (target.createExecutable) {
    const scatter = target.linker.useFile ? effectiveScatterFile(target) : undefined;
    let scatterPath: string | undefined = scatter;
    if (!scatterPath) {
      const generated = scatterContent(target);
      if (generated) {
        fs.writeFileSync(outputs.scatter, generated, 'utf8');
        scatterPath = outputs.scatter;
      }
    }
    const needLink = compiled > 0 || !fs.existsSync(outputs.axf) || !fs.existsSync(outputs.map);
    if (needLink) {
      const spec = linkCommand(context, {
        objects: linkObjects,
        scatterFile: scatterPath,
        mapFile: path.relative(target.project.dir, outputs.map),
        outputFile: path.relative(target.project.dir, outputs.axf),
        responseFile: path.relative(target.project.dir, outputs.lnp),
      });
      commands.push(describeCommand(spec));
      log(`Linking ${path.basename(outputs.axf)} ...`);
      const result = await runCommand(spec, LINK_TIMEOUT_MS, options.token);
      for (const line of result.output.trim().split(/\r?\n/)) {
        if (line.trim()) {
          log(`  ${line}`);
        }
      }
      const parsed = parseOutput(result.output, { projectDir: target.project.dir });
      diagnostics.push(...parsed.diagnostics);
      errors += parsed.errors;
      warnings += parsed.warnings;
      if (result.code !== 0 || parsed.errors > 0) {
        if (parsed.errors === 0) {
          diagnostics.push({ severity: 'error', message: `armlink failed (exit code ${result.code})` });
          errors++;
        }
        log(`Build failed: linker reported errors.`);
        return {
          success: false,
          engine: 'native',
          errors,
          warnings,
          diagnostics,
          artifacts,
          compiled,
          skipped,
          durationMs: Date.now() - started,
          commands,
        };
      }
    } else {
      log('Target is up to date - nothing to link.');
    }

    programSize = readProgramSize(outputs.map);
    if (programSize) {
      log(programSize);
    }

    if (target.createHex && (needLink || !fs.existsSync(outputs.hex))) {
      const hexSpec = fromelfCommand(
        context,
        'hex',
        path.relative(target.project.dir, outputs.hex),
        path.relative(target.project.dir, outputs.axf)
      );
      commands.push(describeCommand(hexSpec));
      log(`Creating HEX file ${path.basename(outputs.hex)} ...`);
      const hexResult = await runCommand(hexSpec, LINK_TIMEOUT_MS, options.token);
      if (hexResult.code !== 0) {
        warnings++;
        diagnostics.push({
          severity: 'warning',
          message: `fromelf failed to create ${path.basename(outputs.hex)} (exit code ${hexResult.code})`,
        });
        log(`  ${hexResult.output.trim()}`);
      } else {
        artifacts.hex = outputs.hex;
      }
    } else if (target.createHex) {
      artifacts.hex = outputs.hex;
    }

    if (fs.existsSync(outputs.axf)) {
      artifacts.axf = outputs.axf;
    }
  }

  if (target.createLib && !target.createExecutable) {
    const spec = archiveCommand(context, path.relative(target.project.dir, outputs.lib), objects);
    commands.push(describeCommand(spec));
    log(`Creating library ${path.basename(outputs.lib)} ...`);
    const result = await runCommand(spec, LINK_TIMEOUT_MS, options.token);
    if (result.code !== 0) {
      errors++;
      diagnostics.push({ severity: 'error', message: `armar failed (exit code ${result.code})` });
    } else {
      artifacts.lib = outputs.lib;
    }
  }

  await runUserPrograms(target, target.programs.afterMake, log);

  log(
    `Build ${errors === 0 ? 'succeeded' : 'failed'}: ${compiled} compiled, ${skipped} up to date, ` +
      `${errors} error(s), ${warnings} warning(s).`
  );

  return {
    success: errors === 0,
    engine: 'native',
    errors,
    warnings,
    diagnostics,
    artifacts,
    compiled,
    skipped,
    durationMs: Date.now() - started,
    commands,
    programSize,
  };
}
