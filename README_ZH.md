# CanvasScribble · 随绘幕布

[English](README.md) · 简体中文
<img width="1407" height="748" alt="1142e931c5e72b533d8d6aa846f8f90b" src="https://github.com/user-attachments/assets/016abad4-6c51-4ad6-bfaf-00526893aa41" />
<img width="1712" height="787" alt="d5413d5275e857e3efc6d0d52092bed2" src="https://github.com/user-attachments/assets/fbb8c97f-669e-4033-8b04-95b4566dea57" />
<img width="442" height="440" alt="752b2b4984d1118b7ccb54ced9d44135" src="https://github.com/user-attachments/assets/c2db9ff7-5fba-4e66-a14c-9d91361a612d" />
Foundry VTT（v13–v14）的即时绘制、标注与激光笔模块。支持两种绘制空间：画在**地图**上（随画布平移缩放，可永久保存进场景），或画在**屏幕**上（固定在视口内，到时间自动淡出）。

## 地图与屏幕

| | 地图 | 屏幕 |
|---|---|---|
| 定位方式 | 场景坐标 | 视口九宫格锚点（窗口缩放不错位） |
| 平移与缩放 | 随地图移动、缩放 | 地图移动时留在原位 |
| 存续时间 | 临时（数秒至 1 小时）或永久（保存在场景中） | 仅临时 |
| 图层 | Token 下方、Token 上方、最顶层（迷雾之上） | 始终在最顶层 |

## 工具

- **画笔** — 钢笔、压感钢笔、铅笔（支持压感与倾斜）、马克笔、单线笔、柔边笔刷、粉笔。按住 `Shift` 画直线。
- **高亮** — 荧光笔或套索区域填充。
- **箭头** — 直线或手绘路径，单向或双向。
- **形状** — 直线、矩形、椭圆、多边形（`Shift` 吸附 15° / 正方形 / 正圆，`Alt` 从中心画；多边形双击、右键或按 `Enter` 结束）。
- **激光笔** — 跟随光标的发光拖尾，不保存，也不进入撤销记录。
- **文字** — 点击输入，按 `Enter` 放置（`Shift+Enter` 换行）。
- **橡皮擦** — 整笔擦除或局部遮罩擦除。
- **颜料**（湿介质，仅地图）— 水彩、大笔铺色、水墨、水粉、油画、清水笔、晕染笔、海绵等笔刷，可选冷压、热压、粗纹、宣纸、画布等纸张。颜料是模拟出来的而不是画出来的：颜色按减色规律混合，含色的笔会拖动并调和未干的颜料，水彩沿纸纤维扩散并在边缘积色，颗粒颜料沉入纸纹，墨色逐层累积，颜料在干透前都可以继续推动（油画比水彩干得慢得多）。每笔的颜料量与含水量可调，「立即晾干」可一次性晾干全部颜料。

绘制过程会按约 33 ms 分批实时同步给同场景玩家（可选显示名牌），后进入场景的人也能收到当前仍在显示的临时标记。所有存续与淡出时间都以 Foundry 服务器时钟为准，大家会在同一时刻看到它消失。每位用户有独立的撤销/重做栈和分级清除菜单（清除他人或永久标注时会二次确认）。支持鼠标、触控与数位笔，有数位笔时启用硬件压感、倾斜和防误触，无压感设备则按速度模拟。

## 操作与快捷键

在左侧场景控件栏点击**随绘幕布**，底部快捷栏上方会弹出调色板。拖动左侧握把（`⠿`）可以自由浮动，双击归位。用 `Shift` + 滚轮或 `[` / `]` 改粗细，按 `Tab` 切换屏幕与地图。

平时不必专门切到随绘幕布图层——在 Token 图层或其他任意图层下，按住快捷键并按左键拖动就能直接画。所有键位都能在**按键设置（Configure Controls）**里改。

