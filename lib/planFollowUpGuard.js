const GOODBYE_TIME_EXPRESSION = "(?:今天|明天|后天|早上|上午|中午|下午|傍晚|晚上|今晚|待会儿?|等会儿?|一会儿?|回头|晚点)"
const GOODBYE_ENDING = new RegExp(
  `(?:^|[\\s，。！？!?])${GOODBYE_TIME_EXPRESSION}(?:再)?见(?:啦|了|哦|呀|啊|哈)?[\\s，。！？!?~～]*$`
)

const REAL_MEETING_EVIDENCE = [
  /(?:见面|碰面|会面|约会)/,
  /见(?:医生|朋友|客户|同事|家人|亲戚|老师|领导|对象|网友|面试官)/,
  /(?:去|出门|到|在|约|和|跟|陪).{0,18}(?:见|碰面|会面)/,
  /(?:医院|诊所|公司|办公室|学校|商场|餐厅|饭店|咖啡店|机场|车站|楼下|家里).{0,10}见/,
  /(?:\d{1,2}|[一二三四五六七八九十两]+)点(?:半|[一二三四五六七八九十]+分)?[^，。！？!?]{0,12}见/,
]

function contextText(context) {
  return (context?.items || [])
    .map(item => `${item?.topic || ""} ${item?.context || ""}`)
    .join(" ")
}

export function hasRealWorldMeetingEvidence(message, activeContext) {
  const text = `${String(message || "")} ${contextText(activeContext)}`
  return REAL_MEETING_EVIDENCE.some(pattern => pattern.test(text))
}

export function isConversationalMeetingGoodbye(message, activeContext) {
  const text = String(message || "").trim()
  if (!GOODBYE_ENDING.test(text)) return false
  return !hasRealWorldMeetingEvidence(text, activeContext)
}
