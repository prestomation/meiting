import { useEffect, useRef, useState } from 'react'
import { isSupported, speak, stopSpeaking } from '../lib/tts'
import { getPreferredVoice, setPreferredVoice, getPlaybackRate } from '../lib/storage'
import './VoiceTest.css'

const TEST_SENTENCE = '你好，欢迎来到美听！今天我们来练习一下听力。'

interface PollyEntry {
  label: string
  file: string
  tag: string
}

const POLLY_SAMPLES: PollyEntry[] = [
  {
    label: 'Zhiyu (Neural)',
    file: `${import.meta.env.BASE_URL}samples/polly-zhiyu.mp3`,
    tag: 'neural',
  },
  {
    label: 'Zhiyu (Standard)',
    file: `${import.meta.env.BASE_URL}samples/polly-zhiyu-standard.mp3`,
    tag: 'standard',
  },
]

export default function VoiceTest() {
  const [zhVoices, setZhVoices] = useState<SpeechSynthesisVoice[]>([])
  const [otherVoices, setOtherVoices] = useState<SpeechSynthesisVoice[]>([])
  const [preferredVoice, setPreferred] = useState<string>(() => getPreferredVoice() ?? '')
  const [showOthers, setShowOthers] = useState(false)
  const [playingPolly, setPlayingPolly] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!isSupported()) return

    function loadVoices() {
      const all = window.speechSynthesis.getVoices()
      setZhVoices(all.filter((v) => v.lang.includes('zh')))
      setOtherVoices(all.filter((v) => !v.lang.includes('zh')))
    }

    loadVoices()

    function cleanup() {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      stopSpeaking()
    }

    // Handle browsers where voices load asynchronously
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.addEventListener('voiceschanged', loadVoices)
      return () => {
        window.speechSynthesis.removeEventListener('voiceschanged', loadVoices)
        cleanup()
      }
    } else {
      // Fallback polling for browsers that don't support onvoiceschanged (e.g. Safari)
      let attempts = 0
      const intervalId = setInterval(() => {
        const voices = window.speechSynthesis.getVoices()
        if (voices.length > 0 || ++attempts > 50) {
          loadVoices()
          clearInterval(intervalId)
        }
      }, 100)
      return () => {
        clearInterval(intervalId)
        cleanup()
      }
    }
  }, [])

  function handlePlay(voiceName: string) {
    stopSpeaking()
    speak(TEST_SENTENCE, voiceName, getPlaybackRate())
  }

  function handleSetPreferred(name: string) {
    setPreferred(name)
    setPreferredVoice(name)
  }

  function handlePollyPlay(entry: PollyEntry) {
    // Stop any existing browser TTS
    stopSpeaking()

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current = null
    }

    if (playingPolly === entry.file) {
      setPlayingPolly(null)
      return
    }

    const audio = new Audio(entry.file)
    audioRef.current = audio
    setPlayingPolly(entry.file)

    audio.onended = () => {
      setPlayingPolly(null)
      if (audioRef.current === audio) audioRef.current = null
    }
    audio.onerror = () => {
      setPlayingPolly(null)
      if (audioRef.current === audio) audioRef.current = null
    }
    audio.play().catch((error) => {
      console.error('Failed to play audio:', error)
      setPlayingPolly(null)
      if (audioRef.current === audio) audioRef.current = null
    })
  }

  return (
    <div className="voice-test">
      <h1>🔊 Voice Test</h1>

      {/* AWS Polly section */}
      <section className="vt-section polly-section">
        <h2>AWS Polly Samples</h2>
        <p className="vt-note polly-note">
          Pre-generated with AWS Polly neural TTS — reference quality for comparison.
          <br />
          Test sentence: <span className="test-sentence">{TEST_SENTENCE}</span>
        </p>
        <table className="voice-table">
          <thead>
            <tr>
              <th>Voice</th>
              <th>Engine</th>
              <th>Play</th>
            </tr>
          </thead>
          <tbody>
            {POLLY_SAMPLES.map((entry) => (
              <tr key={entry.file}>
                <td>{entry.label}</td>
                <td>
                  <span className={`tag tag-${entry.tag}`}>
                    {entry.tag === 'neural' ? '⚡ Neural' : '📻 Standard'}
                  </span>
                </td>
                <td>
                  <button
                    className={`play-btn ${playingPolly === entry.file ? 'playing' : ''}`}
                    onClick={() => handlePollyPlay(entry)}
                  >
                    {playingPolly === entry.file ? '⏹ Stop' : '▶ Play'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Browser TTS section */}
      <section className="vt-section">
        <h2>Browser TTS Voices</h2>
        <p className="vt-note">
          Voice availability varies by browser and OS. On macOS/iOS, zh-CN voices are usually
          available. On Windows, you may need to install language packs.
          <br />
          Test sentence: <span className="test-sentence">{TEST_SENTENCE}</span>
        </p>

        {!isSupported() && (
          <div className="vt-warning">⚠️ Web Speech API is not supported in this browser.</div>
        )}

        {isSupported() && zhVoices.length === 0 && (
          <div className="vt-warning">
            No Chinese (zh) voices found. Try Chrome on macOS or iOS Safari for best results.
          </div>
        )}

        {zhVoices.length > 0 && (
          <>
            <p className="vt-count">
              {zhVoices.length} Chinese voice{zhVoices.length !== 1 ? 's' : ''} found
            </p>
            <table className="voice-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Lang</th>
                  <th>Local?</th>
                  <th>Preferred</th>
                  <th>Play</th>
                </tr>
              </thead>
              <tbody>
                {zhVoices.map((v) => (
                  <tr key={v.name} className={preferredVoice === v.name ? 'preferred-row' : ''}>
                    <td>{v.name}</td>
                    <td>
                      <code>{v.lang}</code>
                    </td>
                    <td>{v.localService ? '✅ Local' : '☁️ Remote'}</td>
                    <td>
                      <button
                        className={`pref-btn ${preferredVoice === v.name ? 'active' : ''}`}
                        onClick={() => handleSetPreferred(v.name)}
                      >
                        {preferredVoice === v.name ? '★ Preferred' : '☆ Set'}
                      </button>
                    </td>
                    <td>
                      <button className="play-btn" onClick={() => handlePlay(v.name)}>
                        ▶ Play
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {otherVoices.length > 0 && (
          <div className="other-voices">
            <button className="toggle-btn" onClick={() => setShowOthers((s) => !s)}>
              {showOthers ? '▾' : '▸'} Other voices ({otherVoices.length})
            </button>
            {showOthers && (
              <table className="voice-table secondary">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Lang</th>
                    <th>Local?</th>
                    <th>Play</th>
                  </tr>
                </thead>
                <tbody>
                  {otherVoices.map((v) => (
                    <tr key={v.name}>
                      <td>{v.name}</td>
                      <td>
                        <code>{v.lang}</code>
                      </td>
                      <td>{v.localService ? '✅' : '☁️'}</td>
                      <td>
                        <button className="play-btn" onClick={() => handlePlay(v.name)}>
                          ▶ Play
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
