/**
 * Reader for µVision project files (*.uvprojx / *.uvproj) and option files
 * (*.uvoptx).  The goal is a faithful, typed representation of everything the
 * build engine, the tree view, IntelliSense and the debug configuration
 * generator need.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  XMLElement,
  parseXML,
  child,
  children,
  childPath,
  childText,
  pathText,
  pathNumber,
  pathBool,
} from './xml';

export type FileKind = 'c' | 'cpp' | 'asm' | 'object' | 'library' | 'scatter' | 'other';

export interface MemoryRange {
  name: string;
  type: number;
  start: number;
  size: number;
}

export interface DeviceInfo {
  name: string;
  vendor: string;
  packId: string;
  packUrl: string;
  /** Raw `Cpu` string, e.g. `IRAM(...) IROM(...) CPUTYPE("Cortex-M3") ...`. */
  cpuRaw: string;
  /** e.g. `Cortex-M3`. */
  cpuType: string;
  /** `none`, `single` or `double`. */
  fpu: 'none' | 'single' | 'double';
  endian: 'little' | 'big';
  clockHz: number;
  irom: MemoryRange[];
  iram: MemoryRange[];
  registerFile: string;
  svdFile: string;
  flashDriver: string;
}

export interface CompilerOptions {
  interwork: boolean;
  optimize: number;
  optimizeForTime: boolean;
  splitSections: boolean;
  c99: boolean;
  gnu: boolean;
  ropi: boolean;
  rwpi: boolean;
  warningLevel: number;
  shortEnums: boolean;
  plainChar: boolean;
  unsignedChar: boolean;
  shortWchar: boolean;
  lang: number;
  langP: number;
  lto: boolean;
  rtti: boolean;
  defines: string[];
  undefines: string[];
  includes: string[];
  misc: string;
}

export interface AssemblerOptions {
  interwork: boolean;
  ropi: boolean;
  rwpi: boolean;
  thumb: boolean;
  splitSections: boolean;
  noWarn: boolean;
  defines: string[];
  undefines: string[];
  includes: string[];
  misc: string;
}

export interface LinkerOptions {
  useMemoryLayout: boolean;
  ropi: boolean;
  rwpi: boolean;
  noStartup: boolean;
  noStandardLib: boolean;
  useFile: boolean;
  scatterFile: string;
  textAddress: number;
  dataAddress: number;
  defines: string[];
  includes: string[];
  misc: string;
}

export interface UserProgram {
  enabled: boolean;
  command: string;
}

export interface UVFile {
  name: string;
  /** Absolute path. */
  path: string;
  /** Raw FileType value from the project file. */
  type: number;
  kind: FileKind;
  includeInBuild: boolean;
  defines: string[];
  undefines: string[];
  includes: string[];
  misc: string;
}

export interface UVGroup {
  name: string;
  files: UVFile[];
}

export interface UVTarget {
  project: UVProject;
  name: string;
  uAC6: boolean;
  uVisionVersion: string;
  device: DeviceInfo;
  outputDir: string;
  outputName: string;
  listingDir: string;
  createHex: boolean;
  createLib: boolean;
  createExecutable: boolean;
  debugInformation: boolean;
  hexFormat: number;
  merge32K: boolean;
  useMicrolib: boolean;
  compiler: CompilerOptions;
  assembler: AssemblerOptions;
  linker: LinkerOptions;
  memories: MemoryRange[];
  groups: UVGroup[];
  programs: {
    beforeCompile: UserProgram[];
    beforeMake: UserProgram[];
    afterMake: UserProgram[];
  };
}

export interface UVProject {
  filePath: string;
  dir: string;
  name: string;
  schemaVersion: string;
  targets: UVTarget[];
  /** True when the project references CMSIS-Pack (RTE) components. */
  usesRte: boolean;
  loadedAt: number;
}

export interface UVOptTarget {
  name: string;
  /** Debugger driver, e.g. `BIN\\CMSIS_AGDI.dll`. */
  driver: string;
  simulate: boolean;
  targetSelection: number;
}

export interface UVOpt {
  filePath: string;
  targets: UVOptTarget[];
}

const CPU_TYPE_PATTERN = /CPUTYPE\s*\(\s*"([^"]+)"\s*\)/i;
const MEMORY_PATTERN = /\b(IROM\d*|IRAM\d*|IROM|IRAM)\s*\(\s*([^)]+)\)/gi;

function asBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

