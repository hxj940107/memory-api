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
