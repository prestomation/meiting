import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Nav from './components/Nav'
import Session from './pages/Session'
import VoiceTest from './pages/VoiceTest'
import Stats from './pages/Stats'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Nav />
      <Routes>
        <Route path="/" element={<Session />} />
        <Route path="/voice-test" element={<VoiceTest />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  )
}
