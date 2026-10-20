# Keil MDK Tools v0.1.0

首个公开版本：把 Arm Keil MDK（µVision）的工程管理、构建、下载、代码补全与调试配置搬进 Visual Studio Code。

> 扩展 ID：`llllishuo.keil-mdk-tools` · 要求 VS Code ≥ 1.85 · Windows · 已安装 Keil MDK 5.x

## ✨ 亮点

- **不启动 µVision 也能构建**：原生构建引擎直接驱动 `armcc` / `armclang` / `armasm` / `armlink` / `fromelf`，
  解析 `.uvprojx` 并翻译全部常用工程选项。
- **与 µVision 结果一致**：在真实 STM32F103 工程上，原生引擎与 µVision 的链接结果 `Program Size` 完全一致。
- **需要 100% 保真时自动回退 UV4.exe**：RTE（CMSIS-Pack 组件）工程、特殊选项、Flash 算法都能继续工作。
- **一站式 VS Code 体验**：工程树、Build/Rebuild/Clean、Problem 定位、IntelliSense、Cortex-Debug、一键下载。

## 🚀 功能

### 工程与构建

- 自动发现工作区中的 `*.uvprojx`，工程 → 目标 → 分组 → 文件树视图，支持多工程与活动目标切换。
- 原生构建引擎：AC5 / AC6 双工具链、增量编译（`.d` 依赖）、并行编译、无自定义 scatter 时自动生成、
  `Program Size` 统计、`CreateHexFile`、静态库（`armar`）、编译前/后用户命令。
- UV4 桥接：`UV4.exe -b/-r/-c/-f <proj> -t "<target>" -j0 -o <log>`，退出码与日志统一解析。
- 构建日志输出面板（Keil MDK）与“Show Resolved Build Commands”命令，可查看实际执行的完整命令行与 scatter。

### 诊断与编辑体验

- Problem 集成：解析 armcc / armclang / armasm / armlink / µVision 的错误与警告，支持跳转文件与行号。
- IntelliSense：自动生成并合并 `.vscode/c_cpp_properties.json`，包含头文件路径、器件宏、编译器路径、
  C/C++ 标准（按配置名合并，不覆盖用户已有配置）。
- 状态栏显示当前目标与构建状态。

### 下载与调试

- Flash 下载：默认 `UV4.exe -f`（沿用工程中已配置的调试器与 FLASH 算法）；
  也可通过 `keil.flash.command` 调用 pyOCD / STM32CubeProgrammer 等外部工具。
- 调试：读取 `.uvoptx` 的调试器驱动（CMSIS-DAP / J-Link / ST-Link / ULINK），
  生成 Cortex-Debug `launch.json`（OpenOCD / J-Link / ST-Link / pyOCD），并解析 CMSIS-Pack 的 SVD 路径。

## ✅ 验证

| 工程 | 编译器 | 原生引擎 | µVision |
| --- | --- | --- | --- |
| STM32F103 最小工程 | AC6 6.16 | Code=404 RO=320 RW=0 ZI=1120 | 相同 |
| STM32F103 HAL 跑马灯（19 个源文件） | AC5 5.06u7 | Code=7832 RO=360 RW=28 ZI=2044 | 相同 |

- 11 项单元测试（XML / 工程解析 / 命令生成 / 诊断 / 配置合并 / 引擎选择）。
- 基于 mock VS Code API 的扩展冒烟测试：激活、构建、IntelliSense、launch.json、命令预览、烧录、清理。
- 开发环境：MDK-ARM Plus 5.36、µVision 5.36.0.0、ARM Compiler 5.06u7、Arm Compiler 6.16。

## 📦 安装

- **离线 VSIX**：从本 Release 下载 `keil-mdk-tools-0.1.0.vsix`，执行
  `code --install-extension keil-mdk-tools-0.1.0.vsix`。
- **Marketplace**（即将上架）：`code --install-extension llllishuo.keil-mdk-tools`。
- **从源码**：`npm ci && npm run compile`，或 `npx @vscode/vsce package --no-dependencies`。

## ⚙️ 环境要求

- Windows 10/11。
- Keil MDK 5.x（本版本验证于 MDK 5.36 / AC5 5.06u7 / AC6 6.16）。
- VS Code ≥ 1.85。
- 调试需要安装 [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug)，
  并准备 OpenOCD / J-Link / ST-Link / pyOCD 中对应的 GDB Server。

## ⚠️ 已知限制

- **RTE（CMSIS-Pack 组件）工程**：原生引擎暂不支持组件展开与配置头文件生成，`auto` 模式会自动改用 UV4；
  `native` 模式仅适用于自包含工程。
- **批量构建（Batch Build）**：一次构建一个目标，多目标请切换活动目标。
- **调试器**：µVision 的私有调试驱动无法复用，调试依赖 Cortex-Debug + 对应 GDB Server。
- **平台**：Keil MDK 本身仅支持 Windows。

## 📚 文档

- [README](https://github.com/llllishuo/keil-mdk-tools-vscode/blob/main/README.md)：功能、命令、设置与工作原理。
- [Keil 安装分析与移植说明](https://github.com/llllishuo/keil-mdk-tools-vscode/blob/main/docs/ANALYSIS.md)。
- [发布到插件市场指南](https://github.com/llllishuo/keil-mdk-tools-vscode/blob/main/PUBLISHING.md)。

## 🙏 致谢

感谢 ARM / Keil 提供稳定的工具链与文档，也感谢所有在真实工程上反馈问题的用户。

---

### English summary

**Keil MDK Tools v0.1.0** brings Arm Keil MDK (µVision) workflows to VS Code: a project tree for `.uvprojx`
files, a native ARMCC5/ARMCLANG6 build engine (with a UV4.exe bridge for RTE projects), diagnostics,
IntelliSense and Cortex-Debug configuration generation, plus flash download.

Verified on STM32F103 projects: the native engine produces the exact same `Program Size` as µVision.
Windows only; requires Keil MDK 5.x and VS Code ≥ 1.85. MIT licensed.

**Full Changelog**: https://github.com/llllishuo/keil-mdk-tools-vscode/commits/v0.1.0
