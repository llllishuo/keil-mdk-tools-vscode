# 分析 C:\Keil_v5 并移植为 VS Code 扩展

本文记录对 `C:\Keil_v5` 安装的分析结论，以及扩展如何把 µVision 的工作流映射到 VS Code。
分析基于实机环境：MDK-ARM Plus 5.36、ARM Compiler 5.06u7、Arm Compiler 6.16、µVision 5.36.0.0。

## 1. 安装结构

```
C:\Keil_v5
├─ TOOLS.INI              工具注册与许可（[UV2] [ARM] [ARMADS]）
├─ Uninstall.exe
├─ ARM\                   2.75 GB 工具链 + 器件支持
│  ├─ ARMCC\bin\          armcc/armasm/armlink/fromelf/armar  (AC5 5.06u7)
│  ├─ ARMCLANG\bin\       armclang/armasm/armlink/fromelf/armar (AC6 6.16)
│  ├─ BIN\                调试器与 CPU DLL（UL2CM3/CMSIS_AGDI/...）、fromelf 等
│  ├─ PACK\               Pack 安装器资源
│  ├─ Flash\  Segger\  STLink\  ULINK\  SiLabs\  NULink\  PEMicro\  TI_XDS\  调试器驱动
│  ├─ Startup\            RTX 启动文件
│  └─ Utilities\
├─ UV4\                   84 MB：µVision IDE 与工程文件 schema
│  ├─ UV4.exe             µVision 5.36.0.0（支持 -b/-r/-c/-f/-j0/-o/-t）
│  ├─ PackInstaller.exe   SVDConv.exe  UVCDB2XML.exe
│  ├─ project_projx.xsd   .uvprojx 结构定义
│  ├─ project_optx.xsd    .uvoptx 结构定义
│  └─ UV4.cdb             器件/外设数据库
└─ license_terms\
```

关键版本信息：

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| µVision | 5.36.0.0 | `UV4.exe` 文件版本 |
| ARM Compiler 5 | 5.06 update 7 (build 960) | `armcc --vsn` |
| Arm Compiler 6 | 6.16 | `armclang --version` |
| CMSIS-Pack 根目录 | `%LOCALAPPDATA%\Arm\Packs` | `TOOLS.INI [UV2] RTEPATH` |

`TOOLS.INI` 还注册了调试器驱动（`TDRV0..TDRV18`，ULINK / CMSIS-DAP / J-Link / ST-Link 等）、RTX、编译器路径
（`ARMCCPATH0=".\ARMCLANG"`、`ARMCCPATH1=".\ARMCC"`）以及许可。

## 2. 工程文件格式

- `.uvprojx`：XML，`SchemaVersion 2.1`，根节点 `Project`。
  - `Targets/Target/{TargetName,uAC6,TargetOption,Groups}`
  - `TargetOption/TargetCommonOption`：`Device`、`Vendor`、`PackID`、`Cpu`（`IROM/IRAM/CPUTYPE/FPU/CLOCK`）、
    `OutputDirectory`、`OutputName`、`CreateHexFile`、`CreateLib`、`DebugInformation`、`RegisterFile`、`SFDFile`、`FlashDriverDll`
  - `TargetOption/TargetArmAds/{ArmAdsMisc,Cads,Aads,LDads}`：优化、C99、`--apcs`、宏、头文件、scatter、misc 选项、片上存储器
  - `Groups/Group/Files/File`：`FileName`、`FileType`、`FilePath`、`FileOption/CommonProperty/IncludeInBuild`、文件级 `VariousControls`
- `.uvoptx`：`ProjectOpt`，每个 `Target` 保存调试器（`DebugOpt/pMon`）、断点、窗口等；调试器选择**不在** `.uvprojx` 中。
- `.uvproj`：旧版工程格式，扩展同样接受。

## 3. 构建流程还原

通过让 µVision 生成批处理文件，并在构建期间抓取它传给编译器的响应文件（`Objects\*. __i` / `*._ac`），
可以直接看到 µVision 的真实命令：

AC6 C 编译（`uAC6=1`，Optim=2）：

```
-xc -std=c99 --target=arm-arm-none-eabi -mcpu=cortex-m3 -c
-fno-rtti -funsigned-char -fshort-enums -fshort-wchar
-gdwarf-4 -O1 -ffunction-sections -Wno-packed -Wno-missing-variable-declarations ...
-I <pack>\Device\Include
-D__UVISION_VERSION="536" -DSTM32F10X_HD -DSTM32F103xE
-o ./objects/main.o -MD main.c
```

AC5 C 编译（`uAC6=0`，Optim=1，C99=1）：

```
--c99 -c --cpu Cortex-M3 -g -O0 --apcs=interwork --split_sections
-I <工程 IncludePath> -I <pack>\Device\Include
-D__UVISION_VERSION="536" -DUSE_HAL_DRIVER -DSTM32F103xE
-o ..\..\output\main.o --depend ..\..\output\main.d ..\..\User\main.c
```

