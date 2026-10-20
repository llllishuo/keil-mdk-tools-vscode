# Change Log

## 0.1.0

首个公开版本。

- 工程树：自动发现 `*.uvprojx`，按 目标 → 分组 → 文件 展示，支持多工程、活动目标。
- 原生构建引擎：直接调用 armcc/armclang/armasm/armlink/fromelf，支持 AC5 与 AC6、增量编译、并行编译、
  自动 scatter 生成、`Program Size` 统计、`CreateHexFile`、静态库输出、编译前后用户命令。
- UV4 桥接：`UV4.exe -b/-r/-c/-f`，用于 RTE 工程与高保真构建；退出码与日志解析。
- 下载：默认 `UV4 -f`，可配置外部烧录命令（pyOCD / STM32CubeProgrammer 等）。
- Problem 集成：armcc/armclang/armasm/armlink/µVision 错误与警告定位。
- IntelliSense：自动生成/合并 `c_cpp_properties.json`。
- 调试：由 `.uvoptx` 调试器驱动生成 Cortex-Debug `launch.json`（OpenOCD/J-Link/ST-Link/pyOCD）。
- 命令预览与构建日志。
- 单元测试（node:test）与开发用 VS Code API mock 冒烟测试。
- 验证：STM32F103 的 AC5 / AC6 工程，原生引擎与 µVision 的 `Program Size` 完全一致。
- 完整的 GitHub Release 说明见 `docs/RELEASE_NOTES_v0.1.0.md`。
