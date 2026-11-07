# 卡路里相机（Scripting）

拍一张饭菜照片，用视觉大模型估算每样食物的重量、热量和三大营养素，核对后写入 iPhone 的健康 App。
用 [Scripting](https://scripting.fun) 的 TSX 写成，需要 Scripting 3.2.2 或更新版本。

## 用法

1. 对准饭菜点「拍照识别」，或按相机键；也可以「从相册选」。
2. 模型返回每样食物的名称、估算克数、热量、蛋白质、碳水、脂肪。
3. 克数可以改，营养素按比例跟着变；识别错的项可以删掉。
4. 「补充说明」里写「只吃了一半」「少油」之类，点「重新识别」按说明重估。
5. 点「记录到健康」，每样食物写成一条饮食记录。

## 安装

Scripting → 新建 →「从远程资源导入」，填：

```
https://github.com/H4S2O8/calorie-camera-scripting/tree/main
```

第一次运行会请求相机和健康权限。设置区填 OpenAI 兼容接口的地址、API Key 和模型名（模型要能看图），
装了 LLM Chat 脚本的话可以点「从 LLM Chat 导入」。API Key 存在 Keychain。

## 用相机键直接打开

- Scripting：更多 → 默认脚本 → Camera Control → 选「卡路里相机」
- iPhone：设置 → 相机 → 相机控制 → 选 Scripting

没有相机控制键的机型，可以在控制中心加「Scripting Camera」按钮。

## 文件

| 文件 | 内容 |
|---|---|
| `index.tsx` | 页面、相机生命周期、实体快门键 |
| `llm.ts` | 照片压缩、调用视觉模型、校验返回的 JSON |
| `health.ts` | 写入 HealthKit 饮食记录 |
| `store.ts` | 设置、API Key、本地的今日记录 |

估算误差一般在 20%–30%，油和酱料最难估，记录前看一眼克数。
