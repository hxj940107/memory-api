const normalizeKind = value => {
  if (value === "screenshot" || value === "photo") return value
  return "unknown"
}

export function normalizeImageKinds(values, imageCount) {
  const kinds = Array.isArray(values)
    ? values.slice(0, imageCount).map(normalizeKind)
    : []

  while (kinds.length < imageCount) kinds.push("unknown")
  return kinds
}

function formatImageHints(imageKinds) {
  return imageKinds
    .map((kind, index) => {
      const label = kind === "screenshot"
        ? "可能是截图"
        : kind === "photo"
          ? "可能是普通照片"
          : "类型未确定"
      return `图片${index + 1}:${label}`
    })
    .join("；")
}

export function buildImageUnderstandingContext(imageKinds) {
  if (!imageKinds.length) return ""

  return `【Image Understanding｜本轮图片理解】
客户端低成本初筛：${formatImageHints(imageKinds)}。这只是辅助线索，必须以实际画面为准。
如果画面明显是社交媒体、聊天记录或 App 截图，先识别界面层级，再理解正文内容；不要把 UI 装饰当成用户分享的内容。
朋友圈截图中：作者头像不是正文配图，评论区头像不是正文配图；昵称、时间、点赞评论按钮属于界面元素；只有正文发布区域实际附带的大图或图片网格才是正文配图。如果正文区域没有图片，必须理解为纯文字朋友圈，不要因为页面存在头像就声称有配图。
聊天截图中：区分对话参与者、聊天气泡正文和气泡内实际发送的图片；头像、表情按钮、输入栏、状态栏和其他 UI 图标都不是聊天中实际发送的图片。
普通生活照片仍按自然视觉内容理解，不要套用截图字段或界面分析口吻。`
}

export function buildImageDescriptionPrompt(imageKinds) {
  return `你正在为后续聊天建立一条小C的视觉记忆笔记。客户端低成本初筛为：${formatImageHints(imageKinds)}。初筛只作辅助，必须以画面为准。

先判断每张图是普通照片，还是朋友圈、聊天记录、社交媒体或 App UI 截图。

如果是朋友圈截图，使用紧凑单行格式：类型：朋友圈截图；作者：…；正文：…；正文配图：无/1张/多图及关键内容；互动：评论、点赞或回复的关键信息。作者头像、评论区头像、昵称、时间、点赞评论按钮和 UI 图标都不是正文配图。正文发布区域没有大图或图片网格时，必须写“正文配图：无”，不得把头像误判成配图。

如果是聊天截图，使用紧凑单行格式：类型：聊天截图；参与者：…；主要内容：…；实际图片：无/有及关键内容。头像、表情按钮、输入栏和 UI 图标不是聊天中实际发送的图片。

其他 App 截图要保留页面类型、主要区域、核心文字和真实内容层级。普通生活照片则自然描述主体、关键物体、可见文字、数量、颜色、位置、环境及有画面依据的情绪线索，不要强行套用截图字段。

总长度不超过180个中文字符，只输出一段连续纯文本，不要标题、Markdown、列表或换行；不要直接回复用户、提问、使用聊天句式、夸赞用户或推测看不见的信息。尤其谨慎区分猫、狗等相似宠物，无法确定时只写可确认特征。`
}