function splitList(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolvePath(baseDir: string, value: string): string {
  if (!value) {
    return '';
  }
  const unquoted = value.replace(/^"(.*)"$/, '$1');
  return path.isAbsolute(unquoted) ? path.normalize(unquoted) : path.resolve(baseDir, unquoted);
}

function parseMemoryRange(name: string, raw: string, type: number): MemoryRange {
  const parts = splitList(raw, ',');
  const start = Number.parseInt(parts[0] ?? '0', 0);
  const size = Number.parseInt(parts[1] ?? '0', 0);
  return {
    name,
    type,
    start: Number.isFinite(start) ? start : 0,
    size: Number.isFinite(size) ? size : 0,
  };
}

function parseCpu(cpuRaw: string): { cpuType: string; irom: MemoryRange[]; iram: MemoryRange[] } {
  const cpuMatch = CPU_TYPE_PATTERN.exec(cpuRaw);
  const irom: MemoryRange[] = [];
  const iram: MemoryRange[] = [];
  MEMORY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEMORY_PATTERN.exec(cpuRaw)) !== null) {
    const name = match[1].toUpperCase();
    const range = parseMemoryRange(name, match[2], name.startsWith('IROM') ? 1 : 0);
    if (name.startsWith('IROM')) {
      irom.push(range);
    } else if (name.startsWith('IRAM')) {
      iram.push(range);
    }
  }
  return { cpuType: cpuMatch ? cpuMatch[1] : '', irom, iram };
}

