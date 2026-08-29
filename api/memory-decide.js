import { judgeMemory } from "../lib/memoryJudge.js"
import { requirePrivateAppRequest } from "../lib/privateAppAuth.js"

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      })
    }

    const { message } = req.body || {}

    if (!message) {
      return res.status(400).json({
        error: "message is required"
      })
    }

    const result = await judgeMemory(message)

    return res.status(200).json({
      save: result.save,
      memory: result.content
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}
