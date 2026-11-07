import {
  Button, CaptureVideoPreviewView, HStack, Image, List, Navigation, NavigationStack,
  ProgressView, Script, SecureField, Section, Spacer, Text, TextField, VStack,
  useEffect, useRef, useState,
} from "scripting"
import type { CameraControlParameter } from "scripting"
import { analyzeFood, imageToDataUrl, type FoodItem } from "./llm"
import { saveFoodToHealth } from "./health"
import {
  appendLog, loadApiKey, loadConfig, loadLog, readLlmChatConfig, saveApiKey, saveConfig,
  todayEntries, type LogEntry,
} from "./store"

// ---------- 相机生命周期（结构照抄官方 Camera Control DEMO） ----------

let alive = true
let closing = false
let incoming: CameraControlParameter | null = Script.cameraControlParameter
let receive: (batch: CameraControlParameter | null) => void = (batch) => {
  if (batch) incoming = batch
}
const unsubscribe = Script.onResume((event) => {
  if (!closing) receive(event.cameraControlParameter)
})
let ownedSession: AVCaptureSession | null = null
let stopping: Promise<void> = Promise.resolve()

async function stopCamera() {
  const session = ownedSession
  ownedSession = null
  const previous = stopping
  const current = session
    ? session.stopRunning().finally(() => session.dispose())
    : Promise.resolve()
  stopping = Promise.all([previous, current]).then(() => {}, () => {})
  await Promise.all([previous, current])
}

// ---------- 工具函数 ----------

type CameraState = { session: AVCaptureSession; device: AVCaptureDevice; photo: AVCapturePhotoOutput }
type EditableItem = { id: string; base: FoodItem; gramsText: string }

function scaled(item: EditableItem): FoodItem | null {
  const g = Number(item.gramsText.trim())
  if (!item.gramsText.trim() || !Number.isFinite(g) || g <= 0) return null
  const r = g / item.base.grams
  return {
    name: item.base.name,
    grams: g,
    kcal: item.base.kcal * r,
    protein: item.base.protein * r,
    carbs: item.base.carbs * r,
    fat: item.base.fat * r,
  }
}

