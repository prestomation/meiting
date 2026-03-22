import { NavLink } from 'react-router-dom'
import './Nav.css'

export default function Nav() {
  return (
    <nav className="nav">
      <span className="nav-brand">美听 MěiTīng</span>
      <div className="nav-links">
        <NavLink to="/" end>
          Session
        </NavLink>
        <NavLink to="/voice-test">Voice Test</NavLink>
        <NavLink to="/stats">Stats</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </div>
    </nav>
  )
}
