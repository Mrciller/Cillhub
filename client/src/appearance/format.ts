// Date and time formatting that follows the UI language and the 12/24-hour setting.
import { intlLocale } from '../i18n'
import { getState } from '../store'

const hour12 = () => {
  const c = getState().settings.timestamp_hour_cycle
  return c === 'h12' ? true : c === 'h23' ? false : undefined
}
export const timeOpts = (): Intl.DateTimeFormatOptions => ({ hour: '2-digit', minute: '2-digit', hour12: hour12() })
export const clock = (iso: string | number) => new Date(iso).toLocaleTimeString(intlLocale(), timeOpts())
export const dateTime = (iso: string | number) => new Date(iso).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short', hour12: hour12() })
export const shortDate = (iso: string | number) => new Date(iso).toLocaleDateString(intlLocale(), { dateStyle: 'medium' })