AC6 汇编：

```
--target=arm-arm-none-eabi -mcpu=cortex-m3 -masm=auto -c -gdwarf-4
-I ... -Wa,armasm,--pd,"STM32F10X_HD SETA 1" -o ...o startup.s
```

链接（`.lnp`）：

```
--cpu Cortex-M3
".\objects\startup_stm32f103xe.o" ".\objects\main.o"
--strict --scatter ".\Objects\test.sct"
--summary_stderr --info summarysizes --map --load_addr_map_info --xref --callgraph --symbols
--info sizes --info totals --info unused --info veneers
--list ".\Listings\test.map" -o .\Objects\test.axf
```

由此得到扩展的选项映射表（`src/core/commands.ts`）：

| µVision 选项 | AC5 | AC6 |
| --- | --- | --- |
| `Optim` 1/2/3/4 | `-O0/-O1/-O2/-O3` | 同左 |
| `uC99` | `--c99` | `-std=c99`（µVision 5.36 固定传 c99） |
| `OneElfS` | `--split_sections` | `-ffunction-sections` |
| `interw` | `--apcs=interwork` | 默认 |
| `DebugInformation` | `-g` | `-gdwarf-4` |
| `FPU2/FPU3` | `--fpu=FPv4-SP/FPv5-D16` | `-mfpu=fpv4-sp-d16` / `fpv5-d16` + `-mfloat-abi=hard` |
| `useUlib` | `--library_type=microlib` | 同左 |
| 器件 `Cpu` | `--cpu Cortex-M3` | `-mcpu=cortex-m3` |
| 器件 `compile define`（来自 DFP 的 `.pdsc`） | `-D` 宏 | `-D` 宏 |

验证：同一工程用原生引擎与 µVision 构建，链接结果的 `Program Size` 完全一致：

| 工程 | 编译器 | 原生引擎 | µVision |
| --- | --- | --- | --- |
| STM32F103 最小工程 | AC6 6.16 | Code=404 RO=320 RW=0 ZI=1120 | 相同 |
| STM32F103 HAL 跑马灯 | AC5 5.06u7 | Code=7832 RO=360 RW=28 ZI=2044 | 相同 |

## 4. UV4 命令行行为

- `UV4.exe -b <proj> -j0 -o <log>`：编译；`-r` 重建；`-c` 清理；`-f` 下载。
- `-t "<目标名>"` 可指定目标（参数必须作为一个整体传入，Node `spawn` 数组形式即可）。
- `-j0` 不显示 GUI，`-o` 指定日志。
- 退出码：0 无错误无警告，1 有警告，2 有错误，3 致命错误，11 工程无法打开，12 无匹配工具链，13/15 读写错误，20 许可错误，41 命令行错误。

## 5. VS Code 扩展架构

```
src/core/xml.ts          轻量 XML 解析（实体、CDATA、注释）
src/core/uvprojx.ts      .uvprojx / .uvoptx 模型与路径解析
src/core/tools.ts        Keil 安装探测（TOOLS.INI/注册表/PATH）、CMSIS-Pack 与 SVD/宏解析
src/core/commands.ts     编译/汇编/链接/fromelf/armar 命令行生成
src/core/nativeBuild.ts  原生构建引擎（并行、增量、scatter、Program Size）
src/core/uv4.ts          UV4 桥接与下载结果判定
src/core/engine.ts       auto/uv4/native 引擎选择
src/core/diagnostics.ts  多编译器日志 → 结构化诊断
src/core/intellisense.ts c_cpp_properties.json 生成与合并
src/core/debugConfig.ts  Cortex-Debug launch.json 生成与合并
src/extension.ts         视图/命令/状态栏/Problem/文件监听
```

移植映射：

| µVision | VS Code 扩展 |
| --- | --- |
| Project 窗口 | `keil.projects` 树视图 |
| Build/Rebuild/Clean 菜单 | 命令 + 视图标题按钮 + 右键菜单 |
| Build Output 窗口 | 输出面板 “Keil MDK” + Problems |
| Options for Target → C/C++ | `c_cpp_properties.json`（自动合并） |
| Debug → Settings/Start | Cortex-Debug `launch.json`（自动生成） |
| Flash → Download | `UV4 -f` 或外部烧录命令 |
| 器件/包管理 | 只读解析 `TOOLS.INI` 与已安装 Pack |

## 6. 限制与后续方向

- RTE 组件工程仍依赖 UV4（组件展开、配置头文件生成、包内 include 收集）；
- 批量构建（Batch Build）与多目标同时构建未实现；
- 调试器依赖 Cortex-Debug 的后端（OpenOCD/J-Link/ST-Link/pyOCD），µVision 私有驱动无法复用；
- 可扩展方向：解析 `RTE` 组件生成 include/宏、支持 `uvproj` 旧格式差异、增量构建缓存、Memory/Peripheral 视图联动。