| 按键 | 功能 |
|---|---|
| 按住 `Z` | 在屏幕上绘制 |
| 按住 `X` | 在地图上绘制 |
| 按住 `V` | 激光笔 |
| `Alt+Z` | 撤销上一笔（任意图层；图层激活时 `Ctrl+Z` 也可） |
| `Ctrl+Shift+Z` / `Ctrl+Y` | 重做（图层激活时） |
| `[` / `]` | 笔刷变细 / 变粗 |
| `Tab` | 切换屏幕 / 地图（图层激活时） |
| `Esc` | 取消正在画的笔画或多边形 |
| `Enter` | 完成多边形 |

*（按住擦除与切换图层也支持绑定，默认留空。）*

## 权限与保存

GM 可以在世界设置里调整各项操作的最低角色要求（GM 始终拥有全部权限，每个人也始终可以擦掉自己的标记）：

| 操作 | 默认角色 |
|---|---|
| 屏幕绘制 | Player |
| 地图绘制（含激光笔） | Player |
| 永久标注 | Trusted Player |
| 擦除 / 清除他人标记 | Assistant GM |
| 湿介质颜料 | Trusted Player |

权限由每个**接收端**根据 Foundry 服务器附带的发送者 ID 重新校验，不会信任消息体里自带的作者或角色字段。

玩家不能直接写场景文档，因此永久标注由在线 GM 的客户端写入 `flags.canvas-scribble.items.<id>`。如果当时没有 GM 在线或角色无权保存，标记会保留为 60 秒临时地图标记并给出提示，不会直接丢掉。单场景永久标注默认上限 1 MB（可调）和 3,000 条。

湿颜料也会自动保存：落笔时先在本地记录，并持续更新笔画，供刷新恢复；活动 GM 会在笔画结束后及约每 10 秒保存当前场景的湿度、流动颜料等模拟状态。重新加载后继续模拟，关闭期间不推进干燥；「立即晾干」负责结束流动并保存稳定沉积。检查点文件存放在 `worlds/<world>/canvas-scribble/`，并记录到场景 flags（每个场景默认预算 32 MB）。服务器保存需要活动 GM；本地恢复仅限同一浏览器，存储不可用或已满时会提示。模拟在后台 Worker 中运行；WebGL2 GPU 后端通过与 CPU 参考实现的自检后才会启用，否则由 CPU 计算（客户端设置「颜料模拟」）。

## 安装

**通过 GitHub Release：** 在 Foundry VTT 打开 **Add-on Modules → Install Module**，把最新 Release 里的 `module.json` 链接填进 **Manifest URL** 安装，然后在世界设置里启用即可。

**从源码构建**（需要 Node.js `>= 22.18`）：

```bash
npm ci
npm run build
```

将生成的 `dist/` 复制或软链接到 `Data/modules/canvas-scribble`。

## 兼容性与说明

- 声明支持 Foundry VTT **v13** 与 **v14**（`minimum: 13`, `maximum: 14`）。
- 目前仅在 Node 单元测试和浏览器模拟测试台跑过，尚未在真实 Foundry v13/v14 服务器上实测。详情见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)，已知问题见 [CHANGELOG.md](CHANGELOG.md#known-issues)。
- 所有标记都以紧凑矢量数据存储和传输（量化差分 varint 编码，约 4 字符/点），不存图片。永久标注走 512 px 瓦片缓存（按 2 的幂次缩放分级），临时与实时笔画以独立 Sprite 渲染。

## 开发

架构与测试台说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

```bash
npm ci           # 安装依赖
npm run check    # 类型检查、多语言校验、单元测试、构建与清单校验
npm run harness  # 构建浏览器测试台到 dist-dev/
npm run package  # 打包 dist/ -> release/module.zip
```

在 GitHub 发布标签为 `vX.Y.Z`（或 `X.Y.Z`）的 Release 即可：[`.github/workflows/release.yml`](.github/workflows/release.yml) 会自动从标签生成模块版本、补全仓库地址，并上传 `module.json` 与 `module.zip`，无需手动修改源码 JSON 的版本号。本地 `npm run package` 使用 `package.json` 的版本，不会写入这些 URL。

## 许可

MIT（[LICENSE](LICENSE)）。手绘笔画几何基于 [perfect-freehand](https://github.com/steveruizok/perfect-freehand)（MIT），第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
