/**
 * speech.ts — Web Speech API (SpeechRecognition) wrapper
 */

type RecognitionResult = {
  transcript: string
  confidence: number
}

type RecognitionCallback = (result: RecognitionResult | null, error?: string) => void

export function startSpeechRecognition(callback: RecognitionCallback): () => void {
  const SpeechRecognitionClass =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

  if (!SpeechRecognitionClass) {
    callback(null, 'not-supported')
    return () => {}
  }

  const recognition = new SpeechRecognitionClass()
  recognition.lang = 'zh-CN'
  recognition.continuous = false
  recognition.interimResults = false
  recognition.maxAlternatives = 1

  let resultFired = false

  recognition.onresult = (event: any) => {
    resultFired = true
    if (!event.results?.[0]?.[0]) {
      callback(null, 'no-results')
      return
    }
    const result = event.results[0][0]
    callback({ transcript: result.transcript, confidence: result.confidence })
  }

  recognition.onerror = (event: any) => {
    resultFired = true
    callback(null, event.error)
  }

  recognition.onend = () => {
    if (!resultFired) {
      callback(null, 'no-speech')
    }
  }

  try {
    recognition.start()
  } catch (err) {
    resultFired = true
    callback(null, 'start-failed')
    return () => {}
  }

  // Return cleanup function
  return () => {
    try {
      recognition.abort()
    } catch {
      /* ignore */
    }
  }
}
