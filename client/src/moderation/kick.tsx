import { kick } from '../actions'
import { t } from '../i18n'
import { askText, toastError } from '../components/dialogs'

/** Kick dialog with an optional reason (X-Audit-Log-Reason); replaces confirm(). */
export const confirmKick = (guildId: string, guildName: string, userId: string, name: string) =>
  void askText({
    title: t('Kick {name}', { name }), label: t('Reason for Kick'), multiline: true, allowEmpty: true, confirm: t('Kick'), danger: true, maxLength: 512,
    body: <p>{t('Are you sure you want to kick {name} from {server}? They will be able to rejoin with a new invite.', { name, server: guildName })}</p>,
  }).then((reason) => void (reason !== null && kick(guildId, userId, reason.trim() || undefined).catch(toastError)))
