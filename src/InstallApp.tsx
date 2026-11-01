import { useEffect, useState } from 'react'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function InstallAppButton({ className = 'text-button' }: { className?: string }) {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => isStandalone())
  const [showIosHelp, setShowIosHelp] = useState(false)

  useEffect(() => {
    function onBeforeInstall(event: Event) {
      event.preventDefault()
      setPromptEvent(event as InstallPromptEvent)
    }
    function onInstalled() {
      setInstalled(true)
      setPromptEvent(null)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed) return null
  const ios = isIos()
  if (!promptEvent && !ios) return null

  async function install() {
    if (promptEvent) {
      await promptEvent.prompt()
      await promptEvent.userChoice
      setPromptEvent(null)
    } else {
      setShowIosHelp((open) => !open)
    }
  }

  return <div className="install-app">
    <button className={className} type="button" onClick={() => void install()}>Installer appen</button>
    {showIosHelp && <p className="install-app-help" role="note">Trykk på Del-knappen i Safari og velg «Legg til på Hjem-skjermen».</p>}
  </div>
}
