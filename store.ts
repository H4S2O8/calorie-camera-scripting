import { Path } from "scripting"

/**
 * 本地存储：
 * - 接口地址和模型名存 JSON 文件
 * - API Key 存 Keychain
 * - 已记录的饮食存 log.json（只用来显示今日合计，权威数据在健康 App）
 */

export type Config = {
  endpoint: string
  model: string
}

export type LogEntry = {
  id: string
  time: number
  name: string
  grams: number
  kcal: number
  protein: number
  carbs: number
  fat: number
}

const DIR = Path.join(FileManager.documentsDirectory, "calorie-camera")
const CONFIG_FILE = Path.join(DIR, "config.json")
const LOG_FILE = Path.join(DIR, "log.json")
const KEY_NAME = "calorie_camera_api_key"
const LLM_CHAT_STORE = Path.join(FileManager.appGroupDocumentsDirectory, "llm-chat-store.json")
const LOG_KEEP_DAYS = 30

function ensureDir() {
  if (!FileManager.existsSync(DIR)) FileManager.createDirectorySync(DIR, true)
}

export function loadConfig(): Config {
  if (!FileManager.existsSync(CONFIG_FILE)) return { endpoint: "", model: "" }
  const raw = JSON.parse(FileManager.readAsStringSync(CONFIG_FILE))
  return {
    endpoint: typeof raw?.endpoint === "string" ? raw.endpoint : "",
    model: typeof raw?.model === "string" ? raw.model : "",
  }
}

export function saveConfig(cfg: Config) {
  ensureDir()
  FileManager.writeAsStringSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

export function loadApiKey(): string {
  return Keychain.get(KEY_NAME) ?? ""
}

export function saveApiKey(key: string) {
  if (!Keychain.set(KEY_NAME, key)) throw new Error("API Key 写入 Keychain 失败")
}

/** 读取 LLM Chat 脚本保存的接口配置；没有该脚本或没填 Key 时抛错说明原因。 */
export function readLlmChatConfig(): { endpoint: string; apiKey: string; model: string } {
  if (!FileManager.existsSync(LLM_CHAT_STORE)) {
    throw new Error("没找到 LLM Chat 的配置文件：" + LLM_CHAT_STORE)
  }
  const cfg = JSON.parse(FileManager.readAsStringSync(LLM_CHAT_STORE))?.config
  const endpoint = typeof cfg?.endpoint === "string" ? cfg.endpoint.trim() : ""
  const apiKey = typeof cfg?.apiKey === "string" ? cfg.apiKey.trim() : ""
  const model = typeof cfg?.model === "string" ? cfg.model.trim() : ""
  if (!endpoint || !apiKey) throw new Error("LLM Chat 里还没有填写接口地址或 API Key")
  return { endpoint, apiKey, model }
}

export function loadLog(): LogEntry[] {
  if (!FileManager.existsSync(LOG_FILE)) return []
  const raw = JSON.parse(FileManager.readAsStringSync(LOG_FILE))
  if (!Array.isArray(raw)) throw new Error("饮食记录文件格式错误：" + LOG_FILE)
  return raw as LogEntry[]
}

export function appendLog(entries: LogEntry[]): LogEntry[] {
  ensureDir()
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 3600 * 1000
  const next = [...loadLog(), ...entries].filter((e) => e.time >= cutoff)
  FileManager.writeAsStringSync(LOG_FILE, JSON.stringify(next, null, 2))
  return next
}

export function todayEntries(log: LogEntry[]): LogEntry[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return log.filter((e) => e.time >= start.getTime()).sort((a, b) => b.time - a.time)
}
