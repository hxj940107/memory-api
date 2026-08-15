export const MOMENT_IMAGE_LIBRARY = [
  { id: "cafe-iced-coffee-sunlight", file: "cafe-iced-coffee-sunlight.jpg", aspectRatio: 3 / 4, description: "晴天咖啡店，一杯加苹果片的冰咖啡，明亮日常", timePeriods: ["morning", "daytime"], keywords: ["咖啡", "喝", "饮料", "店"] },
  { id: "cafe-rainy-window-latte", file: "cafe-rainy-window-latte.jpg", aspectRatio: 4 / 3, description: "雨天傍晚坐在咖啡店窗边，桌上一杯拿铁", timePeriods: ["daytime", "evening"], weather: "rain", keywords: ["咖啡", "拿铁", "店", "窗边"] },
  { id: "cafe-rainy-window-cheesecake", file: "cafe-rainy-window-cheesecake.jpg", aspectRatio: 3 / 4, description: "雨天咖啡店窗边，热饮和一块芝士蛋糕", timePeriods: ["daytime", "evening"], weather: "rain", keywords: ["咖啡", "蛋糕", "甜品", "店", "窗边"] },
  { id: "cafe-rainy-window-wide", file: "cafe-rainy-window-wide.jpg", aspectRatio: 4 / 3, description: "雨天咖啡店室内广角，窗外湿润街道，安静暖光", timePeriods: ["daytime", "evening"], weather: "rain", keywords: ["咖啡", "店", "窗边", "坐"] },
  { id: "cafe-sunlit-reading", file: "cafe-sunlit-reading.jpg", aspectRatio: 3 / 4, description: "晴天下午咖啡店窗边，冰咖啡和翻开的书", timePeriods: ["daytime"], keywords: ["咖啡", "看书", "读", "店", "下午"] },
  { id: "residential-walk-after-rain", file: "residential-walk-after-rain.jpg", aspectRatio: 4 / 3, description: "雨后现代住宅区夜路，路灯映在湿地面上", timePeriods: ["evening", "night"], weather: "rain", keywords: ["散步", "走", "路上", "回家", "小区"] },
  { id: "cafe-doorway-orange-cat", file: "cafe-doorway-orange-cat.jpg", aspectRatio: 3 / 4, description: "咖啡店门口偶遇一只安静坐着的橘猫", timePeriods: ["morning", "daytime"], keywords: ["猫", "橘猫", "小动物"] },
  { id: "neighborhood-street-cat", file: "neighborhood-street-cat.jpg", aspectRatio: 3 / 4, description: "晴天生活街区路边偶遇一只蹲着的猫", timePeriods: ["morning", "daytime"], keywords: ["猫", "小动物", "路边"] },
  { id: "cafe-coffee-croissant", file: "cafe-coffee-croissant.jpg", aspectRatio: 3 / 4, description: "咖啡店里的咖啡、可颂和一份随手早餐", timePeriods: ["morning", "daytime"], keywords: ["咖啡", "早餐", "可颂", "吃", "店"] },
  { id: "rainy-roadside-flowers", file: "rainy-roadside-flowers.jpg", aspectRatio: 3 / 4, description: "雨中路边的小黄花和积水，偶然发现的细节", timePeriods: ["morning", "daytime", "evening"], weather: "rain", keywords: ["花", "路边", "散步", "走"] },
  { id: "night-blossom-streetlight", file: "night-blossom-streetlight.jpg", aspectRatio: 3 / 4, description: "深蓝夜色里，路灯照亮头顶的花枝", timePeriods: ["evening", "night"], keywords: ["花", "路灯", "夜", "走", "散步"] },
  { id: "rainy-driver-evening", file: "rainy-driver-evening.jpg", aspectRatio: 3 / 2, description: "雨天傍晚驾驶位等红灯，城市灯光透过车窗雨滴", timePeriods: ["evening", "night"], weather: "rain", keywords: ["开车", "下班", "回家", "通勤", "车窗", "红灯", "路上"] },
  { id: "green-path-after-rain", file: "green-path-after-rain.jpg", aspectRatio: 3 / 2, description: "雨后城市里的安静绿荫小路，湿润自然", timePeriods: ["morning", "daytime", "evening"], weather: "rain", keywords: ["散步", "走", "小路", "雨后", "绿"] },
  { id: "cafe-window-cat", file: "cafe-window-cat.jpg", aspectRatio: 3 / 2, description: "咖啡店窗边偶遇小猫，生活化随手拍", timePeriods: ["morning", "daytime", "evening"], keywords: ["猫", "小动物", "咖啡", "店"] },
  { id: "city-driver-day", file: "city-driver-day.jpg", aspectRatio: 3 / 2, description: "白天驾驶位经过现代城市道路，普通通勤瞬间", timePeriods: ["morning", "daytime"], keywords: ["开车", "通勤", "上班", "下班", "路上", "红灯"] },
  { id: "night-desk", file: "night-desk.jpg", aspectRatio: 3 / 4, description: "深夜现代书桌，电脑、水杯和暖色小灯", timePeriods: ["night", "lateNight"], keywords: ["电脑", "书桌", "工作", "写", "代码", "没睡", "夜"] },
  { id: "night-city-walk", file: "night-city-walk.jpg", aspectRatio: 3 / 2, description: "夜晚独自走过安静的现代城市街道", timePeriods: ["evening", "night"], keywords: ["散步", "走", "路上", "回家", "夜", "路灯"] },
  { id: "rainy-window-city", file: "rainy-window-city.jpg", aspectRatio: 3 / 2, description: "雨后从室内窗边望向城市，玻璃有雨滴和柔和灯光", timePeriods: ["daytime", "evening", "night"], weather: "rain", keywords: ["窗", "雨", "发呆", "看外面"] },
]