function parseFpu(cpuRaw: string): 'none' | 'single' | 'double' {
  if (/\bFPU3\b|\bFPU3\s*\(/.test(cpuRaw)) {
    return 'double';
  }
  if (/\bFPU2\b|\bFPU2\s*\(|\bFPU\b/.test(cpuRaw)) {
    return 'single';
  }
  return 'none';
}

function classifyFile(filePath: string, type: number): FileKind {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.c':
      return 'c';
    case '.cpp':
    case '.cxx':
    case '.cc':
    case '.c++':
      return 'cpp';
    case '.s':
    case '.asm':
    case '.src':
      return 'asm';
    case '.o':
    case '.obj':
      return 'object';
    case '.lib':
    case '.a':
      return 'library';
    case '.sct':
      return 'scatter';
    case '.txt':
    case '.md':
    case '.h':
    case '.hpp':
      return 'other';
    default:
      if (type === 2) {
        return 'asm';
      }
      if (type === 3) {
        return 'object';
      }
      if (type === 4) {
        return 'library';
      }
      if (type === 5) {
        return 'other';
      }
      return 'other';
  }
}

function parseCompilerOptions(node: XMLElement | undefined): CompilerOptions {
  return {
    interwork: pathBool(node, 'interw'),
    optimize: pathNumber(node, 'Optim', 0),
    optimizeForTime: pathBool(node, 'oTime'),
    splitSections: pathBool(node, 'OneElfS') || pathBool(node, 'SplitLS'),
    c99: pathBool(node, 'uC99'),
    gnu: pathBool(node, 'uGnu'),
    ropi: pathBool(node, 'Ropi'),
    rwpi: pathBool(node, 'Rwpi'),
    warningLevel: pathNumber(node, 'wLevel', 0),
    shortEnums: pathBool(node, 'vShortEn'),
    plainChar: pathBool(node, 'PlainCh'),
    unsignedChar: pathBool(node, 'uGnu'),
    shortWchar: pathBool(node, 'vShortWch'),
    lang: pathNumber(node, 'v6Lang', 3),
    langP: pathNumber(node, 'v6LangP', 3),
    lto: pathBool(node, 'v6Lto'),
    rtti: pathBool(node, 'v6Rtti'),
    defines: splitList(pathText(node, 'VariousControls/Define'), ','),
    undefines: splitList(pathText(node, 'VariousControls/Undefine'), ','),
    includes: splitList(pathText(node, 'VariousControls/IncludePath'), ';'),
    misc: pathText(node, 'VariousControls/MiscControls'),
  };
}

function parseAssemblerOptions(node: XMLElement | undefined): AssemblerOptions {
  return {
    interwork: pathBool(node, 'interw'),
    ropi: pathBool(node, 'Ropi'),
    rwpi: pathBool(node, 'Rwpi'),
    thumb: pathBool(node, 'thumb'),
    splitSections: pathBool(node, 'SplitLS'),
    noWarn: pathBool(node, 'NoWarn'),
    defines: splitList(pathText(node, 'VariousControls/Define'), ','),
    undefines: splitList(pathText(node, 'VariousControls/Undefine'), ','),
    includes: splitList(pathText(node, 'VariousControls/IncludePath'), ';'),
    misc: pathText(node, 'VariousControls/MiscControls'),
  };
}

function parseLinkerOptions(node: XMLElement | undefined): LinkerOptions {
  return {
    useMemoryLayout: pathBool(node, 'umfTarg', true),
    ropi: pathBool(node, 'Ropi'),
    rwpi: pathBool(node, 'Rwpi'),
    noStartup: pathBool(node, 'noStLib'),
    noStandardLib: pathBool(node, 'noStLib'),
    useFile: pathBool(node, 'useFile'),
    scatterFile: pathText(node, 'ScatterFile'),
    textAddress: Number.parseInt(pathText(node, 'TextAddressRange', '0'), 0) || 0,
    dataAddress: Number.parseInt(pathText(node, 'DataAddressRange', '0'), 0) || 0,
    defines: splitList(pathText(node, 'VariousControls/Define'), ','),
    includes: splitList(pathText(node, 'VariousControls/IncludePath'), ';'),
    misc: pathText(node, 'VariousControls/MiscControls'),
  };
}

function parseUserPrograms(targetOption: XMLElement | undefined): UVTarget['programs'] {
  const read = (section: string): UserProgram[] => {
    const element = child(targetOption, section);
    const programs: UserProgram[] = [];
    for (const index of [1, 2]) {
      const enabled = pathBool(element, `RunUserProg${index}`);
      const command = pathText(element, `UserProg${index}Name`);
      if (enabled && command) {
        programs.push({ enabled, command });
      }
    }
    return programs;
  };
  return {
    beforeCompile: read('BeforeCompile'),
    beforeMake: read('BeforeMake'),
    afterMake: read('AfterMake'),
  };
}

function parseMemoryElements(misc: XMLElement | undefined): MemoryRange[] {
  const onChip = child(misc, 'OnChipMemories');
  if (!onChip) {
    return [];
  }
  const ranges: MemoryRange[] = [];
  for (const node of onChip.children) {
    const type = pathNumber(node, 'Type', 0);
    const start = Number.parseInt(pathText(node, 'StartAddress', '0'), 0) || 0;
    const size = Number.parseInt(pathText(node, 'Size', '0'), 0) || 0;
    if (size <= 0) {
      continue;
    }
    ranges.push({ name: node.name, type, start, size });
  }
  return ranges;
}

function parseFile(fileNode: XMLElement, projectDir: string): UVFile {
  const name = childText(fileNode, 'FileName');
  const rawPath = childText(fileNode, 'FilePath') || name;
  const filePath = resolvePath(projectDir, rawPath);
  const type = pathNumber(fileNode, 'FileType', 0);
  const common = childPath(fileNode, 'FileOption/CommonProperty');
  const armAds = childPath(fileNode, 'FileOption/FileArmAds');
  const cads = child(armAds, 'Cads');
  const aads = child(armAds, 'Aads');
  const ldads = child(armAds, 'LDads');
  const optionNode = cads ?? aads ?? ldads;
  const defines = splitList(pathText(optionNode, 'VariousControls/Define'), ',');
  return {
    name: name || path.basename(filePath),
    path: filePath,
    type,
    kind: classifyFile(filePath, type),
    includeInBuild: pathBool(common, 'IncludeInBuild', true),
    defines,
    undefines: splitList(pathText(optionNode, 'VariousControls/Undefine'), ','),
    includes: splitList(pathText(optionNode, 'VariousControls/IncludePath'), ';'),
    misc: pathText(optionNode, 'VariousControls/MiscControls'),
  };
}

function parseGroups(targetNode: XMLElement, projectDir: string): UVGroup[] {
  const groupsNode = child(targetNode, 'Groups');
  if (!groupsNode) {
    return [];
  }
  return children(groupsNode, 'Group').map((groupNode) => {
    const files = children(child(groupNode, 'Files'), 'File').map((fileNode) =>
      parseFile(fileNode, projectDir)
    );
    return { name: childText(groupNode, 'GroupName', 'Group'), files };
  });
}

function parseTarget(targetNode: XMLElement, project: UVProject): UVTarget {
  const name = childText(targetNode, 'TargetName', 'Target');
  const option = child(targetNode, 'TargetOption');
  const common = child(option, 'TargetCommonOption');
  const armAds = child(option, 'TargetArmAds');
  const misc = child(armAds, 'ArmAdsMisc');
  const cpuRaw = childText(common, 'Cpu');
  const cpu = parseCpu(cpuRaw);
  const memories = parseMemoryElements(misc);
  const irom = memories.filter((memory) => memory.type === 1 && memory.size > 0);
  const iram = memories.filter((memory) => memory.type === 0 && memory.size > 0);

  const outputDirRaw = childText(common, 'OutputDirectory', '.\\Objects\\');
  const listingDirRaw = childText(common, 'ListingPath', '.\\Listings\\');
  const device: DeviceInfo = {
    name: childText(common, 'Device'),
    vendor: childText(common, 'Vendor'),
    packId: childText(common, 'PackID'),
    packUrl: childText(common, 'PackURL'),
    cpuRaw,
    cpuType: cpu.cpuType,
    fpu: parseFpu(cpuRaw),
    endian: /EBIG/i.test(cpuRaw) ? 'big' : 'little',
    clockHz: Number.parseInt(/CLOCK\s*\(\s*([^)]+)\)/i.exec(cpuRaw)?.[1] ?? '0', 0) || 0,
    irom: irom.length > 0 ? irom : cpu.irom,
    iram: iram.length > 0 ? iram : cpu.iram,
    registerFile: childText(common, 'RegisterFile'),
    svdFile: childText(common, 'SFDFile'),
    flashDriver: childText(common, 'FlashDriverDll'),
  };

  return {
    project,
    name,
    uAC6: pathBool(targetNode, 'uAC6'),
    uVisionVersion: childText(targetNode, 'pCCUsed'),
    device,
    outputDir: resolvePath(project.dir, outputDirRaw),
    outputName: childText(common, 'OutputName', 'output'),
    listingDir: resolvePath(project.dir, listingDirRaw),
    createHex: pathBool(common, 'CreateHexFile'),
    createLib: pathBool(common, 'CreateLib'),
    createExecutable: pathBool(common, 'CreateExecutable', true),
    debugInformation: pathBool(common, 'DebugInformation', true),
    hexFormat: pathNumber(common, 'HexFormatSelection', 1),
    merge32K: pathBool(common, 'Merge32K'),
    useMicrolib: pathBool(misc, 'useUlib'),
    compiler: parseCompilerOptions(child(armAds, 'Cads')),
    assembler: parseAssemblerOptions(child(armAds, 'Aads')),
    linker: parseLinkerOptions(child(armAds, 'LDads')),
    memories,
    groups: parseGroups(targetNode, project.dir),
    programs: parseUserPrograms(common),
  };
}

