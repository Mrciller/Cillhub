// reCAPTCHA v2 checkbox for sign-up and password reset. Google's script loads only when a form shows the widget;
// remount (change the key) to get a fresh widget after a failed submit.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

type Grecaptcha = { render(el: HTMLElement, opts: Record<string, unknown>): number }
declare global {
  interface Window { grecaptcha?: Grecaptcha; cillhubCaptchaLoaded?: () => void }
}

let loading: Promise<Grecaptcha> | null = null
const load = () => (loading ??= new Promise<Grecaptcha>((resolve, reject) => {
  window.cillhubCaptchaLoaded = () => resolve(window.grecaptcha!)
  const s = document.createElement('script')
  s.src = 'https://www.google.com/recaptcha/api.js?onload=cillhubCaptchaLoaded&render=explicit'
  s.async = true
  s.onerror = () => ((loading = null), s.remove(), reject(new Error('captcha')))
  document.head.append(s)
}))

export function Captcha({ sitekey, onToken }: { sitekey: string; onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    load().then((g) => {
      if (!live || !box.current) return
      g.render(box.current, {
        sitekey, theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken(''),
      })
    }, () => live && setFailed(true))
    return () => void (live = false)
  }, [sitekey]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="field">
      <div ref={box} />
      {failed && <p className="form-error" role="alert">{t('The captcha could not be loaded. Check your connection and reload the page.')}</p>}
    </div>
  )
}