const RAIN_PATTERN = /雨|下雨|雨后|雨天|淋湿|积水|湿漉|阴天/
const SNOW_PATTERN = /雪|下雪|雪天|积雪/

function getMomentPeriod(hour) {
  if (hour < 6) return "lateNight"
  if (hour < 9) return "earlyMorning"
  if (hour < 12) return "morning"
  if (hour < 18) return "afternoon"
  if (hour < 22) return "evening"
  return "night"
}

function getMomentTextPeriod(text, fallbackHour) {
  const value = String(text || "")

  if (/凌晨|半夜|深夜/.test(value)) return "lateNight"
  if (/清晨|天刚亮/.test(value)) return "earlyMorning"
  if (/早上|早晨|上午|早餐/.test(value)) return "morning"
  if (/中午|下午|午后|白天/.test(value)) return "afternoon"
  if (/傍晚|下班/.test(value)) return "evening"
  if (/今晚|晚上|夜里|夜晚/.test(value)) return "night"

  return getMomentPeriod(fallbackHour)
}

export function getMomentImagePromptCatalog(images = MOMENT_IMAGE_LIBRARY) {
  return images
    .map(image => `- ${image.id}：${image.description}；适用时段 ${image.timePeriods.join("/")}`)
    .join("\n")
}

export function isMomentImageCompatible(
  imageId,
  text,
  localHour,
  images = MOMENT_IMAGE_LIBRARY,
  sourceText = text
) {
  const image = images.find(item => item.id === imageId)

  if (!image) return false

  const value = String(text || "")
  const source = String(sourceText || "")
  const period = getMomentTextPeriod(value, localHour)
  const compatiblePeriods = period === "earlyMorning"
    ? ["earlyMorning", "morning"]
    : period === "morning"
      ? ["morning", "daytime"]
      : period === "afternoon"
        ? ["afternoon", "daytime"]
        : [period]
  const matchesPeriod = compatiblePeriods.some(item => image.timePeriods.includes(item))
  const matchesScene = image.keywords.some(keyword => value.includes(keyword))
  const matchesSource = image.keywords.some(keyword => source.includes(keyword))
  const matchesWeather = image.weather === "rain"
    ? RAIN_PATTERN.test(value) && RAIN_PATTERN.test(source)
    : image.weather === "snow"
      ? SNOW_PATTERN.test(value) && SNOW_PATTERN.test(source)
      : image.weather === "sunny"
        ? !RAIN_PATTERN.test(value) && !SNOW_PATTERN.test(value)
        : true

  return matchesPeriod && matchesScene && matchesSource && matchesWeather
}

export function resolveMomentImage(imageId, baseUrl, images = MOMENT_IMAGE_LIBRARY) {
  const image = images.find(item => item.id === imageId)
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/$/, "")

  if (!image) return null

  if (image.albumAssetId) {
    return JSON.stringify({
      albumAssetId: image.albumAssetId,
      aspectRatio: image.aspectRatio,
    })
  }

  if (!normalizedBaseUrl) return null

  return JSON.stringify({
    url: `${normalizedBaseUrl}/moments/library/${image.file}`,
    aspectRatio: image.aspectRatio,
    libraryId: image.id,
  })
}