export function parseUVProject(filePath: string): UVProject {
  const source = fs.readFileSync(filePath, 'utf8');
  const root = parseXML(source);
  const dir = path.dirname(filePath);
  const project: UVProject = {
    filePath,
    dir,
    name: path.basename(filePath, path.extname(filePath)),
    schemaVersion: childText(root, 'SchemaVersion'),
    targets: [],
    usesRte: false,
    loadedAt: Date.now(),
  };

  const rteNode = child(root, 'RTE');
  if (rteNode) {
    const componentNode = child(rteNode, 'components');
    const componentCount = children(componentNode, 'component').length;
    const rteFiles = children(child(rteNode, 'files'), 'file').filter((fileNode) =>
      children(fileNode, 'instance').some((instance) => instance.attributes.removed !== '1' && instance.text.trim().length > 0)
    );
    project.usesRte = componentCount > 0 || rteFiles.length > 0;
  }

  const targetsNode = child(root, 'Targets');
  project.targets = children(targetsNode, 'Target').map((targetNode) => parseTarget(targetNode, project));
  if (!project.usesRte) {
    project.usesRte = project.targets.some((target) =>
      target.groups.some((group) =>
        group.files.some((file) => /(^|[\\/])RTE[\\/]/i.test(file.path))
      )
    );
  }
  return project;
}

export function parseUVOpt(filePath: string): UVOpt {
  const opt: UVOpt = { filePath, targets: [] };
  if (!fs.existsSync(filePath)) {
    return opt;
  }
  try {
    const root = parseXML(fs.readFileSync(filePath, 'utf8'));
    const targetNodes = children(root, 'Target');
    if (targetNodes.length === 0) {
      targetNodes.push(...children(child(root, 'Targets'), 'Target'));
    }
    for (const targetNode of targetNodes) {
      const name = childText(targetNode, 'TargetName');
      const debug = childPath(targetNode, 'TargetOption/DebugOpt');
      opt.targets.push({
        name,
        driver: childText(debug, 'pMon'),
        simulate: pathBool(debug, 'uSim'),
        targetSelection: pathNumber(debug, 'nTsel', 0),
      });
    }
  } catch {
    // A broken .uvoptx must never prevent the project from loading.
  }
  return opt;
}

/** Locate the .uvoptx that belongs to a .uvprojx. */
export function findUVOptPath(projectFile: string): string {
  const candidate = projectFile.replace(/\.uvprojx?$/i, '.uvoptx');
  return fs.existsSync(candidate) ? candidate : '';
}

export function targetFiles(target: UVTarget): UVFile[] {
  return target.groups.flatMap((group) => group.files);
}

export function buildableFiles(target: UVTarget): UVFile[] {
  return targetFiles(target).filter(
    (file) => file.includeInBuild && (file.kind === 'c' || file.kind === 'cpp' || file.kind === 'asm')
  );
}

export function absoluteIncludes(target: UVTarget, list: string[]): string[] {
  return dedupe(
    list
      .map((entry) => resolvePath(target.project.dir, entry))
      .filter((entry) => entry.length > 0)
  );
}

export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
