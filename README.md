# 痛车工坊 · Livery Lab

Porsche Taycan 痛车图案 3D 预览工具。纯个人同人用途。

## 怎么打开

```bash
cd ~/itasha3d
python3 -m http.server 8899
```

然后浏览器访问 `http://localhost:8899`

> 必须用 HTTP 服务打开，直接双击 index.html 会因为浏览器安全策略加载不了模型。

## 怎么用

1. **上传图案** — 点左侧虚线框，选你的图（PNG / JPG / WEBP）
2. **选投影面** — 左侧 / 右侧 / 引擎盖 / 车顶 / 车尾
3. **调位置** — 拖动滑块调水平、垂直、深度、大小、旋转
4. **导出** — 右下角按钮，输出 2 倍分辨率 PNG

左侧会自动水平镜像，让图案的车头方向和真车对齐。

## 换车型

改 `app.js` 第 9 行：

```js
const MODEL_PATH = './assets/taycan_raw.glb';
```

把新模型放进 `assets/` 目录，改这一行即可。

**模型要求：**
- glTF / GLB 格式（FBX 需先转换，见下）
- 15 万–50 万三角面（超过网页会卡）
- 车身漆面最好单独一个材质，命名含 `corpus` 或 `body`

如果车身网格识别不到，程序会自动选表面积最大的网格（`findLargestMesh`）。

## 模型处理流程（这次是怎么做的）

原始文件：77MB FBX（300 万三角面），网页跑不动。

```bash
# 1. FBX 转 GLB
FB=~/.openclaw/tools/node-v24.15.0/lib/node_modules/fbx2gltf/bin/Darwin/FBX2glTF
$FB -i source.fbx -o out.glb --binary

# 2. 减面（300万 → 36万）
CLI=~/.openclaw/tools/node-v24.15.0/lib/node_modules/gltfpack/cli.js
node "$CLI" -i in.glb -o taycan_raw.glb -si 0.12
```

> 注意：`-tc`（纹理压缩）在 node/wasm 版 gltfpack 里不支持，会报 BasisU 错误。要去掉。

## 已知限制

| 项 | 说明 |
|---|---|
| 引擎盖 | 车头是斜面，平面投影会拉伸，效果比侧面淡 |
| 效果图 vs 平面稿 | 上传渲染图（带背景、带车身）时，图案自带的背景也会贴上去 |
| 车身噪点 | 原始模型的漆面贴图自带污渍，不是渲染错误 |

**想要最干净的效果，需要透明底的平面稿**（只留贴花，抠掉背景和车）。

## 文件结构

```
itasha3d/
├── index.html          界面
├── app.js              3D 逻辑（Three.js）
├── style.css           样式
├── assets/
│   ├── taycan_raw.glb  Taycan 模型（6.1MB）
│   └── car.glb         原始 Ferrari 占位模型（可删）
└── vendor/             Three.js 及插件（本地化，离线可用）
```

## 坐标系备忘（重要）

这个 Taycan 模型：**车长沿 Z 轴，车宽沿 X 轴，车头朝 +Z**。

- 左右侧面 → X 轴法线
- 车头/车尾 → Z 轴
- 车顶/引擎盖 → Y 轴

如果换的模型轴向不同，改 `decalPose()` 里的 normal 和 pos 计算。
