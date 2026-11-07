import { fetch } from "scripting"

/**
 * 调用 OpenAI 兼容的视觉模型识别食物，返回每样食物的重量和营养估算。
 * 任何一步不符合预期都直接抛错，不做默认值兜底。
 */

export type FoodItem = {
  name: string
  grams: number
  kcal: number
  protein: number
  carbs: number
  fat: number
}

export type Analysis = {
  items: FoodItem[]
  note: string
}

const TIMEOUT_SEC = 90
const MAX_SIDE_PX = 1024

const SYSTEM_PROMPT = `你是一名注册营养师，根据照片估算一餐的热量和营养。
要求：
1. 找出照片里所有能吃的食物和饮料，每样单独一项，用常见的中文名称。
2. 根据餐具、手、包装等参照物估算每样的可食部分重量（克）。
3. 参照《中国食物成分表》估算该重量下的热量（千卡）、蛋白质、碳水化合物、脂肪（克）。烹调用油要算进对应菜里。
4. 如果用户给了补充说明（例如只吃了一半、少油、某样是什么），以用户说明为准。
5. 只输出一个 JSON 对象，不要输出其他文字，格式：
{"items":[{"name":"米饭","grams":150,"kcal":174,"protein":3.9,"carbs":38.6,"fat":0.5}],"note":"一句话说明估算依据和最不确定的地方"}
所有数值都是数字。照片里没有食物时，items 为空数组，note 说明原因。`

export function completionsUrl(endpoint: string): string {
  const u = endpoint.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(u)) throw new Error("接口地址要以 http:// 或 https:// 开头")
  if (/\/chat\/completions$/i.test(u)) return u
  const path = u.replace(/^https?:\/\/[^/]+/i, "")
  if (path === "") return u + "/v1/chat/completions"
  return u + "/chat/completions"
}

/** 把照片缩到长边 1024 像素再转 JPEG，控制上传体积。 */
export function imageToDataUrl(image: UIImage): string {
  const w = image.width
  const h = image.height
  if (!(w > 0 && h > 0)) throw new Error(`照片尺寸无效：${w}×${h}`)
  const scale = Math.min(1, MAX_SIDE_PX / Math.max(w, h))
  let target: UIImage = image
  if (scale < 1) {
    const thumb = image.preparingThumbnail({ width: Math.round(w * scale), height: Math.round(h * scale) })
    if (!thumb) throw new Error("照片缩放失败")
    target = thumb
  }
  const base64 = target.toJPEGBase64String(0.75)
  if (!base64) throw new Error("照片转 JPEG 失败")
  return `data:image/jpeg;base64,${base64}`
}

export async function analyzeFood(args: {
  endpoint: string
  apiKey: string
  model: string
  imageDataUrl: string
  hint: string
}): Promise<Analysis> {
  const url = completionsUrl(args.endpoint)
  const userText = args.hint.trim()
    ? `请估算这顿饭。补充说明：${args.hint.trim()}`
    : "请估算这顿饭。"
  const body = {
    model: args.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: args.imageDataUrl } },
        ],
      },
    ],
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    timeout: TIMEOUT_SEC,
    allowInsecureRequest: url.startsWith("http://"),
    debugLabel: "calorie-camera",
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}：${raw.slice(0, 300)}`)

  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error("接口返回的不是 JSON：" + raw.slice(0, 300))
  }
  const content = data?.choices?.[0]?.message?.content
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("")
      : ""
  if (!text.trim()) throw new Error("模型没有返回内容：" + raw.slice(0, 300))
  return parseAnalysis(text)
}

function parseAnalysis(text: string): Analysis {
  const cleaned = text.replace(/```(?:json)?/gi, "")
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("模型输出里找不到 JSON：" + text.slice(0, 300))
  let obj: any
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error("模型输出的 JSON 解析失败：" + text.slice(0, 300))
  }
  if (!Array.isArray(obj?.items)) throw new Error("模型输出缺少 items 数组：" + text.slice(0, 300))

  const items: FoodItem[] = obj.items.map((it: any, i: number) => {
    const name = typeof it?.name === "string" ? it.name.trim() : ""
    if (!name) throw new Error(`第 ${i + 1} 项缺少名称`)
    const num = (key: keyof FoodItem) => {
      const v = Number(it?.[key])
      if (!Number.isFinite(v) || v < 0) throw new Error(`「${name}」的 ${key} 不是有效数字：${it?.[key]}`)
      return v
    }
    const grams = num("grams")
    if (grams <= 0) throw new Error(`「${name}」的重量必须大于 0`)
    return { name, grams, kcal: num("kcal"), protein: num("protein"), carbs: num("carbs"), fat: num("fat") }
  })
  const note = typeof obj?.note === "string" ? obj.note.trim() : ""
  return { items, note }
}
