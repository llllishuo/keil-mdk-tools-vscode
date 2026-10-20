# Keil MDK Tools for Visual Studio Code

[![CI](https://github.com/llllishuo/keil-mdk-tools-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/llllishuo/keil-mdk-tools-vscode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/llllishuo/keil-mdk-tools-vscode)](https://github.com/llllishuo/keil-mdk-tools-vscode/releases)

把 Arm Keil MDK (µVision) 的工程浏览、编译、下载、代码补全与调试配置搬进 VS Code。

本扩展**不修改 sdk、不复制二进制**，而是直接驱动本机已安装的 Keil MDK：

- **原生构建引擎**：解析 `.uvprojx`，把 µVision 的工程选项翻译成 `armcc` / `armclang` / `armasm` / `armlink` / `fromelf` 命令行，不启动 µVision 也能编译链接；
- **UV4 桥接**：需要 100% 保真（RTE 组件、特殊选项、下载算法）时，调用 `UV4.exe` 命令行完成编译/重建/清理/下载；
- **工程树、Problem 面板、状态栏、IntelliSense、Cortex-Debug 配置**：在 VS Code 内还原 µVision 的日常操作。

> 开发/验证环境：MDK-ARM Plus 5.36，ARM Compiler 5.06u7 (build 960)，Arm Compiler 6.16，µVision 5.36.0.0，
> 已在 STM32F103（AC5 与 AC6 两种工程）上完成编译、链接、HEX 生成与 µVision 结果比对。

## 安装

- **Marketplace**：在 VS Code 扩展面板搜索 **Keil MDK Tools**，或执行
  `code --install-extension llllishuo.keil-mdk-tools`
  （上架后可用；商品页 <https://marketplace.visualstudio.com/items?itemName=llllishuo.keil-mdk-tools>）。
- **离线 VSIX**：从 [Releases](https://github.com/llllishuo/keil-mdk-tools-vscode/releases) 下载 `.vsix`，执行
  `code --install-extension keil-mdk-tools-0.1.0.vsix`。

## 功能

| 功能 | 说明 |
| --- | --- |
| 工程树 | 活动栏 **Keil MDK** 视图：工程 → 目标 → 分组 → 源文件；点击打开文件；自动发现工作区中的 `*.uvprojx`。 |
| Build / Rebuild / Clean | 状态栏、命令面板、树节点右键、资源管理器 `.uvprojx` 右键均可触发。 |
| 原生编译 | 增量编译（`.d` 依赖）、并行编译、自动生成 scatter 文件、`Program Size` 统计。 |
| UV4 构建 | 与 µVision 完全一致的构建结果，支持 RTE 组件工程。 |
| Problem 集成 | 解析 armcc/armclang/armasm/armlink/uVision 的错误与警告，跳转到文件与行。 |
| 下载到 Flash | 默认通过 `UV4.exe -f` 使用工程里配置的调试器与 FLASH 算法；也可配置外部命令（pyOCD / STM32CubeProgrammer 等）。 |
| IntelliSense | 自动生成/合并 `.vscode/c_cpp_properties.json`（包含路径、宏、编译器路径、C/C++ 标准）。 |
| 调试 | 根据 `.uvoptx` 中记录的调试器生成 Cortex-Debug `launch.json`（OpenOCD / J-Link / ST-Link / pyOCD）。 |
| 命令预览 | “Show Resolved Build Commands” 展示原生引擎实际执行的完整命令行与生成的 scatter 文件。 |

## 快速开始

1. 确认已安装 Keil MDK（默认自动探测 `C:\Keil_v5`、注册表与 `%PATH%` 中的 `UV4.exe`）。
   如未找到，在设置中填写 **`keil.root`**（包含 `TOOLS.INI`、`UV4\UV4.exe` 的目录）。
2. VS Code 打开包含 `.uvprojx` 的工程目录。
3. 在活动栏点击 **Keil MDK** 图标，展开工程与目标；状态栏会显示当前目标。
4. `Ctrl+Shift+P` → **Keil: Build**（或点击视图标题栏的齿轮按钮）。
5. 需要烧录时使用 **Keil: Flash / Download**。

## 命令

| 命令 | 说明 |
| --- | --- |
| `Keil: Open Keil Project...` | 打开 `.uvprojx`（支持工作区外的工程）。 |
| `Keil: Build` / `Rebuild` / `Clean` | 编译 / 全量重编 / 清理输出目录。 |
| `Keil: Flash / Download` | 下载到目标板。 |
| `Keil: Start Debugging` | 用生成的 Cortex-Debug 配置启动调试会话。 |
| `Keil: Select Active Target` | 选择当前目标（多目标工程）。 |
| `Keil: Generate IntelliSense Configuration` | 写入/更新 `c_cpp_properties.json`。 |
| `Keil: Create Debug Configuration` | 写入/更新 `launch.json`。 |
| `Keil: Show Resolved Build Commands` | 显示实际命令行与生成的 scatter 内容。 |
| `Keil: Open in uVision` | 用 µVision 打开当前工程。 |
| `Keil: Show Build Log` | 聚焦输出面板 **Keil MDK**。 |

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `keil.root` | 自动 | Keil MDK 安装目录，例如 `C:\Keil_v5`。 |
| `keil.build.engine` | `auto` | `auto`：优先原生，遇到 RTE 工程或工具链缺失时回退 UV4；`uv4`：始终用 uVision；`native`：始终直接调用工具链。 |
| `keil.build.jobs` | `4` | 原生引擎并行编译数。 |
| `keil.build.cleanBeforeBuild` | `false` | 每次编译前清理。 |
| `keil.build.extraDefines` | `[]` | 追加到所有编译命令的宏。 |
| `keil.build.extraIncludes` | `[]` | 追加到所有编译命令的头文件路径（相对路径按工程目录解析）。 |
| `keil.uv4.path` | 自动 | `UV4.exe` 的完整路径。 |
| `keil.flash.command` | 空 | 外部烧录命令，支持占位符 `{axf}` `{hex}` `{bin}` `{device}` `{projectDir}`；为空时使用 `UV4.exe -f`。 |
| `keil.intellisense.auto` | `true` | 加载工程时自动写入 `c_cpp_properties.json`（按配置名合并，不覆盖其它配置）。 |
| `keil.debug.serverType` | `auto` | Cortex-Debug 的 GDB Server 类型；`auto` 根据 `.uvoptx` 的调试器驱动推断。 |
| `keil.tree.autoDiscover` | `true` | 自动发现工作区中的 `*.uvprojx`。 |

## 工作原理

### 工程解析

`.uvprojx`（SchemaVersion 2.1）由 `src/core/xml.ts` 内置的轻量 XML 解析器读取，`src/core/uvprojx.ts` 建模：

- `Target` → 设备（`Device`/`Cpu`/`PackID`/`SVD`/`FlashDriver`）、输出目录、目标名；
- `Cads` / `Aads` / `LDads` → 编译、汇编、链接选项；
- `Groups` → 分组与文件（含 `IncludeInBuild` 排除项、文件级选项）；
- 可选：`RTE` 组件标记（用于决定是否回退到 UV4）。

### 原生构建（无需 µVision）

```
uvprojx ──► BuildContext ──► armcc/armclang 命令 ──► .o
                              ├─ 设备宏来自 CMSIS-Pack (.pdsc 的 <compile define=...>)
                              ├─ 头文件：工程 IncludePath + 文件级路径 + 包内 Device\Include
                              └─ 宏：__UVISION_VERSION + 设备宏 + 工程宏 + 文件宏
                          ──► armlink --via <target>.lnp（自动生成 scatter）
                          ──► fromelf --i32combined（CreateHexFile=1 时）
```

- 命令翻译与 µVision 实际传给编译器的响应文件逐项对齐（见 `docs/ANALYSIS.md`）；
- 增量判断基于 `--depend` / `-MD` 生成的 `.d` 依赖；
- 无自定义 `.sct` 时，按 `OnChipMemories` 合成 `LR_IROM1/ER_IROM1/RW_IRAM1` scatter；
- 编译失败立即停止链接，错误/警告进入 Problems。

### UV4 桥接

当 `keil.build.engine` 为 `uv4`（或 `auto` 判定 RTE 工程）时执行：

```
UV4.exe -b|-r|-c|-f "<project.uvprojx>" -t "<target>" -j0 -o "<log>"
```

退出码 0=无错误无警告、1=有警告、2=有错误、3=致命错误、11=工程打不开、12=器件无匹配工具链、13/15=读写错误、20=许可错误。
日志被解析成统一的诊断信息。

### 调试与 Flash

- 调试：读取 `.uvoptx` 的 `DebugOpt/pMon`（如 `BIN\CMSIS_AGDI.dll`、`Segger\JL2CM3.dll`、`ST-LINKIII-KEIL_SWO.dll`），映射到
  Cortex-Debug 的 `openocd` / `jlink` / `stlink` / `pyocd`，并从 CMSIS-Pack 解析 SVD 路径。
- 下载：`UV4.exe -f` 会使用工程中已经配置好的调试器与 FLASH 算法，这是最可靠的移植方式；
  没有 µVision 时可通过 `keil.flash.command` 调用 pyOCD / STM32CubeProgrammer 等外部工具。

## 限制（与 µVision 的差异）

- **RTE（CMSIS-Pack 组件）工程**：原生引擎不支持组件自动解析与生成配置头文件，`auto` 模式会自动改用 UV4；`native` 模式仅适用于自包含工程。
- **多目标批量编译（Batch Build）**：一次构建一个目标；多目标请切换活动目标。
- **调试器本体**：µVision 的 ULINK/CMSIS-DAP/ST-Link 驱动不对外提供，调试依赖 Cortex-Debug + 对应 GDB Server（OpenOCD/J-Link/ST-Link/pyOCD）。
- **特殊选项**：`MiscControls` 会原样追加；个别非常用选项（如部分 ROPI/RWPI、自定义 FLASH 算法参数）建议使用 UV4 引擎。
- **Windows only**：Keil MDK 本身仅支持 Windows。

## 开发与发布

```bash
npm install
npm run compile          # tsc -> out/
node --test out/test/core.test.js   # 单元测试
node scripts/smoke.js <工程.uvprojx> # 使用 mock 的 VS Code API 跑通扩展命令（开发自测）
npx @vscode/vsce package --no-dependencies
```

发布到 VS Code 插件市场（创建 Publisher、PAT、`vsce publish`、GitHub Actions 自动化、常见报错）见
[PUBLISHING.md](PUBLISHING.md)。

目录结构：

```
src/core/      纯 Node 逻辑（无 vscode 依赖）：XML/工程解析、工具链、构建、诊断、配置生成
src/extension.ts  VS Code 集成：视图、命令、状态栏、Problem、Watcher
src/test/       单元测试（node:test）
scripts/        开发用 mock 与冒烟测试
docs/           Keil 安装与移植分析
.github/        CI 与 Release 工作流
```

## License

MIT
