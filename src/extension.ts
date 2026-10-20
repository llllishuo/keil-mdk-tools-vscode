/**
 * Keil MDK Tools for Visual Studio Code.
 *
 * The extension ports the parts of the µVision IDE that matter in a code
 * editor: the project/target/file tree, building and rebuilding (either with
 * the ARM toolchain directly or through UV4.exe), download to flash,
 * IntelliSense configuration and Cortex-Debug launch configurations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import {
  KeilInstall,
  PackInfo,
  discoverInstall,
  resolvePack,
} from './core/tools';
import {
  UVFile,
  UVGroup,
  UVProject,
  UVTarget,
  buildableFiles,
  parseUVProject,
} from './core/uvprojx';
import { BuildContext } from './core/commands';
import { BuildEngineSetting, buildWithEngine } from './core/engine';
import { BuildSummary, NativeBuildOptions, cleanNative, planNativeCommands } from './core/nativeBuild';
import { buildIntellisenseConfiguration, mergeCppProperties } from './core/intellisense';
import {
  generateDebugConfiguration,
  mergeLaunchConfiguration,
} from './core/debugConfig';
import { interpretFlashResult, isUvisionAvailable, runUV4 } from './core/uv4';

const ACTIVE_TARGETS_KEY = 'keil.activeTargets';
const OPEN_PROJECTS_KEY = 'keil.openedProjects';
const LAST_PROJECT_KEY = 'keil.lastProject';

type NodeKind = 'project' | 'target' | 'group' | 'file';

interface ProjectNode {
  kind: 'project';
  project: UVProject;
}

interface TargetNode {
  kind: 'target';
  project: UVProject;
  target: UVTarget;
}

interface GroupNode {
  kind: 'group';
  project: UVProject;
  target: UVTarget;
  group: UVGroup;
}

interface FileNode {
  kind: 'file';
  project: UVProject;
  target: UVTarget;
  group: UVGroup;
  file: UVFile;
}

type KeilNode = ProjectNode | TargetNode | GroupNode | FileNode;

let extensionContext: vscode.ExtensionContext;
let output: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let treeProvider: KeilTreeProvider;
let statusTarget: vscode.StatusBarItem;
let statusBuild: vscode.StatusBarItem;
let install: KeilInstall | undefined;
let installLookupDone = false;
let buildInProgress = false;
let lastBuildSummary: BuildSummary | undefined;

const projects = new Map<string, UVProject>();
const intellisenseGenerated = new Set<string>();
let activeProjectKey: string | undefined;

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('keil');
}

function projectKey(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

function log(line: string): void {
  output?.appendLine(line);
}

function logBlock(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    log(line);
  }
}

function refreshTree(): void {
  treeProvider?.refresh();
  updateStatusBar();
}

function activeProject(): UVProject | undefined {
  if (activeProjectKey && projects.has(activeProjectKey)) {
    return projects.get(activeProjectKey);
  }
  const first = [...projects.values()][0];
  if (first) {
    activeProjectKey = projectKey(first.filePath);
  }
  return first;
}

function activeTarget(project: UVProject): UVTarget | undefined {
  const stored = extensionContext.workspaceState.get<Record<string, string>>(ACTIVE_TARGETS_KEY, {});
  const name = stored?.[projectKey(project.filePath)];
  return project.targets.find((target) => target.name === name) ?? project.targets[0];
}

async function setActiveTarget(project: UVProject, target: UVTarget): Promise<void> {
  const stored = { ...(extensionContext.workspaceState.get<Record<string, string>>(ACTIVE_TARGETS_KEY, {}) ?? {}) };
  stored[projectKey(project.filePath)] = target.name;
  await extensionContext.workspaceState.update(ACTIVE_TARGETS_KEY, stored);
  activeProjectKey = projectKey(project.filePath);
  await extensionContext.workspaceState.update(LAST_PROJECT_KEY, project.filePath);
  refreshTree();
  if (configuration().get<boolean>('intellisense.auto', true)) {
    void generateIntelliSenseForTarget(project, target, true);
  }
}

function openedProjectPaths(): string[] {
  return extensionContext.workspaceState.get<string[]>(OPEN_PROJECTS_KEY, []) ?? [];
}

async function addOpenedProject(filePath: string): Promise<void> {
  const list = openedProjectPaths();
  if (!list.some((entry) => projectKey(entry) === projectKey(filePath))) {
    list.push(filePath);
    await extensionContext.workspaceState.update(OPEN_PROJECTS_KEY, list);
  }
}

async function ensureInstall(force = false): Promise<KeilInstall | undefined> {
  if (install && !force) {
    return install;
  }
  const configuredRoot = configuration().get<string>('root', '').trim();
  install = await discoverInstall(configuredRoot || undefined);
  installLookupDone = true;
  updateStatusBar();
  return install;
}

function uv4Path(): string {
  const configured = configuration().get<string>('uv4.path', '').trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  return install?.uvisionExe ?? '';
}

function packFor(target: UVTarget): PackInfo | undefined {
  if (!install) {
    return undefined;
  }
  return resolvePack(install.packsRoot, target.device.packId);
}

function buildContext(target: UVTarget): BuildContext | undefined {
  if (!install) {
    return undefined;
  }
  return {
    install,
    target,
    pack: packFor(target),
    extraDefines: configuration().get<string[]>('build.extraDefines', []) ?? [],
    extraIncludes: configuration().get<string[]>('build.extraIncludes', []) ?? [],
  };
}

function loadProject(filePath: string, options: { silent?: boolean; activate?: boolean } = {}): UVProject | undefined {
  try {
    const project = parseUVProject(filePath);
    if (project.targets.length === 0) {
      throw new Error('the project does not contain any target');
    }
    projects.set(projectKey(filePath), project);
    if (options.activate || !activeProjectKey) {
      activeProjectKey = projectKey(filePath);
    }
    refreshTree();
    if (options.activate && configuration().get<boolean>('intellisense.auto', true)) {
      void generateIntelliSenseForTarget(project, activeTarget(project), true);
    }
    return project;
  } catch (error) {
    if (!options.silent) {
      void vscode.window.showErrorMessage(`Keil: cannot load ${path.basename(filePath)}: ${(error as Error).message}`);
    }
    return undefined;
  }
}

async function discoverProjects(): Promise<void> {
  const discovered: string[] = [];
  if (configuration().get<boolean>('tree.autoDiscover', true)) {
    const uris = await vscode.workspace.findFiles('**/*.uvprojx', '**/{node_modules,.git,Objects,Listings}/**', 100);
    discovered.push(...uris.map((uri) => uri.fsPath));
  }
  for (const saved of openedProjectPaths()) {
    if (fs.existsSync(saved)) {
      discovered.push(saved);
    }
  }
  for (const filePath of discovered) {
    if (!projects.has(projectKey(filePath))) {
      loadProject(filePath, { silent: true });
    }
  }
  const project = activeProject();
  if (project && configuration().get<boolean>('intellisense.auto', true)) {
    void generateIntelliSenseForTarget(project, activeTarget(project), true);
  }
  refreshTree();
}

function isUri(value: unknown): value is vscode.Uri {
  return Boolean(value) && typeof value === 'object' && typeof (value as vscode.Uri).fsPath === 'string';
}

function nodeProject(arg: unknown): UVProject | undefined {
  if (!arg) {
    return activeProject();
  }
  if (isUri(arg)) {
    const existing = projects.get(projectKey(arg.fsPath));
    if (existing) {
      return existing;
    }
    return loadProject(arg.fsPath, { silent: true });
  }
  const node = arg as KeilNode;
  if (node && typeof node === 'object' && 'kind' in node) {
    if (node.kind === 'project' || node.kind === 'target' || node.kind === 'group' || node.kind === 'file') {
      return node.project;
    }
  }
  return activeProject();
}

function nodeTarget(arg: unknown, project: UVProject): UVTarget | undefined {
  if (!arg) {
    return activeTarget(project);
  }
  const node = arg as KeilNode;
  if (node && typeof node === 'object' && ('target' in node) && node.target) {
    return node.target;
  }
  return activeTarget(project);
}

function applyDiagnostics(project: UVProject, summary: BuildSummary): void {
  diagnostics.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const entry of summary.diagnostics) {
    const filePath = entry.file || project.filePath;
    const line = Math.max(0, (entry.line ?? 1) - 1);
    const column = Math.max(0, (entry.column ?? 1) - 1);
    const range = new vscode.Range(line, column, line, column + 400);
    const severity =
      entry.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : entry.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const diagnostic = new vscode.Diagnostic(range, entry.message, severity);
    diagnostic.source = 'Keil';
    if (entry.code) {
      diagnostic.code = entry.code;
    }
    const key = filePath.toLowerCase();
    const list = byFile.get(key) ?? [];
    list.push(diagnostic);
    byFile.set(key, list);
  }
  for (const [filePath, list] of byFile) {
    diagnostics.set(vscode.Uri.file(filePath), list);
  }
}

function updateStatusBar(): void {
  if (!statusTarget) {
    return;
  }
  if (!install) {
    statusTarget.text = '$(warning) Keil';
    statusTarget.tooltip = 'Keil MDK installation not found. Click to configure keil.root.';
    statusTarget.command = 'keil.openSettings';
    statusTarget.show();
    return;
  }
  const project = activeProject();
  const target = project ? activeTarget(project) : undefined;
  if (!project || !target) {
    statusTarget.text = '$(circuit-board) Keil';
    statusTarget.tooltip = 'Keil MDK - open a .uvprojx project';
    statusTarget.command = 'keil.openProject';
  } else {
    statusTarget.text = `$(circuit-board) ${target.name}`;
    statusTarget.tooltip = new vscode.MarkdownString(
      [
        `**${path.basename(project.filePath)}**`,
        '',
        `- Target: ${target.name}`,
        `- Device: ${target.device.name || 'not set'} (${target.device.cpuType || 'unknown core'})`,
        `- Compiler: ${target.uAC6 ? 'ARM Compiler 6' : 'ARM Compiler 5'}`,
        `- Output: ${path.relative(project.dir, path.join(target.outputDir, target.outputName + '.axf'))}`,
        '',
        'Click to select the active target.',
      ].join('\n')
    );
    statusTarget.command = 'keil.selectTarget';
  }
  statusTarget.show();
}

class KeilTreeProvider implements vscode.TreeDataProvider<KeilNode> {
  private readonly emitter = new vscode.EventEmitter<KeilNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: KeilNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project': {
        const item = new vscode.TreeItem(
          path.basename(node.project.filePath),
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.contextValue = 'keilProject';
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.description = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? node.project.dir, node.project.dir) || '.';
        item.tooltip = new vscode.MarkdownString(
          `**${node.project.filePath}**\n\n${node.project.targets.length} target(s)\n\n` +
            (node.project.usesRte ? 'Uses CMSIS-Pack (RTE) components' : 'Self-contained project')
        );
        item.command = { command: 'vscode.open', title: 'Open project file', arguments: [vscode.Uri.file(node.project.filePath)] };
        return item;
      }
      case 'target': {
        const active = activeTarget(node.project)?.name === node.target.name;
        const item = new vscode.TreeItem(node.target.name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'keilTarget';
        item.iconPath = new vscode.ThemeIcon('circuit-board');
        const parts = [node.target.device.name || 'unknown device', node.target.uAC6 ? 'AC6' : 'AC5'];
        if (active) {
          parts.push('active');
        }
        item.description = parts.join(' - ');
        item.tooltip = new vscode.MarkdownString(
          [
            `**${node.target.name}**`,
            '',
            `- Core: ${node.target.device.cpuType || 'unknown'}`,
            `- Vendor: ${node.target.device.vendor || 'unknown'}`,
            `- Pack: ${node.target.device.packId || 'none'}`,
            `- Output: ${path.join(node.target.outputDir, node.target.outputName + '.axf')}`,
            `- Sources: ${buildableFiles(node.target).length}`,
          ].join('\n')
        );
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'keilGroup';
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = `${node.group.files.length}`;
        return item;
      }
      case 'file': {
        const icon = node.file.kind === 'library' || node.file.kind === 'object' ? 'file-binary' : 'file-code';
        const item = new vscode.TreeItem(node.file.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'keilFile';
        item.iconPath = new vscode.ThemeIcon(icon);
        item.description = node.file.includeInBuild ? '' : 'excluded';
        item.tooltip = `${node.file.path}\n${node.file.includeInBuild ? 'Included in build' : 'Excluded from build'}`;
        item.resourceUri = vscode.Uri.file(node.file.path);
        item.command = { command: 'vscode.open', title: 'Open file', arguments: [vscode.Uri.file(node.file.path)] };
        return item;
      }
    }
  }

  getChildren(node?: KeilNode): KeilNode[] {
    if (!node) {
      return [...projects.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((project) => ({ kind: 'project' as const, project }));
    }
    switch (node.kind) {
      case 'project':
        return node.project.targets.map((target) => ({ kind: 'target' as const, project: node.project, target }));
      case 'target':
        return node.target.groups.map((group) => ({
          kind: 'group' as const,
          project: node.project,
          target: node.target,
          group,
        }));
      case 'group':
        return node.group.files.map((file) => ({
          kind: 'file' as const,
          project: node.project,
          target: node.target,
          group: node.group,
          file,
        }));
      default:
        return [];
    }
  }

  getParent(node: KeilNode): KeilNode | undefined {
    if (node.kind === 'target') {
      return { kind: 'project', project: node.project };
    }
    if (node.kind === 'group') {
      return { kind: 'target', project: node.project, target: node.target };
    }
    if (node.kind === 'file') {
      return { kind: 'group', project: node.project, target: node.target, group: node.group };
    }
    return undefined;
  }
}

async function openProjectDialog(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'uVision project': ['uvprojx', 'uvproj'] },
    title: 'Open Keil MDK project',
  });
  if (!selected || selected.length === 0) {
    return;
  }
  const filePath = selected[0].fsPath;
  loadProject(filePath, { activate: true });
  await addOpenedProject(filePath);
  await extensionContext.workspaceState.update(LAST_PROJECT_KEY, filePath);
}

async function selectActiveTarget(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  if (!project) {
    await openProjectDialog();
    return;
  }
  const items = project.targets.map((target) => {
    const active = activeTarget(project)?.name === target.name;
    return {
      label: `${active ? '$(check) ' : ''}${target.name}`,
      description: `${target.device.name} - ${target.uAC6 ? 'AC6' : 'AC5'}`,
      target,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the active target (used for build, flash and IntelliSense)',
    matchOnDescription: true,
  });
  if (picked) {
    await setActiveTarget(project, picked.target);
  }
}

function nativeOptions(project: UVProject, target: UVTarget, token?: vscode.CancellationToken): NativeBuildOptions {
  if (!install) {
    throw new Error('Keil MDK installation not found. Set "keil.root".');
  }
  return {
    install,
    project,
    target,
    pack: packFor(target),
    jobs: configuration().get<number>('build.jobs', 4),
    cleanFirst: configuration().get<boolean>('build.cleanBeforeBuild', false),
    extraDefines: configuration().get<string[]>('build.extraDefines', []) ?? [],
    extraIncludes: configuration().get<string[]>('build.extraIncludes', []) ?? [],
    log,
    token,
  };
}

async function runBuild(action: 'build' | 'rebuild' | 'clean', arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  if (!project) {
    void vscode.window.showWarningMessage('Keil: no project is loaded.', 'Open project').then((choice) => {
      if (choice) {
        void openProjectDialog();
      }
    });
    return;
  }
  const target = nodeTarget(arg, project);
  if (!target) {
    void vscode.window.showWarningMessage('Keil: the project has no target.');
    return;
  }
  await setActiveTarget(project, target);
  const keil = await ensureInstall();
  if (!keil && action !== 'clean') {
    void vscode.window.showErrorMessage(
      'Keil: installation not found. Set "keil.root" to the folder that contains TOOLS.INI and UV4\\UV4.exe.'
    );
    return;
  }
  if (buildInProgress) {
    void vscode.window.showWarningMessage('Keil: a build is already running.');
    return;
  }

  buildInProgress = true;
  output.show(true);
  log('');
  log(`===== ${action.toUpperCase()} ${path.basename(project.filePath)} :: ${target.name} (${new Date().toLocaleString()}) =====`);

  const started = Date.now();
  statusBuild.text = `$(sync~spin) ${action} ${target.name}`;
  statusBuild.tooltip = 'Keil build in progress';
  statusBuild.show();

  try {
    if (action === 'clean') {
      cleanNative(target, log);
      diagnostics.clear();
      log('Clean finished.');
      void vscode.window.setStatusBarMessage(`Keil: ${target.name} cleaned.`, 5000);
      return;
    }

    const summary = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Keil: ${action} ${target.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Preparing toolchain...' });
        return buildWithEngine({
          ...nativeOptions(project, target, token),
          engine: configuration().get<BuildEngineSetting>('build.engine', 'auto'),
          uv4Path: uv4Path(),
          action,
        });
      }
    );

    lastBuildSummary = summary;
    applyDiagnostics(project, summary);
    summaryMessage(action, target, summary);
    log(`Done in ${(summary.durationMs / 1000).toFixed(2)}s.`);
  } catch (error) {
    log(`Error: ${(error as Error).message}`);
    void vscode.window.showErrorMessage(`Keil: ${(error as Error).message}`);
  } finally {
    buildInProgress = false;
    statusBuild.hide();
  }
}

function summaryMessage(action: string, target: UVTarget, summary: BuildSummary): void {
  const counts = `${summary.errors} error(s), ${summary.warnings} warning(s)`;
  if (summary.success) {
    void vscode.window.setStatusBarMessage(`Keil: ${action} ${target.name} succeeded (${counts})`, 5000);
    return;
  }
  const actions = ['Show Problems', 'Show Log'];
  void vscode.window.showErrorMessage(`Keil: ${action} ${target.name} failed - ${counts}.`, ...actions).then((choice) => {
    if (choice === 'Show Problems') {
      void vscode.commands.executeCommand('workbench.actions.view.problems');
    } else if (choice === 'Show Log') {
      output.show();
    }
  });
}

async function flashTarget(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  const target = project ? nodeTarget(arg, project) : undefined;
  if (!project || !target) {
    void vscode.window.showWarningMessage('Keil: no project/target selected.');
    return;
  }
  await setActiveTarget(project, target);
  const keil = await ensureInstall();

  const axf = path.join(target.outputDir, `${target.outputName}.axf`);
  const hex = path.join(target.outputDir, `${target.outputName}.hex`);
  if (!fs.existsSync(axf) && !fs.existsSync(hex)) {
    const choice = await vscode.window.showWarningMessage(
      `Keil: no output image for '${target.name}' yet. Build it first?`,
      'Build',
      'Cancel'
    );
    if (choice === 'Build') {
      await runBuild('build', arg);
    }
    if (!fs.existsSync(axf) && !fs.existsSync(hex)) {
      return;
    }
  }

  const template = configuration().get<string>('flash.command', '').trim();
  log('');
  log(`===== FLASH ${target.name} (${new Date().toLocaleString()}) =====`);

  if (template) {
    const command = template
      .replace(/\{axf\}/g, axf)
      .replace(/\{hex\}/g, hex)
      .replace(/\{bin\}/g, path.join(target.outputDir, `${target.outputName}.bin`))
      .replace(/\{device\}/g, target.device.name)
      .replace(/\{projectDir\}/g, project.dir);
    log(`External flash command: ${command}`);
    const exitCode = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Keil: flashing ${target.name}`, cancellable: false },
      () =>
        new Promise<number>((resolve) => {
          const child = spawn('cmd.exe', ['/d', '/c', command], {
            cwd: project.dir,
            windowsHide: true,
          });
          child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()));
          child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()));
          child.on('error', (error) => {
            log(`Flash command failed: ${error.message}`);
            resolve(-1);
          });
          child.on('close', (code) => resolve(code ?? -1));
        })
    );
    if (exitCode === 0) {
      void vscode.window.showInformationMessage(`Keil: flash command finished for '${target.name}'.`);
    } else {
      void vscode.window.showErrorMessage(`Keil: flash command failed (exit code ${exitCode}).`);
    }
    return;
  }

  const uv4 = uv4Path();
  if (!uv4 || !isUvisionAvailable(uv4)) {
    void vscode.window.showErrorMessage(
      'Keil: no flash backend available. uVision (UV4.exe) was not found and "keil.flash.command" is not set.'
    );
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Keil: flashing ${target.name}`, cancellable: true },
    (_progress, token) =>
      runUV4({
        uv4Path: uv4,
        projectFile: project.filePath,
        action: 'flash',
        target: target.name,
        token,
        log,
      })
  );
  logBlock(result.output);
  const flash = interpretFlashResult(result);
  if (flash.success) {
    void vscode.window.showInformationMessage(`Keil: ${flash.message}`);
  } else {
    void vscode.window.showErrorMessage(`Keil: flash failed - ${flash.message}`, 'Show Log').then((choice) => {
      if (choice === 'Show Log') {
        output.show();
      }
    });
  }
}

async function generateIntelliSenseCommand(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  const target = project ? nodeTarget(arg, project) : undefined;
  if (!project || !target) {
    void vscode.window.showWarningMessage('Keil: no project/target selected.');
    return;
  }
  await ensureInstall();
  const written = await generateIntelliSenseForTarget(project, target, false);
  if (written) {
    void vscode.window.showInformationMessage(
      `Keil: IntelliSense configuration 'Keil: ${target.name}' written to ${path.relative(project.dir, written)}.`
    );
  }
}

async function generateIntelliSenseForTarget(
  project: UVProject,
  target: UVTarget | undefined,
  silent: boolean
): Promise<string | undefined> {
  if (!target || !install) {
    return undefined;
  }
  const generatedKey = `${projectKey(project.filePath)}|${target.name}`;
  if (silent && intellisenseGenerated.has(generatedKey)) {
    return undefined;
  }
  try {
    const context = buildContext(target);
    if (!context) {
      return undefined;
    }
    const generated = buildIntellisenseConfiguration(context);
    const filePath = path.join(project.dir, '.vscode', 'c_cpp_properties.json');
    const existing = fs.existsSync(filePath) ? parseJsonc(fs.readFileSync(filePath, 'utf8')) : undefined;
    const merged = mergeCppProperties(existing, generated);
    if (!merged.changed && fs.existsSync(filePath)) {
      intellisenseGenerated.add(generatedKey);
      return filePath;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(merged.document, null, 4)}\n`, 'utf8');
    intellisenseGenerated.add(generatedKey);
    if (silent) {
      log(`IntelliSense configuration updated: ${filePath}`);
    }
    return filePath;
  } catch (error) {
    if (!silent) {
      void vscode.window.showErrorMessage(`Keil: cannot write IntelliSense configuration: ${(error as Error).message}`);
    }
    return undefined;
  }
}

async function createDebugConfig(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  const target = project ? nodeTarget(arg, project) : undefined;
  if (!project || !target) {
    void vscode.window.showWarningMessage('Keil: no project/target selected.');
    return;
  }
  const keil = await ensureInstall();
  if (!keil) {
    void vscode.window.showErrorMessage('Keil: installation not found.');
    return;
  }
  const generated = generateDebugConfiguration(
    keil,
    project,
    target,
    packFor(target),
    configuration().get<string>('debug.serverType', 'auto')
  );
  const filePath = path.join(project.dir, '.vscode', 'launch.json');
  const existing = fs.existsSync(filePath) ? parseJsonc(fs.readFileSync(filePath, 'utf8')) : undefined;
  const merged = mergeLaunchConfiguration(existing, generated.configuration);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(merged.document, null, 4)}\n`, 'utf8');
  log(`Debug configuration '${generated.name}' written to ${filePath}`);
  for (const note of generated.notes) {
    log(`  ${note}`);
  }
  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document);
  void vscode.window.showInformationMessage(
    `Keil: launch configuration created (${generated.serverType}). Install the Cortex-Debug extension to use it.`
  );
}

async function startDebugging(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  const target = project ? nodeTarget(arg, project) : undefined;
  if (!project || !target) {
    void vscode.window.showWarningMessage('Keil: no project/target selected.');
    return;
  }
  const keil = await ensureInstall();
  if (!keil) {
    return;
  }
  const generated = generateDebugConfiguration(
    keil,
    project,
    target,
    packFor(target),
    configuration().get<string>('debug.serverType', 'auto')
  );
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.filePath));
  const started = await vscode.debug.startDebugging(folder, generated.configuration as unknown as vscode.DebugConfiguration);
  if (!started) {
    void vscode.window.showErrorMessage(
      'Keil: could not start the debug session. Is the Cortex-Debug extension installed? Use "Keil: Create Debug Configuration" to inspect the generated launch configuration.',
      'Create Configuration'
    ).then((choice) => {
      if (choice) {
        void createDebugConfig(arg);
      }
    });
  }
}

async function showCommands(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  const target = project ? nodeTarget(arg, project) : undefined;
  if (!project || !target) {
    void vscode.window.showWarningMessage('Keil: no project/target selected.');
    return;
  }
  const keil = await ensureInstall();
  if (!keil) {
    void vscode.window.showErrorMessage('Keil: installation not found.');
    return;
  }
  const lines: string[] = [];
  lines.push(`:: Resolved build commands for '${target.name}'`);
  lines.push(`:: Project : ${project.filePath}`);
  lines.push(`:: Device  : ${target.device.name} (${target.device.cpuType || 'unknown core'})`);
  lines.push(`:: Compiler: ${target.uAC6 ? 'ARM Compiler 6' : 'ARM Compiler 5'}`);
  lines.push(`:: Engine  : ${configuration().get<string>('build.engine', 'auto')}`);
  lines.push(`cd /d "${project.dir}"`);
  lines.push('');
  try {
    const plan = planNativeCommands(nativeOptions(project, target));
    if (plan.scatter) {
      lines.push(':: Generated scatter file:');
      lines.push(plan.scatter.trim());
      lines.push('');
    }
    for (const command of plan.commands) {
      lines.push(`"${command.tool}" ${command.args.map(quoteForDisplay).join(' ')}`);
    }
  } catch (error) {
    lines.push(`:: ${(error as Error).message}`);
  }
  const document = await vscode.workspace.openTextDocument({ content: lines.join('\r\n'), language: 'bat' });
  await vscode.window.showTextDocument(document, { preview: true });
}

function quoteForDisplay(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function parseJsonc(text: string): any {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      result += ch;
      index++;
      while (index < text.length) {
        const current = text[index];
        result += current;
        if (current === '\\' && index + 1 < text.length) {
          result += text[index + 1];
          index += 2;
          continue;
        }
        if (current === '"') {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        index++;
      }
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index++;
      }
      index += 2;
      continue;
    }
    result += ch;
    index++;
  }
  result = result.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`invalid JSON (${(error as Error).message})`);
  }
}

async function openInUVision(arg?: unknown): Promise<void> {
  const project = nodeProject(arg);
  if (!project) {
    await openProjectDialog();
    return;
  }
  await ensureInstall();
  const uv4 = uv4Path();
  if (!uv4) {
    void vscode.window.showErrorMessage('Keil: UV4.exe not found. Set "keil.root".');
    return;
  }
  const child = spawn(uv4, [project.filePath], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Keil MDK');
  diagnostics = vscode.languages.createDiagnosticCollection('keil');
  context.subscriptions.push(output, diagnostics);
  output.appendLine('Keil MDK Tools activated.');

  treeProvider = new KeilTreeProvider();
  const treeView = vscode.window.createTreeView('keil.projects', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  statusTarget = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBuild = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(statusTarget, statusBuild);

  const register = (command: string, handler: (...args: any[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };
  register('keil.openProject', () => openProjectDialog());
  register('keil.refreshProjects', async () => {
    projects.clear();
    await discoverProjects();
  });
  register('keil.build', (arg) => runBuild('build', arg));
  register('keil.rebuild', (arg) => runBuild('rebuild', arg));
  register('keil.clean', (arg) => runBuild('clean', arg));
  register('keil.selectTarget', (arg) => selectActiveTarget(arg));
  register('keil.flash', (arg) => flashTarget(arg));
  register('keil.debug', (arg) => startDebugging(arg));
  register('keil.generateIntelliSense', (arg) => generateIntelliSenseCommand(arg));
  register('keil.createDebugConfig', (arg) => createDebugConfig(arg));
  register('keil.showCommands', (arg) => showCommands(arg));
  register('keil.openInUVision', (arg) => openInUVision(arg));
  register('keil.showBuildLog', () => output.show());
  register('keil.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', 'keil.root')
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{uvprojx,uvproj}');
  watcher.onDidChange((uri) => {
    log(`Project file changed: ${uri.fsPath}`);
    loadProject(uri.fsPath, { silent: true });
  });
  watcher.onDidCreate((uri) => loadProject(uri.fsPath, { silent: true }));
  watcher.onDidDelete((uri) => {
    projects.delete(projectKey(uri.fsPath));
    refreshTree();
  });
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('keil.root') || event.affectsConfiguration('keil.uv4.path')) {
        void ensureInstall(true);
      }
    })
  );

  updateStatusBar();
  void (async () => {
    await ensureInstall();
    if (!install) {
      log('Keil MDK installation not found. Set "keil.root" in the settings.');
    } else {
      log(`Keil MDK ${install.version || ''} found at ${install.root}`);
      log(`  ARMCC 5: ${install.ac5?.bin ?? 'not installed'}`);
      log(`  ARMCLANG 6: ${install.ac6?.bin ?? 'not installed'}`);
      log(`  uVision: ${install.uvisionExe || 'not found'}`);
      log(`  Packs: ${install.packsRoot}`);
    }
    await discoverProjects();
  })();
}

export function deactivate(): void {
  diagnostics?.dispose();
  output?.dispose();
}
