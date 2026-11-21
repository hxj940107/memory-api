// Current-turn intent only: a previous request is never permission to send again.
const normalized = text => String(text || '').normalize('NFKC').replace(/\s+/g, '')
export function isAlbumFeatureDiscussion(text) {
  const value = normalized(text)
  const discussion = /功能|跑通了|目前只做|怎么让.*相册|相册.*(?:有意思|优化|改进)|(?:实现|支持).*(?:相册|发.*照片)/.test(value)
  // A discussion can also contain a distinct immediate command.
  const command = /(?:请|帮我|直接|现在|再)(?:从相册.{0,20})?(?:发|挑|选|找|翻|看)|(?:选|挑)(?:一|两|二|三|[123])张.{0,20}发(?:给)?我/.test(value)
  return discussion && !command
}
export function albumSendLimit(text) {
  const value = normalized(text)
  if (isAlbumFeatureDiscussion(value) || /(?:不要|别|不用|不必|先不|暂不)(?:再|把[^，。！？]{0,10})?(?:发|传|给我看)/.test(value)) return 0
  // Ignore quoted instructions/examples and capability descriptions.
  const request = value.replace(/[“「『"].*?[”」』"]/g, '')
    .replace(/(?:之前|上次|刚才|已经)[^，。！？]{0,15}(?:发|传)给我的/g, '')
    .replace(/(?:让你|让他|支持|实现)(?:能|可以|能够)?[^，。！？?！;；]*/g, '')
  if (!/(?:发|传|送)[^，。！？]{0,24}(?:给我|过来)|发我|发来|发过来|给我(?:发|看看|看下|看一下)|给我看|让我看看/.test(request)) return 0
  if (/(?:一|1)张|只.{0,3}(?:一|1)张/.test(request)) return 1
  if (/(?:两|二|2)张/.test(request)) return 2
  if (/(?:三|3)张|几张|多张|这些|这几张/.test(request)) return 3
  return 1
}

// Only user turns establish relevance; the companion's own photo suggestion does not.
export function isAlbumTopicRelevant(text, recentMessages = []) {
  const value = normalized(text)
  if (isAlbumFeatureDiscussion(value)) return false
  if (/(?:不要|不想|别|不用|不必|先不|暂不)(?:再)?(?:聊|谈|提|看|翻|找).{0,8}(?:照片|相片|相册)|(?:不聊|不谈|不提).{0,8}(?:照片|相片|相册)|不给看|换话题|别聊这个|^(?:换个|换一)(?:个|话题)?$/.test(value)) return false
  if (/(?:照片|相片|相册|拍的|拍过的)/.test(value)) return true
  // Short follow-ups may refer to an immediately preceding user-led album topic.
  if (!/^(?:好[的啊呀]?|可以|行|看看|看一下|继续|你直接发给我|直接发给我|发给我|给我看看|就这张|那张|这张|再来一张|换一张|第?[一二三123]张)[。！!？?]*$/.test(value)) return false
  const prior = recentMessages.filter(m => m.role === 'user' && typeof m.content === 'string')
    .filter(m => normalized(m.content) !== value).slice(-1)[0]
  return !!prior && isAlbumTopicRelevant(prior.content)
}
