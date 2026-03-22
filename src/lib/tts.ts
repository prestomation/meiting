// Web Speech API wrapper for Chinese TTS

import { getStorage, KEYS } from './storage'

export function isSupported(): boolean {
  return 'speechSynthesis' in window
}

export function getZhVoices(): SpeechSynthesisVoice[] {
  if (!isSupported()) return []
  return window.speechSynthesis.getVoices().filter((v) => v.lang.includes('zh'))
}

export function speak(text: string, voiceName?: string): void {
  if (!isSupported()) return
  stopSpeaking()

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'

  const targetName = voiceName ?? getStorage(KEYS.PREFERRED_VOICE)
  if (targetName) {
    const voices = window.speechSynthesis.getVoices()
    const match = voices.find((v) => v.name === targetName)
    if (match) utterance.voice = match
  }

  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (!isSupported()) return
  window.speechSynthesis.cancel()
}