function fmt(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

function timeStr(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------- 页面 ----------

function App() {
  const dismiss = Navigation.useDismiss()
  const [camera, setCamera] = useState<CameraState | null>(null)
  const [busy, setBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [message, setMessage] = useState("相机启动中…")
  const [error, setError] = useState("")
  const [photo, setPhoto] = useState<UIImage | null>(null)
  const [items, setItems] = useState<EditableItem[]>([])
  const [note, setNote] = useState("")
  const [hint, setHint] = useState("")
  const [log, setLog] = useState<LogEntry[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")

  const working = useRef(false)
  const revision = useRef(0)
  const pendingCamera = useRef(false)
  const pendingBatch = useRef<CameraControlParameter | null>(null)
  const currentCamera = useRef<CameraState | null>(camera)
  currentCamera.current = camera
  const lastDataUrl = useRef("")

  async function run(action: () => Promise<void>) {
    if (!alive || closing || working.current) return
    const startedAt = revision.current
    working.current = true
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (e) {
      if (alive && revision.current === startedAt) setError(errText(e))
    } finally {
      working.current = false
      if (alive) {
        setBusy(false)
        if (pendingBatch.current) void run(processPendingBatch)
        else if (pendingCamera.current) void run(startCamera)
      }
    }
  }

  async function startCamera() {
    pendingCamera.current = false
    const startedAt = revision.current
    const existing = currentCamera.current
    if (existing && ownedSession === existing.session && existing.session.isRunning) return
    currentCamera.current = null
    setCamera(null)
    await stopCamera()
    if (!alive || closing || revision.current !== startedAt) return
    const device = AVCaptureDevice.default("video")
    if (!device) throw new Error("没有可用的摄像头")
    const session = new AVCaptureSession()
    const photoOutput = new AVCapturePhotoOutput()
    ownedSession = session
    try {
      const input = new AVCaptureDeviceInput(device)
      session.configure(() => {
        if (!session.canAddInput(input)) throw new Error("无法添加摄像头输入")
        session.addInput(input)
        if (!session.canAddOutput(photoOutput)) throw new Error("无法添加拍照输出")
        session.addOutput(photoOutput)
        if (session.supportsControls) {
          const zoom = new AVCaptureSystemZoomSlider(device)
          if (session.canAddControl(zoom)) session.addControl(zoom)
          session.setControlsDelegate({
            didBecomeActive() {}, willEnterFullscreenAppearance() {},
            willExitFullscreenAppearance() {}, didBecomeInactive() {},
          })
        }
      })
      await session.startRunning()
      if (!alive || closing || revision.current !== startedAt || ownedSession !== session) {
        session.dispose()
        if (ownedSession === session) ownedSession = null
        return
      }
      currentCamera.current = { session, device, photo: photoOutput }
      setCamera(currentCamera.current)
      setMessage("对准饭菜，点「拍照识别」或按相机键")
    } catch (e) {
      session.dispose()
      if (ownedSession === session) ownedSession = null
      throw e
    }
  }

  async function closeApp() {
    if (closing) return
    closing = true
    unsubscribe()
    revision.current += 1
    pendingCamera.current = false
    pendingBatch.current = null
    setBusy(true)
    setMessage("正在关闭相机…")
    try {
      await stopCamera()
    } catch (e) {
      setError(errText(e))
    } finally {
      dismiss()
    }
  }

  async function runAnalysis(dataUrl: string, hintText: string) {
    const cfg = loadConfig()
    const key = loadApiKey()
    if (!cfg.endpoint.trim() || !cfg.model.trim() || !key) {
      setShowSettings(true)
      throw new Error("请先在设置里填写接口地址、API Key 和模型，然后点「重新识别」")
    }
    setAnalyzing(true)
    setMessage("识别中…")
    try {
      const res = await analyzeFood({
        endpoint: cfg.endpoint, apiKey: key, model: cfg.model, imageDataUrl: dataUrl, hint: hintText,
      })
      if (!alive) return
      const stamp = Date.now()
      setItems(res.items.map((it, i) => ({ id: `${stamp}-${i}`, base: it, gramsText: fmt(it.grams) })))
      setNote(res.note)
      setMessage(res.items.length
        ? `识别出 ${res.items.length} 样，核对重量后点「记录到健康」`
        : "没有识别到食物")
    } finally {
      if (alive) setAnalyzing(false)
    }
  }

  async function analyzeImage(image: UIImage) {
    const dataUrl = imageToDataUrl(image)
    lastDataUrl.current = dataUrl
    setPhoto(image)
    setItems([])
    setNote("")
    setHint("")
    await runAnalysis(dataUrl, "")
  }

  async function captureAndAnalyze() {
    const current = currentCamera.current
    if (!current || ownedSession !== current.session) throw new Error("相机还没准备好")
    setMessage("拍照中…")
    const result = await current.photo.capturePhoto({ codec: "jpeg" })
    if (!alive || closing) return
    await analyzeImage(result.image)
  }

  async function pickFromAlbum() {
    const images = await Photos.pickPhotos(1)
    if (!images.length) return
    await analyzeImage(images[0])
  }

  async function processPendingBatch() {
    const batch = pendingBatch.current
    pendingBatch.current = null
    if (!batch) return
    const asset = batch.assets.find((a) => a.type === "photo")
    if (!asset) throw new Error("收到的文件里没有照片")
    const image = UIImage.fromFile(asset.filePath)
    if (!image) throw new Error("无法读取照片：" + asset.filePath)
    await analyzeImage(image)
  }

  async function reanalyze() {
    if (!lastDataUrl.current) throw new Error("没有可以重新识别的照片")
    await runAnalysis(lastDataUrl.current, hint)
  }

  async function saveAll() {
    const list = items.map(scaled)
    if (!list.length) throw new Error("没有要记录的食物")
    if (list.some((x) => !x)) throw new Error("有一项重量填得不对，请改成大于 0 的数字")
    const now = new Date()
    const saved: LogEntry[] = []
    try {
      for (const f of list as FoodItem[]) {
        await saveFoodToHealth(f, now)
        saved.push({
          id: `${now.getTime()}-${saved.length}`, time: now.getTime(), name: f.name,
          grams: f.grams, kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat,
        })
      }
    } finally {
      if (saved.length) setLog(todayEntries(appendLog(saved)))
    }
    const total = saved.reduce((s, e) => s + e.kcal, 0)
    setPhoto(null)
    setItems([])
    setNote("")
    setHint("")
    lastDataUrl.current = ""
    setMessage(`已记录到健康：${Math.round(total)} 千卡`)
  }

  function discard() {
    setPhoto(null)
    setItems([])
    setNote("")
    setHint("")
    lastDataUrl.current = ""
    setMessage("对准饭菜，点「拍照识别」或按相机键")
  }

  function updateGrams(id: string, text: string) {
    setItems(items.map((it) => (it.id === id ? { ...it, gramsText: text } : it)))
  }

  function removeItem(id: string) {
    setItems(items.filter((it) => it.id !== id))
  }

  function importFromLlmChat() {
    try {
      const c = readLlmChatConfig()
      setEndpoint(c.endpoint)
      setApiKey(c.apiKey)
      setModel(c.model)
      setError("")
      setMessage("已从 LLM Chat 导入。确认这个模型能看图，再点「保存设置」")
    } catch (e) {
      setError(errText(e))
    }
  }

  function saveSettings() {
    try {
      if (!endpoint.trim() || !apiKey.trim() || !model.trim()) {
        throw new Error("接口地址、API Key、模型三项都要填")
      }
      saveConfig({ endpoint: endpoint.trim(), model: model.trim() })
      saveApiKey(apiKey.trim())
      setShowSettings(false)
      setError("")
      setMessage("设置已保存")
    } catch (e) {
      setError(errText(e))
    }
  }

  useEffect(() => {
    try {
      const cfg = loadConfig()
      const key = loadApiKey()
      setEndpoint(cfg.endpoint)
      setModel(cfg.model)
      setApiKey(key)
      if (!cfg.endpoint || !cfg.model || !key) setShowSettings(true)
      setLog(todayEntries(loadLog()))
    } catch (e) {
      setError("读取本地数据失败：" + errText(e))
    }

    receive = (batch) => {
      if (!alive || closing) return
      if (batch) {
        pendingBatch.current = batch
        if (!working.current) void run(processPendingBatch)
        return
      }
      // 从相机键或后台回来：相机没在跑就重新启动。
      pendingCamera.current = true
      if (!working.current) void run(startCamera)
    }

    if (incoming) {
      pendingBatch.current = incoming
      incoming = null
    }
    pendingCamera.current = true
    void run(startCamera)
    return () => {
      receive = () => {}
      currentCamera.current = null
    }
  }, [])

  const scaledItems = items.map(scaled)
  const allValid = items.length > 0 && scaledItems.every((x) => x !== null)
  const totalKcal = scaledItems.reduce((s, x) => s + (x ? x.kcal : 0), 0)
  const todayKcal = log.reduce((s, e) => s + e.kcal, 0)

  return (
    <NavigationStack
      onCameraCaptureEvent={{
        isEnabled: !!camera,
        primaryAction: (event) => {
          if (event.phase === "ended") void run(captureAndAnalyze)
        },
      }}
    >
      <VStack spacing={0}>
        {camera ? (
          <CaptureVideoPreviewView
            session={camera.session}
            videoDevice={camera.device}
            frame={{ maxWidth: "infinity", height: 260 }}
          />
        ) : (
          <VStack frame={{ maxWidth: "infinity", height: 260 }} background="black">
            <Text foregroundStyle="white">{busy ? "相机启动中…" : "相机未启动"}</Text>
            {!busy ? (
              <Button title="启动相机" action={() => { void run(startCamera) }} />
            ) : null}
          </VStack>
        )}
        <List
          navigationTitle="卡路里相机"
          navigationBarTitleDisplayMode="inline"
          toolbar={{
            cancellationAction: <Button title="关闭" action={() => { void closeApp() }} />,
            topBarTrailing: (
              <Button title={showSettings ? "收起设置" : "设置"} action={() => setShowSettings(!showSettings)} />
            ),
          }}
        >
          <Section>
            <HStack>
              <Button
                title="拍照识别"
                systemImage="camera.fill"
                buttonStyle="borderless"
                disabled={busy || !camera}
                action={() => { void run(captureAndAnalyze) }}
              />
              <Spacer />
              <Button
                title="从相册选"
                systemImage="photo"
                buttonStyle="borderless"
                disabled={busy}
                action={() => { void run(pickFromAlbum) }}
              />
            </HStack>
            <Text font="footnote" foregroundStyle="secondaryLabel">{message}</Text>
            {error ? <Text font="footnote" foregroundStyle="systemRed">{error}</Text> : null}
            <HStack>
              <Text>今日已记录</Text>
              <Spacer />
              <Text font="headline">{`${Math.round(todayKcal)} 千卡`}</Text>
            </HStack>
          </Section>

          {showSettings ? (
            <Section header={<Text>模型设置（OpenAI 兼容接口，模型要能看图）</Text>}>
              <TextField title="接口地址" value={endpoint} onChanged={setEndpoint} prompt="https://api.openai.com/v1" />
              <SecureField title="API Key" value={apiKey} onChanged={setApiKey} prompt="sk-..." />
              <TextField title="模型" value={model} onChanged={setModel} prompt="gpt-4o-mini" />
              <Button title="从 LLM Chat 导入" buttonStyle="borderless" action={importFromLlmChat} />
              <Button title="保存设置" buttonStyle="borderless" action={saveSettings} />
            </Section>
          ) : null}

          {photo ? (
            <Section header={<Text>识别结果</Text>}>
              <Image image={photo} resizable scaleToFit frame={{ height: 160 }} />
              {analyzing ? (
                <HStack spacing={8}>
                  <ProgressView />
                  <Text foregroundStyle="secondaryLabel">识别中…</Text>
                </HStack>
              ) : null}
              {items.map((item) => {
                const s = scaled(item)
                return (
                  <VStack key={item.id} alignment="leading" spacing={6}>
                    <HStack>
                      <Text font="headline">{item.base.name}</Text>
                      <Spacer />
                      <Text font="headline">{s ? `${Math.round(s.kcal)} 千卡` : "重量无效"}</Text>
                    </HStack>
                    <HStack spacing={6}>
                      <TextField
                        title="克"
                        value={item.gramsText}
                        onChanged={(v: string) => updateGrams(item.id, v)}
                        keyboardType="decimalPad"
                        textFieldStyle="roundedBorder"
                        frame={{ width: 72 }}
                      />
                      <Text font="footnote">克</Text>
                      <Text font="caption" foregroundStyle="secondaryLabel">
                        {s ? `蛋白 ${fmt(s.protein)} · 碳水 ${fmt(s.carbs)} · 脂肪 ${fmt(s.fat)}` : ""}
                      </Text>
                      <Spacer />
                      <Button
                        title="删除"
                        buttonStyle="borderless"
                        foregroundStyle="systemRed"
                        action={() => removeItem(item.id)}
                      />
                    </HStack>
                  </VStack>
                )
              })}
              {items.length ? (
                <HStack>
                  <Text font="headline">合计</Text>
                  <Spacer />
                  <Text font="headline">{`${Math.round(totalKcal)} 千卡`}</Text>
                </HStack>
              ) : null}
              {note ? <Text font="footnote" foregroundStyle="secondaryLabel">{note}</Text> : null}
              <TextField
                title="补充说明"
                value={hint}
                onChanged={setHint}
                prompt="例如：只吃了一半、少油、汤没喝"
              />
              <HStack>
                <Button
                  title="重新识别"
                  buttonStyle="borderless"
                  disabled={busy}
                  action={() => { void run(reanalyze) }}
                />
                <Spacer />
                <Button title="放弃" buttonStyle="borderless" disabled={busy} action={discard} />
                <Spacer />
                <Button
                  title="记录到健康"
                  buttonStyle="borderless"
                  disabled={busy || !allValid}
                  action={() => { void run(saveAll) }}
                />
              </HStack>
            </Section>
          ) : null}

          {log.length ? (
            <Section header={<Text>今日记录</Text>}>
              {log.map((e) => (
                <HStack key={e.id}>
                  <Text>{`${timeStr(e.time)}  ${e.name}`}</Text>
                  <Spacer />
                  <Text foregroundStyle="secondaryLabel">{`${Math.round(e.grams)} 克 · ${Math.round(e.kcal)} 千卡`}</Text>
                </HStack>
              ))}
            </Section>
          ) : null}
        </List>
      </VStack>
    </NavigationStack>
  )
}

async function main() {
  try {
    await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" })
  } finally {
    closing = true
    alive = false
    unsubscribe()
    try {
      await stopCamera()
    } finally {
      Script.exit()
    }
  }
}

void main()
