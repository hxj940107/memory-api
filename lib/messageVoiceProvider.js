import { createMiniMaxSpeechSynthesizer } from "./minimaxSpeech.js"

export function getMessageVoiceSynthesizer() {
  return createMiniMaxSpeechSynthesizer()
}
